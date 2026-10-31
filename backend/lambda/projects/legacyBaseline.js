const crypto = require("crypto");
const { GetCommand, ScanCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { requireSuperAdmin } = require("./portalAdminAuth");
const { normalizeEmail } = require("./projectAccess");
const { isComplete } = require("./escalation");
const { parseRequiredHours } = require("./taskTime");
const {
  REASON,
  resolveCurrentHourlyRates,
  isValidPositiveRate,
} = require("./costRates");
const {
  STATUS_COSTED,
  STATUS_MISSING_RATE,
  classifyProjectType,
  calculateAmountUsd,
  reportingDateIst,
  costSk,
  employeeCostSk,
} = require("./taskCosting");

const LEGACY_REASON = "LEGACY_CURRENT_RATE";
const LEGACY_NOTE =
  "Current-rate baseline. Not a historically verified rate.";
const SCAN_PAGE_ITEMS = 100;
const DEFAULT_CANDIDATE_LIMIT = 25;
const MAX_CANDIDATE_LIMIT = 50;
const MAX_SCAN_ROUNDS = 20;
const PAGINATION_NOTE =
  "Counts are for this page. Continue only with nextCursor. Repeating a cursor reads the same following page while those rows are unchanged. A row inserted behind the cursor is not revisited; start a new preview to include it. Apply rechecks every candidate and writes nothing if the assignment, rate, or version changed.";

function hoursClose(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.001;
}

function record(category, reason, fields) {
  return {
    category,
    reason,
    legacyBaseline: category === "eligible",
    note: category === "eligible" ? LEGACY_NOTE : null,
    ...fields,
  };
}

function isCompletedAssignment(item) {
  return (
    item &&
    item.type === "ASSIGNMENT" &&
    String(item.SK || "").startsWith("ASSIGNMENT#") &&
    isComplete(item.status)
  );
}

function isSubmissionFrozen(item) {
  if (!item) return false;
  if (item.basisState === "FINAL" || item.basisState === "ACTIVE" || item.basisState === "RETURNED") {
    return true;
  }
  if (item.status === "SUBMISSION_BASIS") return true;
  if (item.finalizedSubmissionId) return true;
  if (item.submissionId && item.legacyBaseline !== true) return true;
  return false;
}

function plainMissingRate(item) {
  return (
    item &&
    item.status === STATUS_MISSING_RATE &&
    !item.basisState &&
    !item.submissionId &&
    !item.finalizedSubmissionId
  );
}

async function getItem(ddb, tableName, key) {
  const res = await ddb.send(new GetCommand({ TableName: tableName, Key: key }));
  return res.Item || null;
}

function legacyPutCondition(existing) {
  if (!existing) return { ConditionExpression: "attribute_not_exists(PK)" };
  return {
    ConditionExpression:
      "#status = :missing AND attribute_not_exists(#basis) AND attribute_not_exists(#submissionId)",
    ExpressionAttributeNames: {
      "#status": "status",
      "#basis": "basisState",
      "#submissionId": "submissionId",
    },
    ExpressionAttributeValues: { ":missing": STATUS_MISSING_RATE },
  };
}

function canonicalCandidate(row) {
  return JSON.stringify({
    taskId: row.taskId || null,
    email: row.email || null,
    actualHours: row.actualHours == null ? null : row.actualHours,
    hourlyRateUsd: row.hourlyRateUsd == null ? null : row.hourlyRateUsd,
    rateVersionId: row.rateVersionId || null,
    rateSource: row.rateSource || null,
    amountUsd: row.amountUsd == null ? null : row.amountUsd,
    projectType: row.projectType || null,
    assignedAt: row.assignedAt || null,
    completedAt: row.completedAt || null,
    category: row.category || null,
    reason: row.reason || null,
  });
}

function previewDigest(rows) {
  const lines = (rows || []).map(canonicalCandidate).sort();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

async function classifyLegacyCandidate({
  ddb,
  tableName,
  assignment,
  task,
  project,
  taskCost,
  employeeCost,
  nowIso,
}) {
  const email = normalizeEmail(assignment.email);
  const base = {
    taskId: assignment.taskId || task?.taskId || null,
    email,
    assignedAt: assignment.assignedAt || null,
    completedAt: assignment.completedAt || null,
    actualHours: assignment.actualHours == null ? null : assignment.actualHours,
    projectId: task?.projectId || null,
    projectType: classifyProjectType(project),
  };
  if (assignment.removed) return record("skipped", "REMOVED_ASSIGNMENT", base);
  if (!email || !base.taskId) return record("unresolved", "MISSING_IDENTITY", base);
  if (assignment.supersededByTaskId) {
    return record("unresolved", "SUPERSEDED_ASSIGNMENT", base);
  }
  const taskPresent = Boolean(taskCost);
  const employeePresent = Boolean(employeeCost);
  if (taskPresent !== employeePresent) {
    return record("unresolved", "INCONSISTENT_COST_RECORDS", base);
  }
  if (taskCost?.status === STATUS_COSTED || employeeCost?.status === STATUS_COSTED) {
    if (taskCost?.status === STATUS_COSTED && employeeCost?.status === STATUS_COSTED) {
      return record(
        "skipped",
        taskCost.legacyBaseline ? "ALREADY_BASELINED" : "COSTED_FROZEN",
        {
          ...base,
          hourlyRateUsd: taskCost.hourlyRateUsd ?? null,
          amountUsd: taskCost.amountUsd ?? null,
          legacyBaseline: taskCost.legacyBaseline === true,
          note: taskCost.legacyBaseline ? LEGACY_NOTE : null,
        }
      );
    }
    return record("unresolved", "INCONSISTENT_COST_RECORDS", base);
  }
  const taskFrozen = isSubmissionFrozen(taskCost);
  const employeeFrozen = isSubmissionFrozen(employeeCost);
  if (taskFrozen || employeeFrozen) {
    if (taskFrozen && employeeFrozen) {
      return record("skipped", "FINALIZED_SUBMISSION", {
        ...base,
        legacyBaseline: false,
        note: null,
      });
    }
    return record("unresolved", "INCONSISTENT_COST_RECORDS", base);
  }
  if (taskCost && !plainMissingRate(taskCost)) {
    return record("unresolved", "UNFINALIZED_OR_UNKNOWN_SNAPSHOT", base);
  }
  if (employeeCost && !plainMissingRate(employeeCost)) {
    return record("unresolved", "UNFINALIZED_OR_UNKNOWN_SNAPSHOT", base);
  }
  if (taskCost && employeeCost && !hoursClose(taskCost.actualHours, employeeCost.actualHours)) {
    return record("unresolved", "HOURS_AMBIGUOUS", base);
  }
  const hours = parseRequiredHours(assignment.actualHours);
  if (!hours.ok) return record("unresolved", "MISSING_HOURS", base);
  const snapshotHours = taskCost?.actualHours ?? employeeCost?.actualHours;
  if (snapshotHours != null && !hoursClose(snapshotHours, hours.value)) {
    return record("unresolved", "HOURS_AMBIGUOUS", base);
  }
  if (!project) {
    return record("unresolved", "PROJECT_MISSING", { ...base, actualHours: hours.value });
  }
  const projectType = classifyProjectType(project);
  if (!projectType) {
    return record("unresolved", REASON.UNCLASSIFIED_PROJECT, {
      ...base,
      actualHours: hours.value,
    });
  }
  const resolved = await resolveCurrentHourlyRates({
    ddb,
    tableName,
    email,
    projectType,
    atIso: nowIso,
  });
  const rate = resolved?.project?.rate;
  if (!resolved?.project?.applies || !isValidPositiveRate(rate)) {
    return record("unresolved", resolved?.project?.reason || REASON.RATE_UNSET, {
      ...base,
      actualHours: hours.value,
      projectType,
    });
  }
  return record("eligible", LEGACY_REASON, {
    ...base,
    actualHours: hours.value,
    projectType,
    hourlyRateUsd: rate,
    amountUsd: calculateAmountUsd(hours.value, rate),
    rateSource: resolved.project.source,
    rateVersionId: resolved.rateVersionId || null,
    designationId: resolved.designationId || null,
    completedDate:
      taskCost?.completedDate ||
      (assignment.completedAt ? reportingDateIst(assignment.completedAt) : null),
  });
}

async function loadCandidateContext(ddb, tableName, assignment) {
  const taskId = assignment.taskId || String(assignment.PK || "").slice("TASK#".length);
  const email = normalizeEmail(assignment.email);
  const task = await getItem(ddb, tableName, {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
  });
  const project = task?.projectId
    ? await getItem(ddb, tableName, {
        PK: "ENTITY#PROJECT",
        SK: `PROJECT#${task.projectId}`,
      })
    : null;
  const taskCost = email
    ? await getItem(ddb, tableName, { PK: `TASK#${taskId}`, SK: costSk(email) })
    : null;
  const employeeCost = email
    ? await getItem(ddb, tableName, {
        PK: `USER#${email}`,
        SK: employeeCostSk(taskId),
      })
    : null;
  return { taskId, task, project, taskCost, employeeCost };
}

function legacyItems(row, nowIso) {
  const base = {
    type: "ASSIGNMENT_COST",
    status: STATUS_COSTED,
    basisState: "FINAL",
    reason: LEGACY_REASON,
    legacyBaseline: true,
    legacyNote: LEGACY_NOTE,
    legacyRatedAt: nowIso,
    submissionId: `legacy:${row.taskId}:${row.email}`,
    submittedAt: null,
    taskId: row.taskId,
    projectId: row.projectId,
    email: row.email,
    projectType: row.projectType,
    assignmentSk: `ASSIGNMENT#${row.email}`,
    assignedAt: row.assignedAt,
    actualHours: row.actualHours,
    hourlyRateUsd: row.hourlyRateUsd,
    currency: "USD",
    rateSource: row.rateSource,
    rateVersionId: row.rateVersionId,
    designationId: row.designationId || null,
    amountUsd: row.amountUsd,
    completedAt: row.completedAt,
    completedDate: row.completedDate || null,
    approvedBy: null,
    finalizedAt: nowIso,
    sourceTaskId: null,
    createdAt: nowIso,
  };
  return {
    taskItem: { PK: `TASK#${row.taskId}`, SK: costSk(row.email), ...base },
    employeeItem: {
      PK: `USER#${row.email}`,
      SK: employeeCostSk(row.taskId),
      ...base,
    },
  };
}

function parsePreviewLimit(raw) {
  if (raw == null || raw === "") return DEFAULT_CANDIDATE_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_CANDIDATE_LIMIT) return null;
  return value;
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw) {
  if (raw == null || raw === "") return { ok: true, cursor: { afterKey: null } };
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    if (Object.prototype.hasOwnProperty.call(parsed, "offset") ||
      Object.prototype.hasOwnProperty.call(parsed, "startKey")) {
      return { ok: false };
    }
    if (parsed.afterKey == null) return { ok: true, cursor: { afterKey: null } };
    const key = parsed.afterKey;
    if (!key || typeof key.PK !== "string" || typeof key.SK !== "string" || !key.PK || !key.SK) {
      return { ok: false };
    }
    return { ok: true, cursor: { afterKey: { PK: key.PK, SK: key.SK } } };
  } catch {
    return { ok: false };
  }
}

async function previewLegacyPage({
  ddb,
  tableName,
  nowIso,
  limit = DEFAULT_CANDIDATE_LIMIT,
  cursor = { afterKey: null },
}) {
  const collected = [];
  let resumeKey = cursor && cursor.afterKey ? cursor.afterKey : null;
  let scannedItemCount = 0;
  let scanRounds = 0;
  let more = false;
  while (collected.length < limit && scanRounds < MAX_SCAN_ROUNDS) {
    scanRounds += 1;
    const scan = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        Limit: SCAN_PAGE_ITEMS,
        ...(resumeKey ? { ExclusiveStartKey: resumeKey } : {}),
      })
    );
    const items = scan.Items || [];
    scannedItemCount += items.length;
    let filled = false;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      resumeKey = { PK: item.PK, SK: item.SK };
      if (!isCompletedAssignment(item)) continue;
      const loaded = await loadCandidateContext(ddb, tableName, item);
      collected.push(
        await classifyLegacyCandidate({
          ddb,
          tableName,
          assignment: { ...item, taskId: loaded.taskId },
          task: loaded.task,
          project: loaded.project,
          taskCost: loaded.taskCost,
          employeeCost: loaded.employeeCost,
          nowIso,
        })
      );
      if (collected.length >= limit) {
        more = index < items.length - 1 || Boolean(scan.LastEvaluatedKey);
        filled = true;
        break;
      }
    }
    if (filled) break;
    if (!scan.LastEvaluatedKey) {
      more = false;
      resumeKey = null;
      break;
    }
    resumeKey = scan.LastEvaluatedKey;
    more = true;
  }
  if (collected.length < limit && scanRounds >= MAX_SCAN_ROUNDS && resumeKey) more = true;
  const count = (category) => collected.filter((row) => row.category === category).length;
  const eligible = collected.filter((row) => row.category === "eligible");
  const next = more && resumeKey ? { afterKey: resumeKey } : null;
  return {
    nowIso,
    label: LEGACY_NOTE,
    countsScope: "page",
    pagination: {
      resume: "exclusive-start",
      countsScope: "page",
      note: PAGINATION_NOTE,
    },
    scannedItemCount,
    scanRounds,
    counts: {
      eligible: count("eligible"),
      skipped: count("skipped"),
      unresolved: count("unresolved"),
    },
    eligible,
    skipped: collected.filter((row) => row.category === "skipped"),
    unresolved: collected.filter((row) => row.category === "unresolved"),
    previewDigest: previewDigest(eligible),
    nextCursor: next ? encodeCursor(next) : null,
    truncated: Boolean(next),
  };
}

async function applyLegacyBaseline({
  ddb,
  tableName,
  nowIso,
  candidates,
  previewDigest: expectedDigest,
}) {
  if (!Array.isArray(candidates) || !candidates.length || !expectedDigest) {
    return {
      blocked: true,
      code: "PREVIEW_REQUIRED",
      label: LEGACY_NOTE,
      applied: [],
      mismatches: [],
    };
  }
  const fresh = [];
  for (const candidate of candidates) {
    const assignment = await getItem(ddb, tableName, {
      PK: `TASK#${candidate.taskId}`,
      SK: `ASSIGNMENT#${normalizeEmail(candidate.email)}`,
    });
    if (!assignment || !isCompletedAssignment(assignment)) {
      fresh.push(record("unresolved", "ASSIGNMENT_MISSING", {
        taskId: candidate.taskId,
        email: normalizeEmail(candidate.email),
      }));
      continue;
    }
    const loaded = await loadCandidateContext(ddb, tableName, assignment);
    fresh.push(
      await classifyLegacyCandidate({
        ddb,
        tableName,
        assignment: { ...assignment, taskId: loaded.taskId },
        task: loaded.task,
        project: loaded.project,
        taskCost: loaded.taskCost,
        employeeCost: loaded.employeeCost,
        nowIso,
      })
    );
  }
  const eligible = fresh.filter((row) => row.category === "eligible");
  const digest = previewDigest(eligible);
  const mismatches = [];
  if (candidates.length !== eligible.length || digest !== expectedDigest) {
    mismatches.push({ reason: "PREVIEW_STALE" });
  }
  candidates.forEach((candidate, index) => {
    const current = fresh[index];
    if (!current || canonicalCandidate(current) !== canonicalCandidate({
      ...candidate,
      category: "eligible",
      reason: LEGACY_REASON,
    })) {
      mismatches.push({
        taskId: candidate.taskId,
        email: candidate.email,
        reason: "CANDIDATE_CHANGED",
      });
    }
  });
  if (mismatches.length) {
    return {
      blocked: true,
      code: "REPREVIEW_REQUIRED",
      label: LEGACY_NOTE,
      applied: [],
      mismatches,
    };
  }
  const writes = [];
  for (const row of eligible) {
    const existingTask = await getItem(ddb, tableName, {
      PK: `TASK#${row.taskId}`,
      SK: costSk(row.email),
    });
    const existingEmployee = await getItem(ddb, tableName, {
      PK: `USER#${row.email}`,
      SK: employeeCostSk(row.taskId),
    });
    if (
      (existingTask && !plainMissingRate(existingTask)) ||
      (existingEmployee && !plainMissingRate(existingEmployee)) ||
      Boolean(existingTask) !== Boolean(existingEmployee)
    ) {
      return {
        blocked: true,
        code: "REPREVIEW_REQUIRED",
        label: LEGACY_NOTE,
        applied: [],
        mismatches: [{ taskId: row.taskId, email: row.email, reason: "CANDIDATE_CHANGED" }],
      };
    }
    writes.push({ row, existingTask, existingEmployee });
  }
  if (writes.length * 2 > 100) {
    return {
      blocked: true,
      code: "PREVIEW_PAGE_TOO_LARGE",
      label: LEGACY_NOTE,
      applied: [],
      mismatches: [],
    };
  }
  const applied = writes.map((entry) => ({ ...entry.row, category: "applied" }));
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: writes.flatMap((entry) => {
        const items = legacyItems(entry.row, nowIso);
        return [
          {
            Put: {
              TableName: tableName,
              Item: items.taskItem,
              ...legacyPutCondition(entry.existingTask),
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: items.employeeItem,
              ...legacyPutCondition(entry.existingEmployee),
            },
          },
        ];
      }),
    })
  );
  return {
    blocked: false,
    label: LEGACY_NOTE,
    applied,
    mismatches: [],
    counts: { applied: applied.length },
  };
}

function legacyPreviewPathMatch(path) {
  return /\/admin\/costing\/legacy-preview$/.test(String(path || ""));
}

async function handlePreviewLegacyBaseline({
  user,
  ddb,
  tableName,
  accessTable,
  nowIso = new Date().toISOString(),
  limit,
  cursor,
}) {
  const auth = await requireSuperAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const pageLimit = parsePreviewLimit(limit);
  if (pageLimit == null) {
    return { statusCode: 400, body: { error: "Invalid limit." } };
  }
  const decoded = decodeCursor(cursor);
  if (!decoded.ok) return { statusCode: 400, body: { error: "Invalid cursor." } };
  const preview = await previewLegacyPage({
    ddb,
    tableName,
    nowIso,
    limit: pageLimit,
    cursor: decoded.cursor,
  });
  return { statusCode: 200, body: preview };
}

module.exports = {
  LEGACY_REASON,
  LEGACY_NOTE,
  classifyLegacyCandidate,
  previewLegacyPage,
  previewLegacyBaseline: previewLegacyPage,
  applyLegacyBaseline,
  legacyPutCondition,
  decodeCursor,
  previewDigest,
  canonicalCandidate,
  legacyPreviewPathMatch,
  handlePreviewLegacyBaseline,
  parsePreviewLimit,
};

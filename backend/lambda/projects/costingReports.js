const { GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { requireEligiblePortalAdmin } = require("./portalAdminAuth");
const { normalizeEmail } = require("./projectAccess");
const escalation = require("./escalation");
const {
  STATUS_COSTED,
  STATUS_MISSING_RATE,
  roundUsd,
  reportingDateIst,
  classifyProjectType,
  diagnoseCostIndexes,
} = require("./taskCosting");

const STATUS_MISSING_COST_RECORD = "MISSING_COST_RECORD";
const STATUS_PENDING_REVIEW = "PENDING_REVIEW";
const STATUS_OPEN = "OPEN";
const STATUS_SUPERSEDED = "SUPERSEDED";
const STATUS_UNPRICED_LEGACY = "UNPRICED_LEGACY";
const MAX_TASKS = 400;
const MAX_QUERY_PAGES = 40;
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let maxTasksCap = MAX_TASKS;
let maxQueryPagesCap = MAX_QUERY_PAGES;

function setCostingCapsForTest(next = {}) {
  if (next.reset) {
    maxTasksCap = MAX_TASKS;
    maxQueryPagesCap = MAX_QUERY_PAGES;
    return;
  }
  if (next.maxTasks != null) maxTasksCap = next.maxTasks;
  if (next.maxQueryPages != null) maxQueryPagesCap = next.maxQueryPages;
}

function normalizePath(path) {
  return String(path || "").replace(/\/+$/, "");
}

function decodePathSegment(raw) {
  try {
    return { ok: true, value: decodeURIComponent(String(raw)) };
  } catch {
    return { ok: false, malformed: true };
  }
}

function costingProjectPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  const fromParams = String(pathParameters?.projectId || "").trim();
  if (fromParams && /\/admin\/costing\/projects\/[^/]+$/.test(normalized)) {
    return { projectId: fromParams };
  }
  const match = normalized.match(/\/admin\/costing\/projects\/([^/]+)$/);
  if (!match) return null;
  const decoded = decodePathSegment(match[1]);
  if (!decoded.ok) return { malformed: true };
  const projectId = String(decoded.value || "").trim();
  return projectId ? { projectId } : null;
}

function costingEmployeePathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  const fromParams = pathParameters?.email;
  if (
    fromParams != null &&
    /\/admin\/costing\/employees\/[^/]+$/.test(normalized)
  ) {
    const decoded = decodePathSegment(fromParams);
    if (!decoded.ok) return { malformed: true };
    const email = normalizeEmail(decoded.value);
    return email ? { email } : null;
  }
  const match = normalized.match(/\/admin\/costing\/employees\/([^/]+)$/);
  if (!match) return null;
  const decoded = decodePathSegment(match[1]);
  if (!decoded.ok) return { malformed: true };
  const email = normalizeEmail(decoded.value);
  return email ? { email } : null;
}

function isPendingScheduledTask(task) {
  const mode = String(task?.assignmentMode || "").toUpperCase();
  const state = String(task?.assignmentState || "").toUpperCase();
  return (
    mode === "SCHEDULED" &&
    (state === "PENDING" || state === "ASSIGNING" || state === "SKIPPED")
  );
}

async function queryAll(ddb, params) {
  const items = [];
  let lastKey;
  let pages = 0;
  do {
    const res = await ddb.send(
      new QueryCommand({
        ...params,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
    pages += 1;
  } while (lastKey && pages < maxQueryPagesCap);
  return { items, truncated: Boolean(lastKey) };
}

function parseLimit(raw) {
  if (raw == null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, MAX_LIMIT);
}

function cursorStringField(raw, { required = false } = {}) {
  if (raw == null || raw === "") return required ? null : "";
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (required && !value) return null;
  return value;
}

function parseCursor(raw) {
  if (raw == null || raw === "") return { ok: true, after: null };
  try {
    const parsed = JSON.parse(
      Buffer.from(String(raw), "base64").toString("utf8")
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false };
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "o")) {
      return { ok: false };
    }
    const taskId = cursorStringField(parsed.t, { required: true });
    const email = normalizeEmail(cursorStringField(parsed.e, { required: true }));
    const completedDate = cursorStringField(parsed.d);
    const assignedAt = cursorStringField(parsed.a);
    if (!taskId || !email || completedDate == null || assignedAt == null) {
      return { ok: false };
    }
    return {
      ok: true,
      after: {
        completedDate,
        assignedAt,
        taskId,
        email,
      },
    };
  } catch {
    return { ok: false };
  }
}

function encodeCursor(row) {
  return Buffer.from(
    JSON.stringify({
      d: row.completedDate || "",
      a: row.assignedAt || "",
      t: row.taskId,
      e: row.email,
    }),
    "utf8"
  ).toString("base64");
}

function parseDateKey(raw) {
  if (raw == null || raw === "") return { ok: true, value: null };
  const value = String(raw).trim();
  if (!DATE_RE.test(value)) return { ok: false };
  return { ok: true, value };
}

function hoursValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function emptySummary() {
  return {
    taskCount: 0,
    completedTaskCount: 0,
    completedActualHours: 0,
    confirmedCostUsd: 0,
    pendingReviewHours: 0,
    missingRateCount: 0,
    missingCostRecordCount: 0,
    unpricedLegacyCount: 0,
    unpricedLegacyHours: 0,
    currency: "USD",
  };
}

function addHours(sum, value) {
  return roundUsd(Number(sum || 0) + hoursValue(value));
}

function costSk(email) {
  return `COST#${normalizeEmail(email)}`;
}

function recordedActualHours(assignment) {
  if (assignment?.actualHours == null || assignment.actualHours === "") return null;
  const hours = Number(assignment.actualHours);
  return Number.isFinite(hours) ? hours : null;
}

function unfinishedAssignmentStatus(assignment) {
  if (assignment?.supersededByTaskId && !escalation.isComplete(assignment.status)) {
    return { costStatus: STATUS_SUPERSEDED, includeInTotals: false };
  }
  if (escalation.isReview(assignment.status)) {
    return { costStatus: STATUS_PENDING_REVIEW, includeInTotals: true };
  }
  if (!escalation.isComplete(assignment.status)) {
    return { costStatus: STATUS_OPEN, includeInTotals: true };
  }
  return null;
}

function classifyAssignment(assignment, snapshot) {
  if (
    snapshot?.status === STATUS_COSTED &&
    snapshot.amountUsd != null &&
    snapshot.basisState !== "RETURNED"
  ) {
    return { costStatus: STATUS_COSTED, includeInTotals: true };
  }
  if (snapshot?.basisState === "RETURNED" || snapshot?.status === "SUBMISSION_BASIS") {
    return (
      unfinishedAssignmentStatus(assignment) || {
        costStatus: STATUS_MISSING_COST_RECORD,
        includeInTotals: true,
      }
    );
  }
  if (snapshot?.status === STATUS_MISSING_RATE) {
    return { costStatus: STATUS_MISSING_RATE, includeInTotals: true };
  }
  if (!snapshot && recordedActualHours(assignment) != null) {
    return { costStatus: STATUS_UNPRICED_LEGACY, includeInTotals: false };
  }
  return (
    unfinishedAssignmentStatus(assignment) || {
      costStatus: STATUS_MISSING_COST_RECORD,
      includeInTotals: true,
    }
  );
}

function buildRow({
  task,
  assignment,
  snapshot,
  project,
  employeeName,
}) {
  const email = normalizeEmail(assignment.email);
  const classified = classifyAssignment(assignment, snapshot);
  const completedAt = assignment.completedAt || snapshot?.completedAt || null;
  const completedDate =
    snapshot?.completedDate ||
    (completedAt ? reportingDateIst(completedAt) : null);
  const costed = classified.costStatus === STATUS_COSTED;
  const unpricedLegacy = classified.costStatus === STATUS_UNPRICED_LEGACY;
  return {
    taskId: task.taskId,
    projectId: task.projectId || project?.projectId || null,
    projectName: project?.name || task.projectName || "",
    projectCode: project?.projectCode || null,
    projectType: classifyProjectType(project) || project?.projectType || null,
    title: task.title || "",
    email,
    employeeName: employeeName || "",
    assignmentSk: `ASSIGNMENT#${email}`,
    assignedAt: assignment.assignedAt || task.createdAt || null,
    submittedAt: unpricedLegacy
      ? assignment.submittedAt || null
      : assignment.submittedAt || assignment.reviewSubmittedAt || null,
    attemptId: assignment.attemptId || null,
    completedAt,
    completedDate,
    assignmentStatus: assignment.status || "TODO",
    costStatus: classified.costStatus,
    reason: unpricedLegacy
      ? STATUS_UNPRICED_LEGACY
      : snapshot?.basisState === "RETURNED"
        ? "SUBMISSION_RETURNED"
        : snapshot?.status === "SUBMISSION_BASIS"
          ? "SUBMISSION_NOT_FINALIZED"
          : snapshot?.reason ||
            (classified.costStatus === STATUS_MISSING_COST_RECORD
              ? STATUS_MISSING_COST_RECORD
              : null),
    basisState: snapshot?.basisState || null,
    submissionId: snapshot?.submissionId || null,
    legacyBaseline: snapshot?.legacyBaseline === true,
    estimatedHours: task.estimatedHours == null ? null : task.estimatedHours,
    plannedHours: assignment.plannedHours == null ? null : assignment.plannedHours,
    actualHours: assignment.actualHours == null ? null : assignment.actualHours,
    hourlyRateUsd: unpricedLegacy
      ? null
      : costed
        ? snapshot.hourlyRateUsd
        : snapshot?.hourlyRateUsd ?? null,
    rateSource: unpricedLegacy
      ? null
      : costed
        ? snapshot.rateSource
        : snapshot?.rateSource || null,
    rateVersionId: unpricedLegacy
      ? null
      : costed
        ? snapshot.rateVersionId
        : snapshot?.rateVersionId || null,
    amountUsd: costed ? snapshot.amountUsd : null,
    currency: "USD",
    sourceTaskId: task.sourceTaskId || snapshot?.sourceTaskId || null,
    supersededByTaskId: assignment.supersededByTaskId || null,
    includeInTotals: classified.includeInTotals,
  };
}

function rowSortKey(row) {
  return [
    String(row.completedDate || ""),
    String(row.assignedAt || ""),
    String(row.taskId || ""),
    String(row.email || ""),
  ].join("\0");
}

function compareRowsDesc(a, b) {
  const ka = rowSortKey(a);
  const kb = rowSortKey(b);
  if (ka > kb) return -1;
  if (ka < kb) return 1;
  return 0;
}

function sortCostingRows(rows) {
  return [...rows].sort(compareRowsDesc);
}

function inCompletedDateRange(row, from, to) {
  if (!from && !to) return true;
  if (
    row.costStatus !== STATUS_COSTED &&
    row.costStatus !== STATUS_MISSING_RATE &&
    row.costStatus !== STATUS_MISSING_COST_RECORD &&
    row.costStatus !== STATUS_UNPRICED_LEGACY
  ) {
    return true;
  }
  const date = row.completedDate;
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function summarizeRows(rows) {
  const summary = emptySummary();
  const taskIds = new Set();
  const completedIds = new Set();
  for (const row of rows) {
    if (
      row.includeInTotals ||
      row.costStatus === STATUS_SUPERSEDED ||
      row.costStatus === STATUS_UNPRICED_LEGACY
    ) {
      taskIds.add(row.taskId);
    }
    if (
      row.costStatus === STATUS_COSTED ||
      row.costStatus === STATUS_MISSING_RATE ||
      row.costStatus === STATUS_MISSING_COST_RECORD ||
      (row.costStatus === STATUS_UNPRICED_LEGACY &&
        escalation.isComplete(row.assignmentStatus))
    ) {
      completedIds.add(row.taskId);
    }
  }
  summary.taskCount = taskIds.size;
  summary.completedTaskCount = completedIds.size;
  for (const row of rows) {
    if (row.costStatus === STATUS_UNPRICED_LEGACY) {
      summary.unpricedLegacyCount += 1;
      summary.unpricedLegacyHours = addHours(
        summary.unpricedLegacyHours,
        row.actualHours
      );
      continue;
    }
    if (!row.includeInTotals) continue;
    if (row.costStatus === STATUS_PENDING_REVIEW) {
      summary.pendingReviewHours = addHours(
        summary.pendingReviewHours,
        row.actualHours
      );
      continue;
    }
    if (row.costStatus === STATUS_OPEN) continue;
    summary.completedActualHours = addHours(
      summary.completedActualHours,
      row.actualHours
    );
    if (row.costStatus === STATUS_COSTED) {
      summary.confirmedCostUsd = roundUsd(
        Number(summary.confirmedCostUsd) + Number(row.amountUsd || 0)
      );
    } else if (row.costStatus === STATUS_MISSING_RATE) {
      summary.missingRateCount += 1;
    } else if (row.costStatus === STATUS_MISSING_COST_RECORD) {
      summary.missingCostRecordCount += 1;
    }
  }
  return summary;
}

function projectBreakdown(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (row.costStatus === STATUS_UNPRICED_LEGACY) {
      const id = row.projectId || "unknown";
      if (!byId.has(id)) {
        byId.set(id, {
          projectId: row.projectId,
          name: row.projectName || "",
          projectType: row.projectType,
          completedActualHours: 0,
          confirmedCostUsd: 0,
          missingRateCount: 0,
          missingCostRecordCount: 0,
          unpricedLegacyCount: 0,
          unpricedLegacyHours: 0,
        });
      }
      const legacyBucket = byId.get(id);
      legacyBucket.unpricedLegacyCount += 1;
      legacyBucket.unpricedLegacyHours = addHours(
        legacyBucket.unpricedLegacyHours,
        row.actualHours
      );
      continue;
    }
    if (!row.includeInTotals) continue;
    if (row.costStatus === STATUS_PENDING_REVIEW || row.costStatus === STATUS_OPEN) {
      continue;
    }
    const id = row.projectId || "unknown";
    if (!byId.has(id)) {
      byId.set(id, {
        projectId: row.projectId,
        name: row.projectName || "",
        projectType: row.projectType,
        completedActualHours: 0,
        confirmedCostUsd: 0,
        missingRateCount: 0,
        missingCostRecordCount: 0,
        unpricedLegacyCount: 0,
        unpricedLegacyHours: 0,
      });
    }
    const bucket = byId.get(id);
    bucket.completedActualHours = addHours(
      bucket.completedActualHours,
      row.actualHours
    );
    if (row.costStatus === STATUS_COSTED) {
      bucket.confirmedCostUsd = roundUsd(
        Number(bucket.confirmedCostUsd) + Number(row.amountUsd || 0)
      );
    } else if (row.costStatus === STATUS_MISSING_RATE) {
      bucket.missingRateCount += 1;
    } else if (row.costStatus === STATUS_MISSING_COST_RECORD) {
      bucket.missingCostRecordCount += 1;
    }
  }
  return [...byId.values()];
}

function isReportRowVisible(row) {
  return (
    row.includeInTotals ||
    row.costStatus === STATUS_SUPERSEDED ||
    row.costStatus === STATUS_UNPRICED_LEGACY
  );
}

function paginateRows(rows, after, limit) {
  const rest = after
    ? rows.filter((row) => rowSortKey(row) < rowSortKey(after))
    : rows;
  const slice = rest.slice(0, limit);
  const last = slice[slice.length - 1];
  const hasMore = slice.length === limit && rest.length > slice.length;
  return {
    assignments: slice,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

async function getProjectItem(ddb, tableName, projectId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: "ENTITY#PROJECT", SK: `PROJECT#${projectId}` },
    })
  );
  return res.Item || null;
}

async function getProfileName(ddb, profileTable, email) {
  const e = normalizeEmail(email);
  if (!e || !profileTable) return "";
  const res = await ddb.send(
    new GetCommand({
      TableName: profileTable,
      Key: { PK: `USER#${e}`, SK: "PROFILE" },
    })
  );
  return res.Item?.name || "";
}

async function loadTaskChildren(ddb, tableName, taskId) {
  const assignments = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `TASK#${taskId}`,
      ":sk": "ASSIGNMENT#",
    },
  });
  const costs = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `TASK#${taskId}`,
      ":sk": "COST#",
    },
  });
  const costByEmail = new Map();
  for (const item of costs.items) {
    costByEmail.set(normalizeEmail(item.email), item);
  }
  return {
    assignments: assignments.items.filter((item) => !item.removed),
    costByEmail,
    truncated: assignments.truncated || costs.truncated,
  };
}

function rowsFromTask(task, children, project, names) {
  return children.assignments.map((assignment) =>
    buildRow({
      task,
      assignment,
      snapshot: children.costByEmail.get(normalizeEmail(assignment.email)),
      project,
      employeeName: names.get(normalizeEmail(assignment.email)) || "",
    })
  );
}

async function loadNames(ddb, profileTable, emails) {
  const names = new Map();
  const unique = [...new Set(emails.filter(Boolean))];
  for (const email of unique) {
    names.set(email, await getProfileName(ddb, profileTable, email));
  }
  return names;
}

async function collectProjectRows({
  ddb,
  tableName,
  profileTable,
  project,
}) {
  const listed = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `PROJECT#${project.projectId}`,
      ":sk": "TASK#",
    },
  });
  const tasks = listed.items
    .filter((task) => !task.archived && !isPendingScheduledTask(task))
    .slice(0, maxTasksCap);
  const truncated =
    listed.truncated || listed.items.length > maxTasksCap;
  const rows = [];
  let childTruncated = false;
  const emails = [];
  for (const task of tasks) {
    const children = await loadTaskChildren(ddb, tableName, task.taskId);
    childTruncated = childTruncated || children.truncated;
    for (const assignment of children.assignments) {
      emails.push(normalizeEmail(assignment.email));
    }
    rows.push(...rowsFromTask(task, children, project, new Map()));
  }
  const names = await loadNames(ddb, profileTable, emails);
  const named = rows.map((row) => ({
    ...row,
    employeeName: names.get(row.email) || row.employeeName || "",
  }));
  return {
    rows: sortCostingRows(named),
    tasks,
    truncated: truncated || childTruncated,
  };
}

async function getTaskItem(ddb, tableName, taskId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: "ENTITY#TASK", SK: `TASK#${taskId}` },
    })
  );
  return res.Item || null;
}

async function getAssignmentItem(ddb, tableName, taskId, email) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: `TASK#${taskId}`, SK: `ASSIGNMENT#${email}` },
    })
  );
  return res.Item || null;
}

function collectEmployeeTaskIds(pointers, costs) {
  const ids = new Set();
  for (const item of pointers) {
    const taskId = String(item.taskId || "").trim();
    if (taskId) ids.add(taskId);
  }
  for (const item of costs) {
    const taskId = String(item.taskId || "").trim();
    if (taskId) ids.add(taskId);
  }
  return [...ids].sort();
}

async function collectEmployeeRows({
  ddb,
  tableName,
  profileTable,
  email,
}) {
  const pointerQuery = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `USER#${email}`,
      ":sk": "ASSIGNMENT#",
    },
  });
  const costQuery = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `USER#${email}`,
      ":sk": "ASSIGNMENT_COST#",
    },
  });
  const costByTaskId = new Map();
  for (const item of costQuery.items) {
    const taskId = String(item.taskId || "").trim();
    if (taskId) costByTaskId.set(taskId, item);
  }
  const taskIds = collectEmployeeTaskIds(pointerQuery.items, costQuery.items);
  const truncatedQuery = pointerQuery.truncated || costQuery.truncated;
  const truncatedCap = taskIds.length > maxTasksCap;
  const selectedIds = taskIds.slice(0, maxTasksCap);
  const rows = [];
  const tasks = [];
  const projectCache = new Map();
  for (const taskId of selectedIds) {
    const task = await getTaskItem(ddb, tableName, taskId);
    if (!task || task.archived || isPendingScheduledTask(task)) continue;
    const assignment = await getAssignmentItem(ddb, tableName, taskId, email);
    if (assignment?.removed) continue;
    const taskCost =
      (
        await ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: `TASK#${taskId}`, SK: costSk(email) },
          })
        )
      ).Item || null;
    const employeeCost = costByTaskId.get(taskId) || null;
    const snapshot = taskCost || employeeCost || null;
    const costIndex = diagnoseCostIndexes(taskCost, employeeCost);
    if (!assignment && !snapshot) continue;
    const rowAssignment = assignment || {
      email,
      status: "DONE",
      assignedAt: snapshot.assignedAt || null,
      actualHours: snapshot.actualHours,
      completedAt: snapshot.completedAt || null,
      completedDate: snapshot.completedDate || null,
    };
    let project = null;
    if (task.projectId) {
      if (!projectCache.has(task.projectId)) {
        projectCache.set(
          task.projectId,
          await getProjectItem(ddb, tableName, task.projectId)
        );
      }
      project = projectCache.get(task.projectId);
    }
    tasks.push(task);
    rows.push(
      ...rowsFromTask(
        task,
        {
          assignments: [rowAssignment],
          costByEmail: new Map([[email, snapshot]]),
        },
        project,
        new Map()
      ).map((row) => ({
        ...row,
        costIndexDiagnosis: costIndex.status,
        costIndexRepair: costIndex.repair,
      }))
    );
  }
  const employeeName = await getProfileName(ddb, profileTable, email);
  const named = rows.map((row) => ({ ...row, employeeName }));
  return {
    rows: sortCostingRows(named),
    tasks,
    truncated: truncatedQuery || truncatedCap,
  };
}

async function handleGetProjectCosting({
  user,
  projectId,
  ddb,
  tableName,
  accessTable,
  profileTable,
  query,
}) {
  const auth = await requireEligiblePortalAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const id = String(projectId || "").trim();
  if (!id) return { statusCode: 400, body: { error: "projectId required" } };
  const project = await getProjectItem(ddb, tableName, id);
  if (!project) return { statusCode: 404, body: { error: "Project not found." } };
  const limit = parseLimit(query?.limit);
  if (limit == null) return { statusCode: 400, body: { error: "Invalid limit." } };
  const cursor = parseCursor(query?.cursor);
  if (!cursor.ok) return { statusCode: 400, body: { error: "Invalid cursor." } };
  const collected = await collectProjectRows({
    ddb,
    tableName,
    profileTable,
    project,
  });
  const visible = collected.rows.filter(isReportRowVisible);
  const summary = summarizeRows(collected.rows);
  const page = paginateRows(visible, cursor.after, limit);
  return {
    statusCode: 200,
    body: {
      project: {
        projectId: project.projectId,
        name: project.name || "",
        projectCode: project.projectCode || null,
        projectType: classifyProjectType(project) || project.projectType || null,
        status: project.status || "ACTIVE",
      },
      summary,
      assignments: page.assignments,
      nextCursor: page.nextCursor,
      truncated: collected.truncated,
    },
  };
}

async function handleGetEmployeeCosting({
  user,
  email,
  ddb,
  tableName,
  accessTable,
  profileTable,
  query,
}) {
  const auth = await requireEligiblePortalAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const target = normalizeEmail(email);
  if (!target) return { statusCode: 400, body: { error: "email required" } };
  const from = parseDateKey(query?.from);
  const to = parseDateKey(query?.to);
  if (!from.ok || !to.ok) {
    return { statusCode: 400, body: { error: "Dates must be YYYY-MM-DD." } };
  }
  if (from.value && to.value && from.value > to.value) {
    return { statusCode: 400, body: { error: "from must be on or before to." } };
  }
  const limit = parseLimit(query?.limit);
  if (limit == null) return { statusCode: 400, body: { error: "Invalid limit." } };
  const cursor = parseCursor(query?.cursor);
  if (!cursor.ok) return { statusCode: 400, body: { error: "Invalid cursor." } };
  const collected = await collectEmployeeRows({
    ddb,
    tableName,
    profileTable,
    email: target,
  });
  const filtered = collected.rows.filter((row) =>
    inCompletedDateRange(row, from.value, to.value)
  );
  const summary = summarizeRows(filtered);
  const page = paginateRows(
    filtered.filter(isReportRowVisible),
    cursor.after,
    limit
  );
  return {
    statusCode: 200,
    body: {
      employee: {
        email: target,
        name: filtered[0]?.employeeName || collected.rows[0]?.employeeName || "",
      },
      range: { from: from.value, to: to.value },
      summary,
      projects: projectBreakdown(filtered),
      assignments: page.assignments,
      nextCursor: page.nextCursor,
      truncated: collected.truncated,
      coverage: {
        indexedOnly: true,
        omitsAssignmentsWithoutPointerOrCostSnapshot: true,
      },
    },
  };
}

module.exports = {
  STATUS_MISSING_COST_RECORD,
  STATUS_PENDING_REVIEW,
  STATUS_OPEN,
  STATUS_SUPERSEDED,
  STATUS_UNPRICED_LEGACY,
  costingProjectPathMatch,
  costingEmployeePathMatch,
  classifyAssignment,
  buildRow,
  summarizeRows,
  projectBreakdown,
  inCompletedDateRange,
  handleGetProjectCosting,
  handleGetEmployeeCosting,
  setCostingCapsForTest,
  collectEmployeeTaskIds,
  parseCursor,
  encodeCursor,
  paginateRows,
  rowSortKey,
  compareRowsDesc,
  sortCostingRows,
};

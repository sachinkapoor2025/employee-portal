const { GetCommand, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const TYPE_USER_ASSIGNMENT = "USER_ASSIGNMENT";
const TYPE_ASSIGNMENT = "ASSIGNMENT";

function userAssignmentPointerItem(assignmentItem) {
  const inspected = inspectCanonicalAssignment(assignmentItem);
  if (!inspected.ok) return null;
  return inspected.pointer;
}

function inspectCanonicalAssignment(item) {
  if (!item || typeof item !== "object") {
    return { ok: false, code: "MALFORMED", reason: "NOT_AN_ITEM" };
  }
  if (item.removed) {
    return { ok: false, code: "SKIPPED_REMOVED", reason: "REMOVED" };
  }
  const pk = String(item.PK || "");
  const sk = String(item.SK || "");
  if (!pk.startsWith("TASK#") || !sk.startsWith("ASSIGNMENT#")) {
    return { ok: false, code: "SKIPPED", reason: "NOT_CANONICAL_ASSIGNMENT" };
  }
  const taskIdFromPk = pk.slice("TASK#".length).trim();
  const emailFromSk = sk.slice("ASSIGNMENT#".length).trim().toLowerCase();
  const taskIdAttr = String(item.taskId || "").trim();
  const emailAttr = String(item.email || "")
    .trim()
    .toLowerCase();
  if (!taskIdFromPk || !emailFromSk) {
    return { ok: false, code: "MALFORMED", reason: "MISSING_KEY_IDENTITY" };
  }
  if (taskIdAttr && taskIdAttr !== taskIdFromPk) {
    return {
      ok: false,
      code: "MALFORMED",
      reason: "TASK_ID_MISMATCH",
      taskIdFromPk,
      taskIdAttr,
    };
  }
  if (emailAttr && emailAttr !== emailFromSk) {
    return {
      ok: false,
      code: "MALFORMED",
      reason: "EMAIL_MISMATCH",
      emailFromSk,
      emailAttr,
    };
  }
  const type = String(item.type || TYPE_ASSIGNMENT);
  if (type && type !== TYPE_ASSIGNMENT) {
    return { ok: false, code: "MALFORMED", reason: "UNEXPECTED_TYPE", type };
  }
  const taskId = taskIdFromPk;
  const email = emailFromSk;
  return {
    ok: true,
    pointer: {
      PK: `USER#${email}`,
      SK: `ASSIGNMENT#${taskId}`,
      type: TYPE_USER_ASSIGNMENT,
      taskId,
      email,
    },
  };
}

function isCompatiblePointer(existing, pointer) {
  if (!existing || !pointer) return false;
  return (
    String(existing.type) === TYPE_USER_ASSIGNMENT &&
    String(existing.taskId) === String(pointer.taskId) &&
    String(existing.email || "")
      .trim()
      .toLowerCase() === String(pointer.email)
  );
}

function classifyExistingPointer(existing, pointer) {
  if (!existing) return "MISSING";
  if (isCompatiblePointer(existing, pointer)) return "EXISTING";
  return "CONFLICT";
}

function pointerPut(tableName, pointer) {
  return {
    Put: {
      TableName: tableName,
      Item: pointer,
      ConditionExpression:
        "attribute_not_exists(PK) OR (#ptrType = :ptrType AND taskId = :taskId AND email = :email)",
      ExpressionAttributeNames: { "#ptrType": "type" },
      ExpressionAttributeValues: {
        ":ptrType": TYPE_USER_ASSIGNMENT,
        ":taskId": pointer.taskId,
        ":email": pointer.email,
      },
    },
  };
}

function backfillPointerPut(tableName, pointer) {
  return {
    Put: {
      TableName: tableName,
      Item: pointer,
      ConditionExpression: "attribute_not_exists(PK)",
    },
  };
}

function evalPointerCondition(existing, pointer, expression) {
  const expr = String(expression || "");
  if (expr.includes(":ptrType")) {
    return !existing || isCompatiblePointer(existing, pointer);
  }
  if (expr.includes("attribute_not_exists(PK)")) {
    return !existing;
  }
  return true;
}

async function queryPages(ddb, params, { maxPages = 40 } = {}) {
  const items = [];
  let lastKey;
  let pages = 0;
  let truncated = false;
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
    if (lastKey && pages >= maxPages) {
      truncated = true;
      break;
    }
  } while (lastKey);
  return { items, lastKey: truncated ? lastKey : undefined, truncated, pages };
}

function emptyBackfillReport() {
  return {
    mode: "dry-run",
    scannedTasks: 0,
    scannedAssignments: 0,
    candidates: [],
    existing: [],
    skipped: [],
    malformed: [],
    conflicts: [],
    written: [],
    writeErrors: [],
    truncated: false,
    discovery:
      "Lists ENTITY#TASK then TASK#{id}/ASSIGNMENT#{email}. Does not scan USER partitions. Assignments on tasks past the page/task cap are not seen.",
  };
}

function summarizeBackfill(report) {
  return {
    mode: report.mode,
    scannedTasks: report.scannedTasks,
    scannedAssignments: report.scannedAssignments,
    candidateCount: report.candidates.length,
    existingCount: report.existing.length,
    skippedCount: report.skipped.length,
    malformedCount: report.malformed.length,
    conflictCount: report.conflicts.length,
    writtenCount: report.written.length,
    writeErrorCount: report.writeErrors.length,
    truncated: report.truncated,
    discovery: report.discovery,
  };
}

async function planUserAssignmentPointerBackfill({
  ddb,
  tableName,
  maxTasks = 400,
  maxQueryPages = 40,
  exclusiveStartKey,
} = {}) {
  const report = emptyBackfillReport();
  if (!ddb || !tableName) {
    report.malformed.push({ reason: "MISSING_TABLE" });
    return report;
  }
  const listed = await queryPages(
    ddb,
    {
      TableName: tableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
      ExclusiveStartKey: exclusiveStartKey,
    },
    { maxPages: maxQueryPages }
  );
  report.truncated = listed.truncated;
  const tasks = listed.items.slice(0, maxTasks);
  if (listed.items.length > maxTasks) report.truncated = true;
  report.scannedTasks = tasks.length;

  for (const task of tasks) {
    const taskId = String(task.taskId || String(task.SK || "").replace(/^TASK#/, "")).trim();
    if (!taskId) {
      report.skipped.push({ reason: "TASK_MISSING_ID", pk: task.PK, sk: task.SK });
      continue;
    }
    const assignments = await queryPages(
      ddb,
      {
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `TASK#${taskId}`,
          ":sk": "ASSIGNMENT#",
        },
      },
      { maxPages: maxQueryPages }
    );
    if (assignments.truncated) report.truncated = true;
    for (const assignment of assignments.items) {
      report.scannedAssignments += 1;
      const inspected = inspectCanonicalAssignment(assignment);
      if (!inspected.ok) {
        const bucket =
          inspected.code === "MALFORMED" ? report.malformed : report.skipped;
        bucket.push({
          taskId,
          pk: assignment.PK,
          sk: assignment.SK,
          code: inspected.code,
          reason: inspected.reason,
        });
        continue;
      }
      const pointer = inspected.pointer;
      const existingRes = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: pointer.PK, SK: pointer.SK },
        })
      );
      const classification = classifyExistingPointer(existingRes.Item, pointer);
      const row = {
        taskId: pointer.taskId,
        email: pointer.email,
        pointerPk: pointer.PK,
        pointerSk: pointer.SK,
      };
      if (classification === "EXISTING") report.existing.push(row);
      else if (classification === "CONFLICT") {
        report.conflicts.push({
          ...row,
          existingType: existingRes.Item?.type || null,
          existingTaskId: existingRes.Item?.taskId || null,
          existingEmail: existingRes.Item?.email || null,
        });
      } else report.candidates.push({ ...row, pointer });
    }
  }
  return report;
}

async function applyUserAssignmentPointerBackfill(ddb, tableName, report, { write = false } = {}) {
  const next = { ...report, mode: write ? "write" : "dry-run" };
  if (!write) return next;
  for (const candidate of report.candidates) {
    try {
      await ddb.send(
        new PutCommand(backfillPointerPut(tableName, candidate.pointer).Put)
      );
      next.written.push({
        taskId: candidate.taskId,
        email: candidate.email,
        pointerPk: candidate.pointerPk,
        pointerSk: candidate.pointerSk,
      });
    } catch (err) {
      const name = String(err?.name || "");
      if (name === "ConditionalCheckFailedException") {
        next.existing.push({
          taskId: candidate.taskId,
          email: candidate.email,
          pointerPk: candidate.pointerPk,
          pointerSk: candidate.pointerSk,
          raced: true,
        });
        continue;
      }
      next.writeErrors.push({
        taskId: candidate.taskId,
        email: candidate.email,
        message: err?.message || String(err),
      });
    }
  }
  return next;
}

async function runUserAssignmentPointerBackfill(options) {
  const report = await planUserAssignmentPointerBackfill(options);
  return applyUserAssignmentPointerBackfill(
    options.ddb,
    options.tableName,
    report,
    { write: options.write === true }
  );
}

module.exports = {
  TYPE_USER_ASSIGNMENT,
  userAssignmentPointerItem,
  inspectCanonicalAssignment,
  isCompatiblePointer,
  classifyExistingPointer,
  pointerPut,
  backfillPointerPut,
  evalPointerCondition,
  planUserAssignmentPointerBackfill,
  applyUserAssignmentPointerBackfill,
  runUserAssignmentPointerBackfill,
  summarizeBackfill,
};

const { GetCommand, PutCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const {
  userAssignmentPointerItem,
  pointerPut,
  isCompatiblePointer,
} = require("./userAssignmentPointers");

const TASK_COMPLETION_EMAIL_ATTRS = [
  "completionEmailStatus",
  "completionEmailClaimedAt",
  "completionEmailUpdatedAt",
  "completionEmailError",
  "completionEmailRecipientCount",
  "completionEmailAttempts",
];

const ASSIGNMENT_RED_NOTIFY_ATTRS = [
  "redAdminNotifyStatus",
  "redAdminNotifyClaimedAt",
  "redAdminNotifiedAt",
  "redAdminNotifyRecipients",
  "redAdminNotifyAttempts",
];

const ASSIGNMENT_BLOCKER_ATTRS = [
  "blockerStatus",
  "blockerRemark",
  "blockerReportedAt",
  "blockerResolvedAt",
  "blockerResolvedBy",
];

const ASSIGNMENT_HOUR_ATTRS = ["plannedHours", "actualHours"];

const TASK_NOTIFY_ATTRS = [
  ...TASK_COMPLETION_EMAIL_ATTRS,
  ...ASSIGNMENT_RED_NOTIFY_ATTRS,
];

const MAX_ATTEMPTS = 2;

class PersistConflictError extends Error {
  constructor(reason, extra = {}) {
    super("Task could not be saved. Please retry.");
    this.name = "PersistConflictError";
    this.statusCode = 409;
    this.reason = reason || "PERSIST_FAILED";
    this.taskId = extra.taskId || "";
    this.op = extra.op || "";
  }
}

function isConditionalCheckFailed(err) {
  return String(err?.name || "") === "ConditionalCheckFailedException";
}

function overlayStoredAttrs(outgoing, stored, attrNames) {
  const next = { ...(outgoing || {}) };
  const names = Array.isArray(attrNames) ? attrNames : [];
  for (const name of names) {
    if (stored && Object.prototype.hasOwnProperty.call(stored, name)) {
      const value = stored[name];
      next[name] =
        value && typeof value === "object" && !Array.isArray(value)
          ? { ...value }
          : value;
    } else {
      delete next[name];
    }
  }
  return next;
}

function overlayMissingAttrs(outgoing, stored, attrNames) {
  const next = { ...(outgoing || {}) };
  const names = Array.isArray(attrNames) ? attrNames : [];
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(next, name)) continue;
    if (!stored || !Object.prototype.hasOwnProperty.call(stored, name)) continue;
    const value = stored[name];
    next[name] =
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...value }
        : value;
  }
  return next;
}

function overlayPreservedHours(outgoing, stored) {
  const next = { ...(outgoing || {}) };
  for (const name of ASSIGNMENT_HOUR_ATTRS) {
    if (next[name] != null) continue;
    if (stored && stored[name] != null) {
      next[name] = stored[name];
    } else {
      delete next[name];
    }
  }
  return next;
}

function keepAuditValue(value) {
  return value != null && value !== "";
}

/**
 * Keep the submission audit fields across unrelated assignment puts.
 * An explicit null clears the field. A missing field is copied from the stored row.
 * A new employee submission sets a new submittedAt; that non-empty value is kept.
 */
function overlayPreservedSubmission(outgoing, stored) {
  const next = { ...(outgoing || {}) };
  if (Object.prototype.hasOwnProperty.call(next, "submittedAt")) {
    if (!keepAuditValue(next.submittedAt)) delete next.submittedAt;
  } else if (keepAuditValue(stored?.submittedAt)) {
    next.submittedAt = stored.submittedAt;
  }
  if (Object.prototype.hasOwnProperty.call(next, "reviewNotifySubmissionId")) {
    if (!keepAuditValue(next.reviewNotifySubmissionId)) delete next.reviewNotifySubmissionId;
  } else if (keepAuditValue(stored?.reviewNotifySubmissionId)) {
    next.reviewNotifySubmissionId = stored.reviewNotifySubmissionId;
  }
  if (Object.prototype.hasOwnProperty.call(next, "reviewNotifyPending")) {
    if (next.reviewNotifyPending !== true) delete next.reviewNotifyPending;
  } else if (stored?.reviewNotifyPending === true) {
    next.reviewNotifyPending = true;
  }
  return next;
}

function statusCondition(stored, statusKey, claimedKey) {
  const status = stored?.[statusKey];
  const claimed = stored?.[claimedKey];
  if (status == null || status === "") {
    return {
      ConditionExpression:
        "attribute_not_exists(#notifyStatus) OR attribute_type(#notifyStatus, :nullType)",
      ExpressionAttributeNames: { "#notifyStatus": statusKey },
      ExpressionAttributeValues: { ":nullType": "NULL" },
    };
  }
  if (claimed == null || claimed === "") {
    return {
      ConditionExpression:
        "#notifyStatus = :notifyStatus AND (attribute_not_exists(#notifyClaimed) OR attribute_type(#notifyClaimed, :nullType))",
      ExpressionAttributeNames: {
        "#notifyStatus": statusKey,
        "#notifyClaimed": claimedKey,
      },
      ExpressionAttributeValues: {
        ":notifyStatus": status,
        ":nullType": "NULL",
      },
    };
  }
  return {
    ConditionExpression: "#notifyStatus = :notifyStatus AND #notifyClaimed = :notifyClaimed",
    ExpressionAttributeNames: {
      "#notifyStatus": statusKey,
      "#notifyClaimed": claimedKey,
    },
    ExpressionAttributeValues: {
      ":notifyStatus": status,
      ":notifyClaimed": claimed,
    },
  };
}

async function getItem(ddb, tableName, key) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: key,
    })
  );
  return res.Item || null;
}

async function putProtectedItem(
  ddb,
  tableName,
  outgoing,
  attrNames,
  statusKey,
  claimedKey,
  preserveAttrs
) {
  const key = { PK: outgoing.PK, SK: outgoing.SK };
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const stored = await getItem(ddb, tableName, key);
    if (!stored) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: tableName,
            Item: outgoing,
            ConditionExpression: "attribute_not_exists(PK)",
          })
        );
        return { ok: true, created: true, item: outgoing };
      } catch (err) {
        lastError = err;
        if (isConditionalCheckFailed(err) && attempt < MAX_ATTEMPTS) continue;
        if (isConditionalCheckFailed(err)) {
          console.error(
            "TASK_NOTIFY_PERSIST_CONFLICT",
            JSON.stringify({ PK: key.PK, SK: key.SK, reason: "CREATE_CONFLICT" })
          );
          return { ok: false, reason: "CREATE_CONFLICT" };
        }
        throw err;
      }
    }
    let item = overlayStoredAttrs(outgoing, stored, attrNames);
    item = overlayMissingAttrs(item, stored, preserveAttrs);
    item = overlayPreservedHours(item, stored);
    item = overlayPreservedSubmission(item, stored);
    const cond = statusCondition(stored, statusKey, claimedKey);
    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: cond.ConditionExpression,
          ExpressionAttributeNames: cond.ExpressionAttributeNames,
          ExpressionAttributeValues: cond.ExpressionAttributeValues,
        })
      );
      return { ok: true, created: false, item };
    } catch (err) {
      lastError = err;
      if (isConditionalCheckFailed(err) && attempt < MAX_ATTEMPTS) continue;
      if (isConditionalCheckFailed(err)) {
        console.error(
          "TASK_NOTIFY_PERSIST_CONFLICT",
          JSON.stringify({ PK: key.PK, SK: key.SK, reason: "UPDATE_CONFLICT" })
        );
        return { ok: false, reason: "UPDATE_CONFLICT", stored };
      }
      throw err;
    }
  }
  console.error(lastError);
  return { ok: false, reason: "PERSIST_FAILED" };
}

function assertPersistOk(result, extra = {}) {
  if (result && result.ok) return result;
  const reason = result?.reason || "PERSIST_FAILED";
  console.error(
    "TASK_NOTIFY_PERSIST_FAILED",
    JSON.stringify({
      reason,
      op: extra.op || "",
      taskId: extra.taskId || "",
      email: extra.email || "",
      PK: extra.PK || "",
      SK: extra.SK || "",
    })
  );
  throw new PersistConflictError(reason, extra);
}

const CATALOG_PK = "ENTITY#PROJECT";
const DELETION_DELETING = "DELETING";
const CATALOG_LIVE_CREATE_CONDITION =
  "attribute_exists(PK) AND (attribute_not_exists(deletionStatus) OR deletionStatus <> :deleting) AND attribute_not_exists(deletionLockId)";

function isTransactionCanceled(err) {
  const name = String(err?.name || "");
  if (name === "TransactionCanceledException") return true;
  const reasons = err?.CancellationReasons || err?.cancellationReasons || [];
  return reasons.some(
    (row) => String(row?.Code || row?.code || "") === "ConditionalCheckFailed"
  );
}

function catalogCreateConditionCheck(tableName, projectId) {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { PK: CATALOG_PK, SK: `PROJECT#${projectId}` },
      ConditionExpression: CATALOG_LIVE_CREATE_CONDITION,
      ExpressionAttributeValues: { ":deleting": DELETION_DELETING },
    },
  };
}

function assignmentPutItem(taskId, assignment) {
  if (!assignment || !assignment.PK || !assignment.SK) return null;
  return assignment;
}

async function putUserAssignmentPointer(ddb, tableName, assignmentItem) {
  const pointer = userAssignmentPointerItem(assignmentItem);
  if (!pointer) return { ok: true, skipped: true };
  if (!ddb || !tableName) {
    return { ok: false, reason: "USER_ASSIGNMENT_POINTER" };
  }
  try {
    await ddb.send(new PutCommand(pointerPut(tableName, pointer).Put));
    return { ok: true, pointer };
  } catch (err) {
    if (isConditionalCheckFailed(err) || isTransactionCanceled(err)) {
      const existing = await getItem(ddb, tableName, {
        PK: pointer.PK,
        SK: pointer.SK,
      });
      if (isCompatiblePointer(existing, pointer)) {
        return { ok: true, pointer, existing: true };
      }
      if (existing) {
        console.error(
          "USER_ASSIGNMENT_POINTER_CONFLICT",
          JSON.stringify({
            taskId: pointer.taskId,
            email: pointer.email,
            existingType: existing.type || null,
          })
        );
        return { ok: false, reason: "USER_ASSIGNMENT_POINTER_CONFLICT" };
      }
      return { ok: false, reason: "USER_ASSIGNMENT_POINTER" };
    }
    console.error(
      "USER_ASSIGNMENT_POINTER_FAILED",
      JSON.stringify({
        taskId: pointer.taskId,
        email: pointer.email,
        message: err?.message || String(err),
      })
    );
    return { ok: false, reason: "USER_ASSIGNMENT_POINTER" };
  }
}

/**
 * Create canonical + project-side task copies (and optional assignments)
 * only when the catalog exists, is not DELETING, and has no deletion lock.
 */
async function putCreatedTaskRecords(ddb, tableName, task, assignmentItems = []) {
  const projectId = String(task?.projectId || "").trim();
  if (!ddb || !tableName || !task || !task.PK || !task.SK || !projectId) {
    return { ok: false, reason: "INVALID_ITEM" };
  }
  const canonical = { ...task, projectId };
  const projectCopy = {
    ...canonical,
    PK: `PROJECT#${projectId}`,
    SK: `TASK#${task.taskId}`,
  };
  const puts = [
    catalogCreateConditionCheck(tableName, projectId),
    {
      Put: {
        TableName: tableName,
        Item: canonical,
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: projectCopy,
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
  ];
  for (const item of assignmentItems || []) {
    const row = assignmentPutItem(task.taskId, item);
    if (!row) continue;
    puts.push({
      Put: {
        TableName: tableName,
        Item: row,
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
    const pointer = userAssignmentPointerItem({
      ...row,
      taskId: row.taskId || task.taskId,
    });
    if (pointer) {
      puts.push(pointerPut(tableName, pointer));
    }
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: puts }));
    return { ok: true, created: true, item: canonical };
  } catch (err) {
    if (isConditionalCheckFailed(err) || isTransactionCanceled(err)) {
      console.error(
        "TASK_NOTIFY_PERSIST_CONFLICT",
        JSON.stringify({
          PK: task.PK,
          SK: task.SK,
          reason: "CATALOG_NOT_WRITABLE",
        })
      );
      return { ok: false, reason: "CATALOG_NOT_WRITABLE" };
    }
    throw err;
  }
}

async function putTaskCopiesSafe(ddb, tableName, task) {
  if (!ddb || !tableName || !task || !task.PK || !task.SK) {
    return { ok: false, reason: "INVALID_ITEM" };
  }
  const entity = await putProtectedItem(
    ddb,
    tableName,
    task,
    TASK_NOTIFY_ATTRS,
    "completionEmailStatus",
    "completionEmailClaimedAt"
  );
  if (!entity.ok) return entity;
  if (!task.projectId) return entity;
  const entityStored = await getItem(ddb, tableName, {
    PK: task.PK,
    SK: task.SK,
  });
  const projectOutgoing = overlayStoredAttrs(
    {
      ...task,
      PK: `PROJECT#${task.projectId}`,
      SK: `TASK#${task.taskId}`,
    },
    entityStored || entity.item,
    TASK_NOTIFY_ATTRS
  );
  return putProtectedItem(
    ddb,
    tableName,
    projectOutgoing,
    [],
    "completionEmailStatus",
    "completionEmailClaimedAt"
  );
}

async function putAssignmentSafe(ddb, tableName, item) {
  if (!ddb || !tableName || !item || !item.PK || !item.SK) {
    return { ok: false, reason: "INVALID_ITEM" };
  }
  const result = await putProtectedItem(
    ddb,
    tableName,
    item,
    ASSIGNMENT_RED_NOTIFY_ATTRS,
    "redAdminNotifyStatus",
    "redAdminNotifyClaimedAt",
    ASSIGNMENT_BLOCKER_ATTRS
  );
  if (!result.ok) return result;
  const pointerResult = await putUserAssignmentPointer(
    ddb,
    tableName,
    result.item || item
  );
  if (!pointerResult.ok) {
    return {
      ok: false,
      reason: pointerResult.reason || "USER_ASSIGNMENT_POINTER",
      assignmentWritten: true,
    };
  }
  return result;
}

async function prepareProtectedAssignmentPut(ddb, tableName, outgoing) {
  if (!ddb || !tableName || !outgoing || !outgoing.PK || !outgoing.SK) {
    return { ok: false, reason: "INVALID_ITEM" };
  }
  const stored = await getItem(ddb, tableName, {
    PK: outgoing.PK,
    SK: outgoing.SK,
  });
  if (!stored) {
    return {
      ok: true,
      item: outgoing,
      put: {
        Put: {
          TableName: tableName,
          Item: outgoing,
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
    };
  }
  let item = overlayStoredAttrs(outgoing, stored, ASSIGNMENT_RED_NOTIFY_ATTRS);
  item = overlayMissingAttrs(item, stored, ASSIGNMENT_BLOCKER_ATTRS);
  item = overlayPreservedHours(item, stored);
  item = overlayPreservedSubmission(item, stored);
  const cond = statusCondition(
    stored,
    "redAdminNotifyStatus",
    "redAdminNotifyClaimedAt"
  );
  return {
    ok: true,
    item,
    put: {
      Put: {
        TableName: tableName,
        Item: item,
        ConditionExpression: cond.ConditionExpression,
        ExpressionAttributeNames: cond.ExpressionAttributeNames,
        ExpressionAttributeValues: cond.ExpressionAttributeValues,
      },
    },
  };
}

module.exports = {
  TASK_COMPLETION_EMAIL_ATTRS,
  ASSIGNMENT_RED_NOTIFY_ATTRS,
  ASSIGNMENT_BLOCKER_ATTRS,
  ASSIGNMENT_HOUR_ATTRS,
  TASK_NOTIFY_ATTRS,
  overlayStoredAttrs,
  overlayMissingAttrs,
  overlayPreservedHours,
  overlayPreservedSubmission,
  putCreatedTaskRecords,
  putTaskCopiesSafe,
  putAssignmentSafe,
  putUserAssignmentPointer,
  userAssignmentPointerItem,
  prepareProtectedAssignmentPut,
  assertPersistOk,
  PersistConflictError,
  isConditionalCheckFailed,
};

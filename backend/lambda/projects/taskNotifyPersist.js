const { GetCommand, PutCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");

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
  claimedKey
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
    const item = overlayStoredAttrs(outgoing, stored, attrNames);
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
  return putProtectedItem(
    ddb,
    tableName,
    item,
    ASSIGNMENT_RED_NOTIFY_ATTRS,
    "redAdminNotifyStatus",
    "redAdminNotifyClaimedAt"
  );
}

module.exports = {
  TASK_COMPLETION_EMAIL_ATTRS,
  ASSIGNMENT_RED_NOTIFY_ATTRS,
  TASK_NOTIFY_ATTRS,
  overlayStoredAttrs,
  putCreatedTaskRecords,
  putTaskCopiesSafe,
  putAssignmentSafe,
  assertPersistOk,
  PersistConflictError,
  isConditionalCheckFailed,
};

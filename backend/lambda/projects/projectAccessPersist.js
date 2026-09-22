/**
 * WorkTasks Project ACL persistence and catalog deletion locks.
 * Dual copies are written with TransactWrite. Project-side GetItem is
 * authoritative for later access checks. Client PK/SK/type are ignored.
 * Catalog deletionLockId/deletionLockAt serialize DELETE vs task create.
 */
const { GetCommand, QueryCommand, UpdateCommand, TransactWriteCommand, BatchWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const {
  STATUS_ACTIVE,
  VISIBILITY_ASSIGNED_ONLY,
  VISIBILITY_ALL_PROJECT_TASKS,
  ACCESS_RESTRICTED,
  DELETION_DELETING,
  normalizeEmail,
  projectMemberKeys,
  projectAdminKeys,
  isRestrictedProject,
  isActiveProjectAdminItem,
} = require("./projectAccess");

const STATUS_REVOKED = "REVOKED";
const TYPE_MEMBER = "PROJECT_MEMBER";
const TYPE_ADMIN = "PROJECT_ADMIN";
const MODE_CREATE = "create";
const MODE_REACTIVATE = "reactivate";
const MODE_UPDATE_VISIBILITY = "updateVisibility";

const REASON_INVALID_IDENTITY = "INVALID_IDENTITY";
const REASON_INVALID_TASK_VISIBILITY = "INVALID_TASK_VISIBILITY";
const REASON_CONDITION_FAILED = "CONDITION_FAILED";
const REASON_TX_CONFLICT = "TX_CONFLICT";
const REASON_DDB_ERROR = "DDB_ERROR";
const CATALOG_PK = "ENTITY#PROJECT";
const CREATE_CONDITION = "attribute_not_exists(PK)";
const ACL_DELETE_BATCH = 25;
const ACL_DELETE_ATTEMPTS = 5;
const DEFAULT_DELETION_LOCK_STALE_MS = 180000;

function deletionLockStaleMs() {
  const n = Number(process.env.TASK_IMPORT_PROCESSING_LEASE_MS);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_DELETION_LOCK_STALE_MS;
}

function staleLockCutoff(now, staleMs) {
  const ts = Date.parse(timestamp(now));
  const base = Number.isFinite(ts) ? ts : Date.now();
  return new Date(base - staleMs).toISOString();
}

function trimId(value) {
  return String(value || "").trim();
}

function validateContext(ddb, tableName, projectId, email) {
  if (!ddb || typeof ddb.send !== "function") {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  const table = trimId(tableName);
  const id = trimId(projectId);
  const e = normalizeEmail(email);
  if (!table || !id || !e) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  return { ok: true, tableName: table, projectId: id, email: e };
}

function timestamp(now) {
  return now ? String(now) : new Date().toISOString();
}

function actorOf(actorEmail) {
  return normalizeEmail(actorEmail);
}

/**
 * Write-path visibility.
 * Create/reactivate: missing/blank → ALL_PROJECT_TASKS.
 * updateVisibility: missing/blank → INVALID_TASK_VISIBILITY (no silent widen).
 * Invalid non-empty → INVALID_TASK_VISIBILITY (do not write).
 */
function resolveWriteTaskVisibility(taskVisibility, { required } = {}) {
  if (taskVisibility == null || String(taskVisibility).trim() === "") {
    if (required) {
      return { ok: false, reason: REASON_INVALID_TASK_VISIBILITY };
    }
    return { ok: true, value: VISIBILITY_ALL_PROJECT_TASKS };
  }
  const raw = String(taskVisibility).trim().toUpperCase();
  if (raw === VISIBILITY_ASSIGNED_ONLY) {
    return { ok: true, value: VISIBILITY_ASSIGNED_ONLY };
  }
  if (raw === VISIBILITY_ALL_PROJECT_TASKS) {
    return { ok: true, value: VISIBILITY_ALL_PROJECT_TASKS };
  }
  return { ok: false, reason: REASON_INVALID_TASK_VISIBILITY };
}

function cancellationReasonsOf(err) {
  const raw = err?.CancellationReasons || err?.cancellationReasons;
  return Array.isArray(raw) ? raw : [];
}

function mapTxError(err) {
  const name = String(err?.name || "");
  const reasons = cancellationReasonsOf(err);
  const codes = reasons.map((r) => String(r?.Code || r?.code || ""));
  const hasCondition =
    name === "ConditionalCheckFailedException" ||
    codes.some((c) => c === "ConditionalCheckFailed");
  const hasConflict =
    name === "TransactionConflictException" ||
    codes.some((c) => c === "TransactionConflict");

  if (hasCondition) {
    return {
      ok: false,
      reason: REASON_CONDITION_FAILED,
      cancellationReasons: reasons,
    };
  }
  if (hasConflict) {
    return {
      ok: false,
      reason: REASON_TX_CONFLICT,
      cancellationReasons: reasons,
    };
  }
  return { ok: false, reason: REASON_DDB_ERROR, cancellationReasons: reasons };
}

function applyServerTable(transactItems, tableName) {
  return (transactItems || []).map((entry) => {
    const next = { ...entry };
    if (next.Put) {
      next.Put = { ...next.Put, TableName: tableName };
    }
    if (next.Update) {
      next.Update = { ...next.Update, TableName: tableName };
    }
    if (next.Delete) {
      next.Delete = { ...next.Delete, TableName: tableName };
    }
    if (next.ConditionCheck) {
      next.ConditionCheck = { ...next.ConditionCheck, TableName: tableName };
    }
    return next;
  });
}

async function sendTransact(ddb, tableName, transactItems) {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: applyServerTable(transactItems, tableName),
      })
    );
    return { ok: true };
  } catch (err) {
    return mapTxError(err);
  }
}

/**
 * Internal dual-copy TransactWrite only. Not exported. Not safe for HTTP.
 * Named helpers must supply server-computed TransactItems; never request-body
 * transactItems, PK, SK, TableName, Item, Key, or UpdateExpression.
 */
async function transactDualWrite(ddb, tableName, params = {}) {
  const table = trimId(tableName);
  if (!ddb || typeof ddb.send !== "function" || !table) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  const transactItems = params.transactItems;
  if (!Array.isArray(transactItems) || transactItems.length < 2 || transactItems.length > 3) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  return sendTransact(ddb, table, transactItems);
}

async function getByProjectSideKey(ddb, tableName, projectId, email, keysFn) {
  const ctx = validateContext(ddb, tableName, projectId, email);
  if (!ctx.ok) return ctx;
  const key = keysFn(ctx.projectId, ctx.email).projectSide;
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: ctx.tableName,
        Key: { PK: key.PK, SK: key.SK },
      })
    );
    return { ok: true, item: res.Item || null };
  } catch (err) {
    return { ok: false, reason: REASON_DDB_ERROR };
  }
}

async function getProjectMemberRecord(ddb, tableName, projectId, email) {
  return getByProjectSideKey(ddb, tableName, projectId, email, projectMemberKeys);
}

async function getProjectAdminRecord(ddb, tableName, projectId, email) {
  return getByProjectSideKey(ddb, tableName, projectId, email, projectAdminKeys);
}

function memberPutItem(projectId, email, fields) {
  const keys = projectMemberKeys(projectId, email);
  const base = {
    type: TYPE_MEMBER,
    status: STATUS_ACTIVE,
    email,
    projectId,
    addedAt: fields.addedAt,
    addedBy: fields.addedBy,
  };
  return {
    projectSide: { ...keys.projectSide, ...base },
    userSide: { ...keys.userSide, ...base },
  };
}

function adminPutItem(projectId, email, fields) {
  const keys = projectAdminKeys(projectId, email);
  const base = {
    type: TYPE_ADMIN,
    status: STATUS_ACTIVE,
    email,
    projectId,
    taskVisibility: fields.taskVisibility,
    addedAt: fields.addedAt,
    addedBy: fields.addedBy,
  };
  return {
    projectSide: { ...keys.projectSide, ...base },
    userSide: { ...keys.userSide, ...base },
  };
}

function createPuts(tableName, projectItem, userItem) {
  const cond = "attribute_not_exists(PK)";
  return [
    { Put: { TableName: tableName, Item: projectItem, ConditionExpression: cond } },
    { Put: { TableName: tableName, Item: userItem, ConditionExpression: cond } },
  ];
}

function dualUpdates(tableName, keys, updateExpression, values, condition) {
  const names = { "#status": "status" };
  const shared = {
    TableName: tableName,
    UpdateExpression: updateExpression,
    ConditionExpression: condition,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
  return [
    { Update: { ...shared, Key: { ...keys.projectSide } } },
    { Update: { ...shared, Key: { ...keys.userSide } } },
  ];
}

async function putProjectMemberRecords(ddb, tableName, params = {}) {
  const ctx = validateContext(ddb, tableName, params.projectId, params.email);
  if (!ctx.ok) return ctx;
  const mode = String(params.mode || "");
  if (mode !== MODE_CREATE && mode !== MODE_REACTIVATE) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  const now = timestamp(params.now);
  const actor = actorOf(params.actorEmail);

  if (mode === MODE_CREATE) {
    const items = memberPutItem(ctx.projectId, ctx.email, {
      addedAt: now,
      addedBy: actor,
    });
    return transactDualWrite(ddb, ctx.tableName, {
      transactItems: createPuts(ctx.tableName, items.projectSide, items.userSide),
    });
  }

  const keys = projectMemberKeys(ctx.projectId, ctx.email);
  return transactDualWrite(ddb, ctx.tableName, {
    transactItems: dualUpdates(
      ctx.tableName,
      keys,
      "SET #status = :active, updatedAt = :now, updatedBy = :actor",
      { ":active": STATUS_ACTIVE, ":revoked": STATUS_REVOKED, ":now": now, ":actor": actor },
      "attribute_exists(PK) AND #status = :revoked"
    ),
  });
}

async function revokeProjectMemberRecords(ddb, tableName, params = {}) {
  const ctx = validateContext(ddb, tableName, params.projectId, params.email);
  if (!ctx.ok) return ctx;
  const now = timestamp(params.now);
  const actor = actorOf(params.actorEmail);
  const keys = projectMemberKeys(ctx.projectId, ctx.email);
  return transactDualWrite(ddb, ctx.tableName, {
    transactItems: dualUpdates(
      ctx.tableName,
      keys,
      "SET #status = :revoked, updatedAt = :now, updatedBy = :actor",
      { ":revoked": STATUS_REVOKED, ":active": STATUS_ACTIVE, ":now": now, ":actor": actor },
      "attribute_exists(PK) AND #status = :active"
    ),
  });
}

function dualDeletes(tableName, keys) {
  return [
    { Delete: { TableName: tableName, Key: { ...keys.projectSide } } },
    { Delete: { TableName: tableName, Key: { ...keys.userSide } } },
  ];
}

async function deleteProjectMemberRecords(ddb, tableName, params = {}) {
  const ctx = validateContext(ddb, tableName, params.projectId, params.email);
  if (!ctx.ok) return ctx;
  const keys = projectMemberKeys(ctx.projectId, ctx.email);
  return transactDualWrite(ddb, ctx.tableName, {
    transactItems: dualDeletes(ctx.tableName, keys),
  });
}

async function putProjectAdminRecords(ddb, tableName, params = {}) {
  const ctx = validateContext(ddb, tableName, params.projectId, params.email);
  if (!ctx.ok) return ctx;
  const mode = String(params.mode || "");
  if (
    mode !== MODE_CREATE &&
    mode !== MODE_REACTIVATE &&
    mode !== MODE_UPDATE_VISIBILITY
  ) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  const vis = resolveWriteTaskVisibility(params.taskVisibility, {
    required: mode === MODE_UPDATE_VISIBILITY,
  });
  if (!vis.ok) return vis;
  const now = timestamp(params.now);
  const actor = actorOf(params.actorEmail);

  if (mode === MODE_CREATE) {
    const items = adminPutItem(ctx.projectId, ctx.email, {
      addedAt: now,
      addedBy: actor,
      taskVisibility: vis.value,
    });
    return transactDualWrite(ddb, ctx.tableName, {
      transactItems: withAdminCount(
        createPuts(ctx.tableName, items.projectSide, items.userSide),
        adminCountIncrement(ctx.tableName, ctx.projectId),
        params.enforceAdminCount === true
      ),
    });
  }

  const keys = projectAdminKeys(ctx.projectId, ctx.email);
  if (mode === MODE_REACTIVATE) {
    return transactDualWrite(ddb, ctx.tableName, {
      transactItems: withAdminCount(
        dualUpdates(
          ctx.tableName,
          keys,
          "SET #status = :active, taskVisibility = :vis, updatedAt = :now, updatedBy = :actor",
          {
            ":active": STATUS_ACTIVE,
            ":revoked": STATUS_REVOKED,
            ":vis": vis.value,
            ":now": now,
            ":actor": actor,
          },
          "attribute_exists(PK) AND #status = :revoked"
        ),
        adminCountIncrement(ctx.tableName, ctx.projectId),
        params.enforceAdminCount === true
      ),
    });
  }

  return transactDualWrite(ddb, ctx.tableName, {
    transactItems: dualUpdates(
      ctx.tableName,
      keys,
      "SET taskVisibility = :vis, updatedAt = :now, updatedBy = :actor",
      {
        ":vis": vis.value,
        ":active": STATUS_ACTIVE,
        ":now": now,
        ":actor": actor,
      },
      "attribute_exists(PK) AND #status = :active"
    ),
  });
}

async function revokeProjectAdminRecords(ddb, tableName, params = {}) {
  const ctx = validateContext(ddb, tableName, params.projectId, params.email);
  if (!ctx.ok) return ctx;
  const now = timestamp(params.now);
  const actor = actorOf(params.actorEmail);
  const keys = projectAdminKeys(ctx.projectId, ctx.email);
  return transactDualWrite(ddb, ctx.tableName, {
    transactItems: withAdminCount(
      dualUpdates(
        ctx.tableName,
        keys,
        "SET #status = :revoked, updatedAt = :now, updatedBy = :actor",
        { ":revoked": STATUS_REVOKED, ":active": STATUS_ACTIVE, ":now": now, ":actor": actor },
        "attribute_exists(PK) AND #status = :active"
      ),
      adminCountDecrement(ctx.tableName, ctx.projectId),
      params.enforceAdminCount === true
    ),
  });
}

async function deleteProjectAdminRecords(ddb, tableName, params = {}) {
  const ctx = validateContext(ddb, tableName, params.projectId, params.email);
  if (!ctx.ok) return ctx;
  const keys = projectAdminKeys(ctx.projectId, ctx.email);
  return transactDualWrite(ddb, ctx.tableName, {
    transactItems: dualDeletes(ctx.tableName, keys),
  });
}

function catalogKey(projectId) {
  return { PK: CATALOG_PK, SK: `PROJECT#${projectId}` };
}

function adminCountIncrement(tableName, projectId) {
  return {
    Update: {
      TableName: tableName,
      Key: catalogKey(projectId),
      UpdateExpression: "ADD activeAdminCount :inc",
      ConditionExpression: "attribute_exists(PK) AND attribute_exists(activeAdminCount)",
      ExpressionAttributeValues: { ":inc": 1 },
    },
  };
}

function adminCountDecrement(tableName, projectId) {
  return {
    Update: {
      TableName: tableName,
      Key: catalogKey(projectId),
      UpdateExpression: "ADD activeAdminCount :dec",
      ConditionExpression:
        "attribute_exists(PK) AND attribute_exists(activeAdminCount) AND activeAdminCount > :min",
      ExpressionAttributeValues: { ":dec": -1, ":min": 1 },
    },
  };
}

function withAdminCount(transactItems, countItem, enforce) {
  if (!enforce) return transactItems;
  return [countItem, ...transactItems];
}

/**
 * Atomic RESTRICTED project create: catalog + dual PROJECT_ADMIN copies.
 * Not the two-item membership wrapper. Caller must generate projectId.
 */
async function createRestrictedProject(ddb, tableName, params = {}) {
  const ctx = validateContext(ddb, tableName, params.projectId, params.email);
  if (!ctx.ok) return ctx;
  const vis = resolveWriteTaskVisibility(params.taskVisibility);
  if (!vis.ok) return vis;
  const now = timestamp(params.now);
  const actor = actorOf(params.actorEmail) || ctx.email;
  const incoming = { ...(params.catalog || {}) };
  delete incoming.PK;
  delete incoming.SK;
  const catalog = {
    ...incoming,
    PK: CATALOG_PK,
    SK: `PROJECT#${ctx.projectId}`,
    projectId: ctx.projectId,
    accessMode: ACCESS_RESTRICTED,
    createdBy: ctx.email,
    activeAdminCount: 1,
  };
  const admins = adminPutItem(ctx.projectId, ctx.email, {
    addedAt: now,
    addedBy: actor,
    taskVisibility: vis.value,
  });
  const transactItems = [
    {
      Put: {
        TableName: ctx.tableName,
        Item: catalog,
        ConditionExpression: CREATE_CONDITION,
      },
    },
    {
      Put: {
        TableName: ctx.tableName,
        Item: admins.projectSide,
        ConditionExpression: CREATE_CONDITION,
      },
    },
    {
      Put: {
        TableName: ctx.tableName,
        Item: admins.userSide,
        ConditionExpression: CREATE_CONDITION,
      },
    },
  ];
  const memberEmails = [];
  const seenMembers = new Set();
  const incomingMembers = Array.isArray(params.members) ? params.members : [];
  for (const entry of incomingMembers) {
    const raw = typeof entry === "string" ? entry : entry?.email;
    const memberEmail = normalizeEmail(raw);
    if (!memberEmail || memberEmail === ctx.email || seenMembers.has(memberEmail)) {
      continue;
    }
    seenMembers.add(memberEmail);
    memberEmails.push(memberEmail);
  }
  if (transactItems.length + memberEmails.length * 2 > 100) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  const memberRecords = [];
  for (const memberEmail of memberEmails) {
    const pair = memberPutItem(ctx.projectId, memberEmail, {
      addedAt: now,
      addedBy: actor,
    });
    transactItems.push(
      {
        Put: {
          TableName: ctx.tableName,
          Item: pair.projectSide,
          ConditionExpression: CREATE_CONDITION,
        },
      },
      {
        Put: {
          TableName: ctx.tableName,
          Item: pair.userSide,
          ConditionExpression: CREATE_CONDITION,
        },
      }
    );
    memberRecords.push(pair);
  }
  const written = await sendTransact(ddb, ctx.tableName, transactItems);
  if (!written.ok) return written;
  return {
    ok: true,
    catalog,
    adminProject: admins.projectSide,
    adminUser: admins.userSide,
    members: memberRecords,
  };
}

async function queryPrefix(ddb, tableName, pk, skPrefix, { consistentRead } = {}) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": pk, ":sk": skPrefix },
        ExclusiveStartKey: lastKey,
        ConsistentRead: consistentRead === true,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function ensureRestrictedAdminCount(ddb, tableName, projectId) {
  const table = trimId(tableName);
  const id = trimId(projectId);
  if (!ddb || typeof ddb.send !== "function" || !table || !id) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  let project;
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: table,
        Key: catalogKey(id),
      })
    );
    project = res.Item || null;
  } catch (err) {
    return { ok: false, reason: REASON_DDB_ERROR };
  }
  if (!isRestrictedProject(project)) {
    return { ok: true, skipped: true, count: null };
  }
  if (Number.isFinite(Number(project.activeAdminCount))) {
    return { ok: true, count: Number(project.activeAdminCount) };
  }
  let admins;
  try {
    admins = await queryPrefix(ddb, table, `PROJECT#${id}`, "PROJECT_ADMIN#", {
      consistentRead: true,
    });
  } catch (err) {
    return { ok: false, reason: REASON_DDB_ERROR };
  }
  const count = (admins || []).filter((item) =>
    isActiveProjectAdminItem(item, id, item.email)
  ).length;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: catalogKey(id),
        UpdateExpression: "SET activeAdminCount = :n",
        ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(activeAdminCount)",
        ExpressionAttributeValues: { ":n": count },
      })
    );
    return { ok: true, count, initialized: true };
  } catch (err) {
    const name = String(err?.name || "");
    if (name !== "ConditionalCheckFailedException") {
      return { ok: false, reason: REASON_DDB_ERROR };
    }
    let latest;
    try {
      const res = await ddb.send(
        new GetCommand({
          TableName: table,
          Key: catalogKey(id),
        })
      );
      latest = res.Item || null;
    } catch (readErr) {
      return { ok: false, reason: REASON_DDB_ERROR };
    }
    if (!Number.isFinite(Number(latest?.activeAdminCount))) {
      return { ok: false, reason: REASON_DDB_ERROR };
    }
    return {
      ok: true,
      count: Number(latest.activeAdminCount),
      raced: true,
    };
  }
}

/**
 * Catalog lifecycle lock. Stale locks older than TASK_IMPORT_PROCESSING_LEASE_MS
 * (default 180s) may be recovered. Fresh locks are not stolen.
 */
async function acquireDeletionLock(ddb, tableName, projectId, params = {}) {
  const table = trimId(tableName);
  const id = trimId(projectId);
  if (!ddb || typeof ddb.send !== "function" || !table || !id) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  const lockId = trimId(params.lockId) || randomUUID();
  const now = timestamp(params.now);
  const staleMs =
    Number.isFinite(Number(params.staleMs)) && Number(params.staleMs) > 0
      ? Number(params.staleMs)
      : deletionLockStaleMs();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: catalogKey(id),
        UpdateExpression: "SET deletionLockId = :lockId, deletionLockAt = :now",
        ConditionExpression:
          "attribute_exists(PK) AND (attribute_not_exists(deletionStatus) OR deletionStatus <> :deleting) AND (attribute_not_exists(deletionLockId) OR deletionLockAt < :stale)",
        ExpressionAttributeValues: {
          ":lockId": lockId,
          ":now": now,
          ":deleting": DELETION_DELETING,
          ":stale": staleLockCutoff(now, staleMs),
        },
      })
    );
    return { ok: true, lockId, lockAt: now };
  } catch (err) {
    const name = String(err?.name || "");
    if (name === "ConditionalCheckFailedException") {
      return { ok: false, reason: REASON_CONDITION_FAILED };
    }
    return { ok: false, reason: REASON_DDB_ERROR };
  }
}

async function releaseDeletionLock(ddb, tableName, projectId, lockId) {
  const table = trimId(tableName);
  const id = trimId(projectId);
  const owned = trimId(lockId);
  if (!ddb || typeof ddb.send !== "function" || !table || !id || !owned) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: catalogKey(id),
        UpdateExpression: "REMOVE deletionLockId, deletionLockAt",
        ConditionExpression:
          "attribute_exists(PK) AND deletionLockId = :lockId AND (attribute_not_exists(deletionStatus) OR deletionStatus <> :deleting)",
        ExpressionAttributeValues: {
          ":lockId": owned,
          ":deleting": DELETION_DELETING,
        },
      })
    );
    return { ok: true };
  } catch (err) {
    const name = String(err?.name || "");
    if (name === "ConditionalCheckFailedException") {
      return { ok: false, reason: REASON_CONDITION_FAILED };
    }
    return { ok: false, reason: REASON_DDB_ERROR };
  }
}

async function convertLockToDeleting(ddb, tableName, projectId, lockId, now) {
  const table = trimId(tableName);
  const id = trimId(projectId);
  const owned = trimId(lockId);
  if (!ddb || typeof ddb.send !== "function" || !table || !id || !owned) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: catalogKey(id),
        UpdateExpression:
          "SET deletionStatus = :d, deletionStartedAt = :now REMOVE deletionLockId, deletionLockAt",
        ConditionExpression:
          "attribute_exists(PK) AND deletionLockId = :lockId AND (attribute_not_exists(deletionStatus) OR deletionStatus <> :deleting)",
        ExpressionAttributeValues: {
          ":d": DELETION_DELETING,
          ":now": timestamp(now),
          ":lockId": owned,
          ":deleting": DELETION_DELETING,
        },
      })
    );
    return { ok: true };
  } catch (err) {
    const name = String(err?.name || "");
    if (name === "ConditionalCheckFailedException") {
      return { ok: false, reason: REASON_CONDITION_FAILED };
    }
    return { ok: false, reason: REASON_DDB_ERROR };
  }
}

function emailFromAclSk(sk, prefix) {
  const raw = String(sk || "");
  if (!raw.startsWith(prefix)) return "";
  return normalizeEmail(raw.slice(prefix.length));
}

function uniqueKeys(keys) {
  const map = new Map();
  for (const key of keys) {
    if (!key?.PK || !key?.SK) continue;
    map.set(`${key.PK}\0${key.SK}`, { PK: key.PK, SK: key.SK });
  }
  return [...map.values()];
}

async function batchDeleteKeys(ddb, tableName, keys) {
  const list = uniqueKeys(keys);
  for (let i = 0; i < list.length; i += ACL_DELETE_BATCH) {
    let pending = list.slice(i, i + ACL_DELETE_BATCH);
    for (let attempt = 1; attempt <= ACL_DELETE_ATTEMPTS; attempt += 1) {
      try {
        const res = await ddb.send(
          new BatchWriteCommand({
            RequestItems: {
              [tableName]: pending.map((Key) => ({ DeleteRequest: { Key } })),
            },
          })
        );
        const leftover = (res.UnprocessedItems?.[tableName] || [])
          .map((row) => row.DeleteRequest?.Key)
          .filter(Boolean);
        if (!leftover.length) break;
        pending = leftover;
        if (attempt >= ACL_DELETE_ATTEMPTS) {
          return { ok: false, reason: REASON_DDB_ERROR };
        }
      } catch (err) {
        return { ok: false, reason: REASON_DDB_ERROR };
      }
    }
  }
  return { ok: true };
}

/**
 * Paginated, idempotent ACL cleanup. Not a single transaction.
 * Deletes project-side MEMBER/PROJECT_ADMIN items and matching user-side copies.
 */
async function deleteAllProjectAclRecords(ddb, tableName, projectId) {
  const table = trimId(tableName);
  const id = trimId(projectId);
  if (!ddb || typeof ddb.send !== "function" || !table || !id) {
    return { ok: false, reason: REASON_INVALID_IDENTITY };
  }
  let members;
  let admins;
  try {
    members = await queryPrefix(ddb, table, `PROJECT#${id}`, "MEMBER#");
    admins = await queryPrefix(ddb, table, `PROJECT#${id}`, "PROJECT_ADMIN#");
  } catch (err) {
    return { ok: false, reason: REASON_DDB_ERROR };
  }
  const keys = [];
  for (const item of members || []) {
    const email = emailFromAclSk(item.SK, "MEMBER#") || normalizeEmail(item.email);
    if (!email) continue;
    const pair = projectMemberKeys(id, email);
    keys.push(pair.projectSide, pair.userSide);
  }
  for (const item of admins || []) {
    const email = emailFromAclSk(item.SK, "PROJECT_ADMIN#") || normalizeEmail(item.email);
    if (!email) continue;
    const pair = projectAdminKeys(id, email);
    keys.push(pair.projectSide, pair.userSide);
  }
  const written = await batchDeleteKeys(ddb, table, keys);
  if (!written.ok) return written;
  return { ok: true, deleted: uniqueKeys(keys).length };
}

module.exports = {
  STATUS_REVOKED,
  TYPE_MEMBER,
  TYPE_ADMIN,
  MODE_CREATE,
  MODE_REACTIVATE,
  MODE_UPDATE_VISIBILITY,
  REASON_INVALID_IDENTITY,
  REASON_INVALID_TASK_VISIBILITY,
  REASON_CONDITION_FAILED,
  REASON_TX_CONFLICT,
  REASON_DDB_ERROR,
  resolveWriteTaskVisibility,
  getProjectMemberRecord,
  getProjectAdminRecord,
  putProjectMemberRecords,
  revokeProjectMemberRecords,
  deleteProjectMemberRecords,
  putProjectAdminRecords,
  revokeProjectAdminRecords,
  deleteProjectAdminRecords,
  createRestrictedProject,
  ensureRestrictedAdminCount,
  acquireDeletionLock,
  releaseDeletionLock,
  convertLockToDeleting,
  deletionLockStaleMs,
  deleteAllProjectAclRecords,
};

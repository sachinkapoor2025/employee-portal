const assert = require("assert");
const { GetCommand, QueryCommand, UpdateCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { projectMemberKeys, projectAdminKeys, VISIBILITY_ALL_PROJECT_TASKS, VISIBILITY_ASSIGNED_ONLY } = require("./projectAccess");
const persist = require("./projectAccessPersist");

const TABLE = "WorkTasks";
const PROJECT_ID = "proj-1";
const EMAIL = "Admin@MyDGV.com";
const NORM = "admin@mydgv.com";
const NOW = "2026-09-21T12:00:00.000Z";
const ACTOR = "super@mydgv.com";

function canceled(reasons) {
  const err = new Error("Transaction cancelled");
  err.name = "TransactionCanceledException";
  err.CancellationReasons = reasons;
  return err;
}

function mockDdb({ item, itemsByKey, error, onSend } = {}) {
  const calls = [];
  const ddb = {
    calls,
    async send(command) {
      calls.push(command);
      if (typeof onSend === "function") return onSend(command);
      if (error) throw error;
      if (command instanceof GetCommand) {
        const key = `${command.input.Key.PK}\0${command.input.Key.SK}`;
        if (itemsByKey && Object.prototype.hasOwnProperty.call(itemsByKey, key)) {
          const found = itemsByKey[key];
          return found ? { Item: found } : {};
        }
        return item ? { Item: item } : {};
      }
      if (command instanceof TransactWriteCommand) return {};
      throw new Error(`unexpected command ${command?.constructor?.name}`);
    },
  };
  return ddb;
}

function txItems(ddb) {
  assert.strictEqual(ddb.calls.length, 1);
  assert.ok(ddb.calls[0] instanceof TransactWriteCommand);
  return ddb.calls[0].input.TransactItems;
}

const memberKeys = projectMemberKeys(PROJECT_ID, EMAIL);
const adminKeys = projectAdminKeys(PROJECT_ID, EMAIL);

async function run() {
assert.strictEqual(
  (await persist.getProjectMemberRecord(null, TABLE, PROJECT_ID, EMAIL)).reason,
  persist.REASON_INVALID_IDENTITY
);
{
  const ddb = mockDdb();
  const res = await persist.getProjectMemberRecord(ddb, "", PROJECT_ID, EMAIL);
  assert.strictEqual(res.reason, persist.REASON_INVALID_IDENTITY);
  assert.strictEqual(ddb.calls.length, 0);
}
{
  const ddb = mockDdb();
  const res = await persist.putProjectMemberRecords(ddb, TABLE, {
    projectId: "  ",
    email: EMAIL,
    mode: "create",
  });
  assert.strictEqual(res.reason, persist.REASON_INVALID_IDENTITY);
  assert.strictEqual(ddb.calls.length, 0);
}
{
  const ddb = mockDdb();
  const res = await persist.getProjectAdminRecord(ddb, TABLE, PROJECT_ID, "   ");
  assert.strictEqual(res.reason, persist.REASON_INVALID_IDENTITY);
  assert.strictEqual(ddb.calls.length, 0);
}

{
  const stored = {
    PK: memberKeys.projectSide.PK,
    SK: memberKeys.projectSide.SK,
    type: "PROJECT_MEMBER",
    status: "ACTIVE",
    email: NORM,
    projectId: PROJECT_ID,
  };
  const ddb = mockDdb({ item: stored });
  const res = await persist.getProjectMemberRecord(ddb, TABLE, PROJECT_ID, EMAIL);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.item, stored);
  const cmd = ddb.calls[0];
  assert.ok(cmd instanceof GetCommand);
  assert.deepStrictEqual(cmd.input.Key, memberKeys.projectSide);
  assert.strictEqual(cmd.input.TableName, TABLE);
}

{
  const ddb = mockDdb({
    item: { PK: "CLIENT", SK: "CLIENT", type: "FORGED" },
  });
  const res = await persist.getProjectMemberRecord(ddb, TABLE, PROJECT_ID, EMAIL, {
    PK: "CLIENT",
    SK: "CLIENT",
    type: "FORGED",
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(ddb.calls[0].input.Key, memberKeys.projectSide);
}

{
  const ddb = mockDdb();
  const res = await persist.getProjectMemberRecord(ddb, TABLE, PROJECT_ID, EMAIL);
  assert.deepStrictEqual(res, { ok: true, item: null });
}

{
  const ddb = mockDdb({ error: Object.assign(new Error("boom"), { name: "TimeoutError" }) });
  const res = await persist.getProjectMemberRecord(ddb, TABLE, PROJECT_ID, EMAIL);
  assert.deepStrictEqual(res, { ok: false, reason: persist.REASON_DDB_ERROR });
}

{
  const stored = {
    ...adminKeys.projectSide,
    type: "PROJECT_ADMIN",
    status: "ACTIVE",
    taskVisibility: "ASSIGNED_ONLY",
  };
  const ddb = mockDdb({ item: stored });
  const res = await persist.getProjectAdminRecord(ddb, TABLE, PROJECT_ID, EMAIL);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.item, stored);
  assert.deepStrictEqual(ddb.calls[0].input.Key, adminKeys.projectSide);
}

{
  const userOnlyKey = `${adminKeys.userSide.PK}\0${adminKeys.userSide.SK}`;
  const ddb = mockDdb({
    itemsByKey: {
      [userOnlyKey]: { ...adminKeys.userSide, status: "ACTIVE", type: "PROJECT_ADMIN" },
    },
  });
  const res = await persist.getProjectAdminRecord(ddb, TABLE, PROJECT_ID, EMAIL);
  assert.deepStrictEqual(res, { ok: true, item: null });
  assert.deepStrictEqual(ddb.calls[0].input.Key, adminKeys.projectSide);
}

{
  const ddb = mockDdb();
  const res = await persist.putProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "create",
    PK: "forged",
    SK: "forged",
    type: "WRONG",
    members: ["x"],
    createdBy: ACTOR,
    lead: EMAIL,
    isAdmin: true,
    role: "SUPER_ADMIN",
  });
  assert.strictEqual(res.ok, true);
  const items = txItems(ddb);
  assert.strictEqual(items.length, 2);
  const puts = items.map((i) => i.Put);
  assert.ok(puts.every((p) => p && p.ConditionExpression === "attribute_not_exists(PK)"));
  assert.deepStrictEqual(puts[0].Item.PK, memberKeys.projectSide.PK);
  assert.deepStrictEqual(puts[0].Item.SK, memberKeys.projectSide.SK);
  assert.deepStrictEqual(puts[1].Item.PK, memberKeys.userSide.PK);
  assert.deepStrictEqual(puts[1].Item.SK, memberKeys.userSide.SK);
  for (const p of puts) {
    assert.strictEqual(p.Item.type, "PROJECT_MEMBER");
    assert.strictEqual(p.Item.status, "ACTIVE");
    assert.strictEqual(p.Item.email, NORM);
    assert.strictEqual(p.Item.projectId, PROJECT_ID);
    assert.strictEqual(p.Item.addedAt, NOW);
    assert.strictEqual(p.Item.addedBy, ACTOR);
    assert.strictEqual("taskVisibility" in p.Item, false);
  }
}

{
  const ddb = mockDdb();
  const res = await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "create",
    PK: "x",
    SK: "y",
  });
  assert.strictEqual(res.ok, true);
  const puts = txItems(ddb).map((i) => i.Put);
  assert.deepStrictEqual(
    { PK: puts[0].Item.PK, SK: puts[0].Item.SK },
    adminKeys.projectSide
  );
  assert.deepStrictEqual(
    { PK: puts[1].Item.PK, SK: puts[1].Item.SK },
    adminKeys.userSide
  );
  for (const p of puts) {
    assert.strictEqual(p.Item.type, "PROJECT_ADMIN");
    assert.strictEqual(p.Item.status, "ACTIVE");
    assert.strictEqual(p.Item.taskVisibility, VISIBILITY_ALL_PROJECT_TASKS);
    assert.strictEqual(p.ConditionExpression, "attribute_not_exists(PK)");
  }
}

{
  const ddb = mockDdb();
  const res = await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "create",
    taskVisibility: "assigned_only",
  });
  assert.strictEqual(res.ok, true);
  const puts = txItems(ddb).map((i) => i.Put);
  assert.ok(puts.every((p) => p.Item.taskVisibility === VISIBILITY_ASSIGNED_ONLY));
}

{
  const ddb = mockDdb();
  const res = await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "create",
    taskVisibility: "NOPE",
  });
  assert.deepStrictEqual(res, { ok: false, reason: persist.REASON_INVALID_TASK_VISIBILITY });
  assert.strictEqual(ddb.calls.length, 0);
}

{
  const ddb = mockDdb({
    error: canceled([
      { Code: "ConditionalCheckFailed", Message: "exists" },
      { Code: "None" },
    ]),
  });
  const res = await persist.putProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "create",
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, persist.REASON_CONDITION_FAILED);
  assert.strictEqual(res.cancellationReasons[0].Code, "ConditionalCheckFailed");
  assert.strictEqual(ddb.calls.length, 1);
}

{
  const ddb = mockDdb();
  const res = await persist.putProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "reactivate",
  });
  assert.strictEqual(res.ok, true);
  const updates = txItems(ddb).map((i) => i.Update);
  assert.strictEqual(updates.length, 2);
  for (const u of updates) {
    assert.ok(u.ConditionExpression.includes("#status = :revoked"));
    assert.ok(u.ConditionExpression.includes("attribute_exists(PK)"));
    assert.strictEqual(u.ExpressionAttributeValues[":active"], "ACTIVE");
    assert.ok(!u.UpdateExpression.includes("addedAt"));
  }
  assert.deepStrictEqual(updates[0].Key, memberKeys.projectSide);
  assert.deepStrictEqual(updates[1].Key, memberKeys.userSide);
}

{
  const ddb = mockDdb({
    error: canceled([{ Code: "ConditionalCheckFailed" }, { Code: "ConditionalCheckFailed" }]),
  });
  const res = await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "reactivate",
    taskVisibility: "ALL_PROJECT_TASKS",
  });
  assert.strictEqual(res.reason, persist.REASON_CONDITION_FAILED);
  assert.strictEqual(ddb.calls.length, 1);
}

{
  const ddb = mockDdb();
  await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "reactivate",
    taskVisibility: "ASSIGNED_ONLY",
  });
  const u = txItems(ddb)[0].Update;
  assert.strictEqual(u.ExpressionAttributeValues[":vis"], VISIBILITY_ASSIGNED_ONLY);
  assert.ok(u.UpdateExpression.includes("taskVisibility"));
  assert.ok(u.ConditionExpression.includes(":revoked"));
}

{
  const ddb = mockDdb();
  const res = await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "updateVisibility",
    taskVisibility: "assigned_only",
  });
  assert.strictEqual(res.ok, true);
  const updates = txItems(ddb).map((i) => i.Update);
  for (const u of updates) {
    assert.ok(u.ConditionExpression.includes("#status = :active"));
    assert.strictEqual(u.ExpressionAttributeValues[":vis"], VISIBILITY_ASSIGNED_ONLY);
    assert.ok(!u.UpdateExpression.includes("#status = :active,"));
  }
}

{
  const ddb = mockDdb();
  const res = await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    mode: "updateVisibility",
    taskVisibility: "BAD",
  });
  assert.strictEqual(res.reason, persist.REASON_INVALID_TASK_VISIBILITY);
  assert.strictEqual(ddb.calls.length, 0);
}

{
  const ddb = mockDdb();
  const res = await persist.revokeProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
  });
  assert.strictEqual(res.ok, true);
  const updates = txItems(ddb).map((i) => i.Update);
  for (const u of updates) {
    assert.strictEqual(u.ExpressionAttributeValues[":revoked"], "REVOKED");
    assert.ok(u.ConditionExpression.includes("#status = :active"));
  }
}

{
  const ddb = mockDdb({
    error: canceled([{ Code: "ConditionalCheckFailed" }, { Code: "None" }]),
  });
  const res = await persist.revokeProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
  });
  assert.strictEqual(res.reason, persist.REASON_CONDITION_FAILED);
  assert.strictEqual(ddb.calls.length, 1, "already-REVOKED is CONDITION_FAILED; no retry");
}

{
  const ddb = mockDdb();
  await persist.revokeProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
  });
  const updates = txItems(ddb).map((i) => i.Update);
  assert.deepStrictEqual(updates[0].Key, adminKeys.projectSide);
  assert.deepStrictEqual(updates[1].Key, adminKeys.userSide);
}

{
  const ddb = mockDdb({
    error: Object.assign(new Error("conflict"), { name: "TransactionConflictException" }),
  });
  const res = await persist.putProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    mode: "create",
    now: NOW,
    actorEmail: ACTOR,
  });
  assert.strictEqual(res.reason, persist.REASON_TX_CONFLICT);
  assert.strictEqual(ddb.calls.length, 1);
}

{
  const ddb = mockDdb();
  const res = await persist.deleteProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    PK: "nope",
    SK: "nope",
  });
  assert.strictEqual(res.ok, true);
  const dels = txItems(ddb).map((i) => i.Delete);
  assert.deepStrictEqual(dels[0].Key, memberKeys.projectSide);
  assert.deepStrictEqual(dels[1].Key, memberKeys.userSide);
  assert.ok(!dels[0].ConditionExpression, "missing copies are idempotent deletes");
}

{
  const ddb = mockDdb();
  await persist.deleteProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
  });
  const dels = txItems(ddb).map((i) => i.Delete);
  assert.deepStrictEqual(dels[0].Key, adminKeys.projectSide);
  assert.deepStrictEqual(dels[1].Key, adminKeys.userSide);
}

{
  const userOnlyKey = `${memberKeys.userSide.PK}\0${memberKeys.userSide.SK}`;
  const ddb = mockDdb({
    itemsByKey: {
      [userOnlyKey]: { ...memberKeys.userSide, status: "ACTIVE", type: "PROJECT_MEMBER" },
    },
  });
  const res = await persist.getProjectMemberRecord(ddb, TABLE, PROJECT_ID, EMAIL);
  assert.deepStrictEqual(res, { ok: true, item: null });
  assert.deepStrictEqual(ddb.calls[0].input.Key, memberKeys.projectSide);
}

{
  const ddb = mockDdb({
    error: Object.assign(new Error("boom"), { name: "TimeoutError" }),
  });
  const res = await persist.getProjectAdminRecord(ddb, TABLE, PROJECT_ID, EMAIL, {
    PK: "CLIENT",
    SK: "CLIENT",
    type: "FORGED",
  });
  assert.deepStrictEqual(res, { ok: false, reason: persist.REASON_DDB_ERROR });
  assert.deepStrictEqual(ddb.calls[0].input.Key, adminKeys.projectSide);
}

{
  const ddb = mockDdb({
    error: canceled([{ Code: "TransactionConflict", Message: "busy" }]),
  });
  const res = await persist.putProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    mode: "create",
    now: NOW,
    actorEmail: ACTOR,
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, persist.REASON_TX_CONFLICT);
  assert.strictEqual(res.cancellationReasons[0].Code, "TransactionConflict");
  assert.strictEqual(ddb.calls.length, 1);
}

{
  const ddb = mockDdb({
    error: canceled([{ Code: "ValidationError", Message: "bad" }]),
  });
  const res = await persist.putProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    mode: "create",
    now: NOW,
    actorEmail: ACTOR,
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, persist.REASON_DDB_ERROR);
  assert.strictEqual(res.cancellationReasons[0].Code, "ValidationError");
  assert.strictEqual(ddb.calls.length, 1);
}

{
  const ddb = mockDdb({ error: canceled([]) });
  const res = await persist.putProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    mode: "create",
    now: NOW,
    actorEmail: ACTOR,
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, persist.REASON_DDB_ERROR);
  assert.deepStrictEqual(res.cancellationReasons, []);
  assert.strictEqual(ddb.calls.length, 1);
}

{
  const ddb = mockDdb({
    error: canceled([{ Code: "ItemCollectionSizeLimitExceeded" }]),
  });
  const res = await persist.putProjectMemberRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    mode: "create",
    now: NOW,
    actorEmail: ACTOR,
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, persist.REASON_DDB_ERROR);
  assert.strictEqual(res.cancellationReasons[0].Code, "ItemCollectionSizeLimitExceeded");
  assert.strictEqual(ddb.calls.length, 1);
}

{
  const ddb = mockDdb();
  const res = await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    mode: "updateVisibility",
    actorEmail: ACTOR,
    now: NOW,
  });
  assert.deepStrictEqual(res, {
    ok: false,
    reason: persist.REASON_INVALID_TASK_VISIBILITY,
  });
  assert.strictEqual(ddb.calls.length, 0);
}
{
  const ddb = mockDdb();
  const res = await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    mode: "updateVisibility",
    taskVisibility: "   ",
    actorEmail: ACTOR,
    now: NOW,
  });
  assert.strictEqual(res.reason, persist.REASON_INVALID_TASK_VISIBILITY);
  assert.strictEqual(ddb.calls.length, 0);
}

{
  const ddb = mockDdb();
  const res = await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "reactivate",
  });
  assert.strictEqual(res.ok, true);
  const updates = txItems(ddb).map((i) => i.Update);
  assert.ok(updates.every((u) => u.ExpressionAttributeValues[":vis"] === VISIBILITY_ALL_PROJECT_TASKS));
}

{
  const src = require("fs").readFileSync(__filename.replace(/\.test\.js$/, ".js"), "utf8");
  assert.ok(!src.includes("isEligibleProjectAdmin"));
  assert.ok(!src.includes("user.isAdmin"));
  assert.ok(!src.includes("members[]"));
  assert.ok(!src.includes("canAccessRestrictedProject"));
  assert.strictEqual(persist.transactDualWrite, undefined, "transactDualWrite is not a public HTTP API");
}

{
  const ddb = mockDdb();
  const res = await persist.revokeProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    enforceAdminCount: true,
  });
  assert.strictEqual(res.ok, true);
  const items = txItems(ddb);
  assert.strictEqual(items.length, 3);
  assert.ok(items[0].Update.UpdateExpression.includes("ADD activeAdminCount :dec"));
  assert.ok(items[0].Update.ConditionExpression.includes("activeAdminCount > :min"));
  assert.deepStrictEqual(items[1].Update.Key, adminKeys.projectSide);
  assert.deepStrictEqual(items[2].Update.Key, adminKeys.userSide);
}

{
  const ddb = mockDdb();
  const res = await persist.putProjectAdminRecords(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    actorEmail: ACTOR,
    now: NOW,
    mode: "create",
    enforceAdminCount: true,
  });
  assert.strictEqual(res.ok, true);
  const items = txItems(ddb);
  assert.strictEqual(items.length, 3);
  assert.ok(items[0].Update.UpdateExpression.includes("ADD activeAdminCount :inc"));
  assert.ok(items[1].Put);
  assert.ok(items[2].Put);
}

{
  const catalog = {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${PROJECT_ID}`,
    projectId: PROJECT_ID,
    accessMode: "RESTRICTED",
  };
  const adminRow = {
    ...adminKeys.projectSide,
    email: NORM,
    status: "ACTIVE",
    type: "PROJECT_ADMIN",
    projectId: PROJECT_ID,
  };
  let storedCount;
  const ddb = mockDdb({
    onSend: async (command) => {
      if (command instanceof GetCommand) {
        return {
          Item: storedCount == null ? catalog : { ...catalog, activeAdminCount: storedCount },
        };
      }
      if (command instanceof QueryCommand) {
        assert.strictEqual(command.input.ConsistentRead, true);
        return { Items: [adminRow] };
      }
      if (command instanceof UpdateCommand) {
        assert.ok(command.input.ConditionExpression.includes("attribute_not_exists(activeAdminCount)"));
        storedCount = command.input.ExpressionAttributeValues[":n"];
        return {};
      }
      throw new Error(command.constructor.name);
    },
  });
  const res = await persist.ensureRestrictedAdminCount(ddb, TABLE, PROJECT_ID);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.initialized, true);
  assert.strictEqual(res.count, 1);
}

{
  const ddb = mockDdb({
    item: {
      PK: "ENTITY#PROJECT",
      SK: `PROJECT#${PROJECT_ID}`,
      projectId: PROJECT_ID,
      accessMode: "RESTRICTED",
      activeAdminCount: 3,
    },
  });
  const res = await persist.ensureRestrictedAdminCount(ddb, TABLE, PROJECT_ID);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 3);
  assert.ok(!ddb.calls.some((c) => c instanceof UpdateCommand));
  assert.ok(!ddb.calls.some((c) => c instanceof QueryCommand));
}

{
  let gets = 0;
  const ddb = mockDdb({
    onSend: async (command) => {
      if (command instanceof GetCommand) {
        gets += 1;
        if (gets === 1) {
          return {
            Item: {
              projectId: PROJECT_ID,
              accessMode: "RESTRICTED",
            },
          };
        }
        return {
          Item: {
            projectId: PROJECT_ID,
            accessMode: "RESTRICTED",
            activeAdminCount: 2,
          },
        };
      }
      if (command instanceof QueryCommand) {
        return { Items: [] };
      }
      if (command instanceof UpdateCommand) {
        const err = new Error("conditional");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      throw new Error(command.constructor.name);
    },
  });
  const res = await persist.ensureRestrictedAdminCount(ddb, TABLE, PROJECT_ID);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.raced, true);
  assert.strictEqual(res.count, 2);
  assert.notStrictEqual(res.count, 0);
}

{
  const ddb = mockDdb({
    item: { projectId: PROJECT_ID, accessMode: "OPEN" },
  });
  const res = await persist.ensureRestrictedAdminCount(ddb, TABLE, PROJECT_ID);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.skipped, true);
  assert.ok(!ddb.calls.some((c) => c instanceof QueryCommand));
}

{
  const ddb = mockDdb({
    onSend: async (command) => {
      if (command instanceof GetCommand) {
        throw Object.assign(new Error("boom"), { name: "TimeoutError" });
      }
      throw new Error(command.constructor.name);
    },
  });
  const res = await persist.ensureRestrictedAdminCount(ddb, TABLE, PROJECT_ID);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, persist.REASON_DDB_ERROR);
}

{
  const src = require("fs").readFileSync(__filename.replace(/\.test\.js$/, ".js"), "utf8");
  assert.ok(!src.includes("isEligibleProjectAdmin"));
  assert.ok(!src.includes("user.isAdmin"));
  assert.ok(!src.includes("members[]"));
  assert.ok(!src.includes("canAccessRestrictedProject"));
  assert.strictEqual(persist.transactDualWrite, undefined, "transactDualWrite is not a public HTTP API");
  const handlerSrc = require("fs").readFileSync(require("path").join(__dirname, "handler.js"), "utf8");
  assert.ok(!handlerSrc.includes("projectAccessPersist"));
}

{
  const catalog = {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${PROJECT_ID}`,
    projectId: PROJECT_ID,
  };
  function lockDdb() {
    const item = { ...catalog };
    return {
      item,
      async send(command) {
        if (!(command instanceof UpdateCommand)) {
          throw new Error(`unexpected ${command.constructor.name}`);
        }
        const expr = String(command.input.ConditionExpression || "");
        const values = command.input.ExpressionAttributeValues || {};
        const update = String(command.input.UpdateExpression || "");
        const deleting = String(item.deletionStatus || "").toUpperCase() === "DELETING";
        if (expr.includes("attribute_exists(PK)") && !item.PK) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        if (expr.includes("deletionStatus <> :deleting") && deleting) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        if (expr.includes("deletionLockId = :lockId") && item.deletionLockId !== values[":lockId"]) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        if (expr.includes("attribute_not_exists(deletionLockId)")) {
          const hasLock = Boolean(item.deletionLockId);
          if (expr.includes("deletionLockAt < :stale")) {
            const staleOk =
              !hasLock || String(item.deletionLockAt || "") < String(values[":stale"] || "");
            if (!staleOk) {
              const err = new Error("conditional");
              err.name = "ConditionalCheckFailedException";
              throw err;
            }
          } else if (hasLock) {
            const err = new Error("conditional");
            err.name = "ConditionalCheckFailedException";
            throw err;
          }
        }
        if (/SET deletionLockId/.test(update)) {
          item.deletionLockId = values[":lockId"];
          item.deletionLockAt = values[":now"];
        }
        if (/REMOVE deletionLockId/.test(update)) {
          delete item.deletionLockId;
          delete item.deletionLockAt;
        }
        if (/SET deletionStatus/.test(update)) {
          item.deletionStatus = values[":d"];
        }
        return {};
      },
    };
  }
  const first = lockDdb();
  const acquired = await persist.acquireDeletionLock(first, TABLE, PROJECT_ID, {
    lockId: "lock-a",
    now: NOW,
  });
  assert.strictEqual(acquired.ok, true);
  const stolen = await persist.acquireDeletionLock(first, TABLE, PROJECT_ID, {
    lockId: "lock-b",
    now: "2026-09-21T12:00:01.000Z",
  });
  assert.strictEqual(stolen.ok, false);
  assert.strictEqual(first.item.deletionLockId, "lock-a");
  const wrongRelease = await persist.releaseDeletionLock(
    first,
    TABLE,
    PROJECT_ID,
    "lock-other"
  );
  assert.strictEqual(wrongRelease.ok, false);
  assert.strictEqual(first.item.deletionLockId, "lock-a");
  const recovered = await persist.acquireDeletionLock(first, TABLE, PROJECT_ID, {
    lockId: "lock-c",
    now: "2026-09-21T12:05:00.000Z",
    staleMs: 1000,
  });
  assert.strictEqual(recovered.ok, true);
  assert.strictEqual(first.item.deletionLockId, "lock-c");
}

{
  const ddb = mockDdb();
  const res = await persist.createRestrictedProject(ddb, TABLE, {
    projectId: PROJECT_ID,
    email: EMAIL,
    now: NOW,
    actorEmail: ACTOR,
    catalog: { name: "Restricted" },
    members: [{ email: "  Member@MyDGV.com " }, "member@mydgv.com", EMAIL],
  });
  assert.strictEqual(res.ok, true);
  const items = txItems(ddb);
  assert.strictEqual(items.length, 5);
  assert.strictEqual(items[0].Put.Item.accessMode, "RESTRICTED");
  assert.strictEqual(items[0].Put.Item.activeAdminCount, 1);
  assert.strictEqual(items[3].Put.Item.SK, "MEMBER#member@mydgv.com");
  assert.strictEqual(items[3].Put.Item.status, "ACTIVE");
  assert.strictEqual(items[3].Put.Item.addedBy, ACTOR);
  assert.strictEqual(items[4].Put.Item.PK, "USER#member@mydgv.com");
  assert.strictEqual(items[4].Put.Item.SK, `PROJECT_MEMBER#${PROJECT_ID}`);
}

console.log("project access persist tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

const assert = require("assert");
const {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { handleDeleteProject, handleListProjects, getProject } = require("./projectManage");
const {
  handleProjectAccess,
  ACTION_REVOKE_ADMIN,
  ACTION_ADD_ADMIN,
  ACTION_LIST,
} = require("./projectAccessManage");
const persist = require("./projectAccessPersist");
const { authorizeTaskRead, createCache } = require("./taskReadAccess");
const { projectMemberKeys, projectAdminKeys } = require("./projectAccess");

const TABLE = "work-table";
const ACCESS = "access-table";
const OPEN_ID = "open-del";
const REST_ID = "rest-del";
const ADMIN = { email: "admin@mydgv.com", isAdmin: true };
const PA2 = { email: "pa2@mydgv.com", isAdmin: true };

function accessRow(email, role, status) {
  const e = String(email).trim().toLowerCase();
  return { PK: e, SK: e, email: e, role, status };
}

function catalog(projectId, extra = {}) {
  return {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${projectId}`,
    projectId,
    name: extra.name || projectId,
    accessMode: extra.accessMode,
    activeAdminCount: extra.activeAdminCount,
    deletionStatus: extra.deletionStatus,
  };
}

function pair(kind, projectId, email, extra = {}) {
  const keys = kind === "admin" ? projectAdminKeys(projectId, email) : projectMemberKeys(projectId, email);
  const base = {
    type: kind === "admin" ? "PROJECT_ADMIN" : "PROJECT_MEMBER",
    projectId,
    email: email.trim().toLowerCase(),
    status: extra.status || "ACTIVE",
    taskVisibility: extra.taskVisibility,
  };
  return [
    { TableName: TABLE, Item: { ...keys.projectSide, ...base } },
    { TableName: TABLE, Item: { ...keys.userSide, ...base } },
  ];
}

function mockStore(seedItems) {
  const items = seedItems.map((row) => ({ TableName: row.TableName, Item: { ...row.Item } }));
  const calls = [];

  function find(TableName, Key) {
    return items.find(
      (row) => row.TableName === TableName && row.Item.PK === Key.PK && row.Item.SK === Key.SK
    );
  }

  function remove(TableName, Key) {
    const idx = items.findIndex(
      (row) => row.TableName === TableName && row.Item.PK === Key.PK && row.Item.SK === Key.SK
    );
    if (idx >= 0) items.splice(idx, 1);
  }

  function applyTransact(ops) {
    for (const op of ops) {
      if (op.Update) {
        const { Key, ConditionExpression = "", UpdateExpression = "", ExpressionAttributeValues = {}, TableName } =
          op.Update;
        const row = find(TableName || TABLE, Key);
        if (!row && ConditionExpression.includes("attribute_exists")) {
          const err = new Error("conditional");
          err.name = "TransactionCanceledException";
          err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
          throw err;
        }
        if (UpdateExpression.includes("ADD activeAdminCount :dec")) {
          if (!(Number(row.Item.activeAdminCount) > 1)) {
            const err = new Error("conditional");
            err.name = "TransactionCanceledException";
            err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
            throw err;
          }
        }
        if (UpdateExpression.includes("#status = :active") && ConditionExpression.includes("#status = :revoked")) {
          if (row.Item.status !== "REVOKED") {
            const err = new Error("conditional");
            err.name = "TransactionCanceledException";
            err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
            throw err;
          }
        }
        if (UpdateExpression.includes("#status = :revoked") && ConditionExpression.includes("#status = :active")) {
          if (row.Item.status !== "ACTIVE") {
            const err = new Error("conditional");
            err.name = "TransactionCanceledException";
            err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
            throw err;
          }
        }
      }
      if (op.Put && op.Put.ConditionExpression && op.Put.ConditionExpression.includes("attribute_not_exists")) {
        if (find(op.Put.TableName || TABLE, { PK: op.Put.Item.PK, SK: op.Put.Item.SK })) {
          const err = new Error("conditional");
          err.name = "TransactionCanceledException";
          err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
          throw err;
        }
      }
    }
    for (const op of ops) {
      if (op.Put) {
        const { TableName, Item } = op.Put;
        const idx = items.findIndex(
          (row) => row.TableName === TableName && row.Item.PK === Item.PK && row.Item.SK === Item.SK
        );
        if (idx >= 0) items[idx] = { TableName, Item: { ...Item } };
        else items.push({ TableName, Item: { ...Item } });
      }
      if (op.Update) {
        const { TableName, Key, UpdateExpression = "", ExpressionAttributeValues = {} } = op.Update;
        const row = find(TableName, Key);
        if (UpdateExpression.includes("ADD activeAdminCount :dec")) {
          row.Item.activeAdminCount = Number(row.Item.activeAdminCount) - 1;
        }
        if (UpdateExpression.includes("ADD activeAdminCount :inc")) {
          row.Item.activeAdminCount = Number(row.Item.activeAdminCount) + 1;
        }
        if (UpdateExpression.includes("#status = :revoked")) {
          row.Item.status = ExpressionAttributeValues[":revoked"];
        }
        if (UpdateExpression.includes("#status = :active")) {
          row.Item.status = ExpressionAttributeValues[":active"];
        }
        if (UpdateExpression.includes("taskVisibility = :vis")) {
          row.Item.taskVisibility = ExpressionAttributeValues[":vis"];
        }
        if (UpdateExpression.includes("deletionStatus")) {
          row.Item.deletionStatus = ExpressionAttributeValues[":d"];
        }
      }
      if (op.Delete) {
        remove(op.Delete.TableName, op.Delete.Key);
      }
    }
  }

  return {
    calls,
    items,
    failBatch: false,
    failAccessGet: false,
    async send(command) {
      calls.push(command);
      const name = command.constructor.name;
      if (name === "GetCommand" || command instanceof GetCommand) {
        if (this.failAccessGet && command.input.TableName === ACCESS) {
          throw new Error("simulated user access lookup failure");
        }
        const found = find(command.input.TableName, command.input.Key);
        return { Item: found ? { ...found.Item } : undefined };
      }
      if (name === "QueryCommand" || command instanceof QueryCommand) {
        const { TableName, ExpressionAttributeValues = {} } = command.input;
        const pk = ExpressionAttributeValues[":pk"];
        const skPrefix = ExpressionAttributeValues[":sk"];
        return {
          Items: items
            .filter((row) => row.TableName === TableName && row.Item.PK === pk)
            .filter((row) => (skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true))
            .map((row) => ({ ...row.Item })),
        };
      }
      if (name === "UpdateCommand" || command instanceof UpdateCommand) {
        const { TableName, Key, UpdateExpression = "", ExpressionAttributeValues = {}, ConditionExpression = "" } =
          command.input;
        const row = find(TableName, Key);
        if (!row) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        if (
          ConditionExpression.includes("attribute_not_exists(activeAdminCount)") &&
          row.Item.activeAdminCount != null
        ) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        if (
          ConditionExpression.includes("deletionStatus <> :deleting") &&
          String(row.Item.deletionStatus || "").toUpperCase() === "DELETING"
        ) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        if (ConditionExpression.includes("attribute_not_exists(deletionLockId)")) {
          const hasLock = Boolean(row.Item.deletionLockId);
          if (ConditionExpression.includes("deletionLockAt < :stale")) {
            const staleOk =
              !hasLock ||
              String(row.Item.deletionLockAt || "") <
                String(ExpressionAttributeValues[":stale"] || "");
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
        if (
          ConditionExpression.includes("deletionLockId = :lockId") &&
          row.Item.deletionLockId !== ExpressionAttributeValues[":lockId"]
        ) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        if (UpdateExpression.includes("deletionLockId = :lockId")) {
          row.Item.deletionLockId = ExpressionAttributeValues[":lockId"];
          row.Item.deletionLockAt = ExpressionAttributeValues[":now"];
        }
        if (UpdateExpression.includes("deletionStatus")) {
          row.Item.deletionStatus = ExpressionAttributeValues[":d"];
          if (ExpressionAttributeValues[":now"]) {
            row.Item.deletionStartedAt = ExpressionAttributeValues[":now"];
          }
        }
        if (/REMOVE deletionLockId/.test(UpdateExpression)) {
          delete row.Item.deletionLockId;
          delete row.Item.deletionLockAt;
        }
        if (Object.prototype.hasOwnProperty.call(ExpressionAttributeValues, ":n")) {
          row.Item.activeAdminCount = ExpressionAttributeValues[":n"];
        }
        return {};
      }
      if (name === "PutCommand" || command instanceof PutCommand) {
        items.push({ TableName: command.input.TableName, Item: { ...command.input.Item } });
        return {};
      }
      if (name === "DeleteCommand" || command instanceof DeleteCommand) {
        remove(command.input.TableName, command.input.Key);
        return {};
      }
      if (name === "BatchWriteCommand" || command instanceof BatchWriteCommand) {
        if (this.failBatch) throw new Error("batch failed");
        const tableName = Object.keys(command.input.RequestItems || {})[0];
        for (const req of command.input.RequestItems[tableName] || []) {
          if (req.DeleteRequest?.Key) remove(tableName, req.DeleteRequest.Key);
        }
        return { UnprocessedItems: {} };
      }
      if (name === "TransactWriteCommand" || command instanceof TransactWriteCommand) {
        applyTransact(command.input.TransactItems || []);
        return {};
      }
      throw new Error(name);
    },
  };
}

function seedRestricted() {
  return [
    { TableName: TABLE, Item: catalog(OPEN_ID, { accessMode: "OPEN", name: "Open" }) },
    {
      TableName: TABLE,
      Item: catalog(REST_ID, { accessMode: "RESTRICTED", name: "Secret", activeAdminCount: 1 }),
    },
    { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
    { TableName: ACCESS, Item: accessRow(PA2.email, "ADMIN", "ACTIVE") },
    ...pair("admin", REST_ID, ADMIN.email, { taskVisibility: "ALL_PROJECT_TASKS" }),
    ...pair("member", REST_ID, "rahul@mydgv.com"),
  ];
}

function deleteCall(ddb, extra = {}) {
  return handleDeleteProject({
    user: ADMIN,
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    ...extra,
  });
}

async function run() {
  {
    const ddb = mockStore(seedRestricted());
    const res = await deleteCall(ddb, {
      projectId: REST_ID,
      body: { name: "Secret" },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(await getProject(ddb, TABLE, REST_ID), null);
    const leftover = ddb.items.filter(
      (row) =>
        row.TableName === TABLE &&
        (String(row.Item.SK).startsWith("MEMBER#") ||
          String(row.Item.SK).startsWith("PROJECT_ADMIN#") ||
          String(row.Item.SK).startsWith("PROJECT_MEMBER#") ||
          (String(row.Item.PK).startsWith("USER#") && String(row.Item.SK).includes(REST_ID)))
    );
    assert.strictEqual(leftover.length, 0);
  }

  {
    const ddb = mockStore([
      { TableName: TABLE, Item: catalog(OPEN_ID, { accessMode: "OPEN", name: "Open" }) },
      { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
      ...pair("member", OPEN_ID, "rahul@mydgv.com"),
    ]);
    const res = await deleteCall(ddb, {
      projectId: OPEN_ID,
      body: { name: "Open" },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!ddb.items.some((row) => String(row.Item.SK) === "MEMBER#rahul@mydgv.com"));
    assert.ok(!ddb.items.some((row) => String(row.Item.SK) === `PROJECT_MEMBER#${OPEN_ID}`));
  }

  {
    const ddb = mockStore(seedRestricted());
    ddb.failBatch = true;
    const res = await deleteCall(ddb, {
      projectId: REST_ID,
      body: { name: "Secret" },
    });
    assert.strictEqual(res.statusCode, 500);
    const project = await getProject(ddb, TABLE, REST_ID);
    assert.strictEqual(project.deletionStatus, "DELETING");
    ddb.failBatch = false;
    const retry = await deleteCall(ddb, {
      projectId: REST_ID,
      body: { name: "Secret" },
    });
    assert.strictEqual(retry.statusCode, 200);
    assert.strictEqual(await getProject(ddb, TABLE, REST_ID), null);
  }

  {
    const ddb = mockStore(seedRestricted());
    const missing = await deleteCall(ddb, {
      projectId: "no-such",
      body: { name: "Secret" },
    });
    assert.strictEqual(missing.statusCode, 404);
  }

  {
    const ddb = mockStore(seedRestricted());
    const last = await handleProjectAccess({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: ADMIN,
      projectId: REST_ID,
      access: { action: ACTION_REVOKE_ADMIN, email: ADMIN.email },
    });
    assert.strictEqual(last.statusCode, 409);
    const catalogItem = ddb.items.find((r) => r.Item.projectId === REST_ID && r.Item.PK === "ENTITY#PROJECT");
    assert.strictEqual(catalogItem.Item.activeAdminCount, 1);
  }

  {
    const seeded = seedRestricted();
    seeded[1].Item.activeAdminCount = 2;
    seeded.push(...pair("admin", REST_ID, PA2.email, { taskVisibility: "ASSIGNED_ONLY" }));
    const ddb = mockStore(seeded);
    const first = await handleProjectAccess({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: ADMIN,
      projectId: REST_ID,
      access: { action: ACTION_REVOKE_ADMIN, email: ADMIN.email },
    });
    assert.strictEqual(first.statusCode, 200);
    const second = await handleProjectAccess({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: PA2,
      projectId: REST_ID,
      access: { action: ACTION_REVOKE_ADMIN, email: PA2.email },
    });
    assert.strictEqual(second.statusCode, 409);
    const catalogItem = ddb.items.find((r) => r.Item.projectId === REST_ID && r.Item.PK === "ENTITY#PROJECT");
    assert.strictEqual(catalogItem.Item.activeAdminCount, 1);
  }

  {
    const ddb = mockStore(seedRestricted());
    const added = await handleProjectAccess({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: ADMIN,
      projectId: REST_ID,
      access: { action: ACTION_ADD_ADMIN, email: PA2.email },
    });
    assert.strictEqual(added.statusCode, 200);
    const catalogItem = ddb.items.find((r) => r.Item.projectId === REST_ID && r.Item.PK === "ENTITY#PROJECT");
    assert.strictEqual(catalogItem.Item.activeAdminCount, 2);
  }

  {
    const ddb = mockStore([
      { TableName: TABLE, Item: catalog(REST_ID, { accessMode: "RESTRICTED", deletionStatus: "DELETING" }) },
      { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
      ...pair("admin", REST_ID, ADMIN.email, { taskVisibility: "ALL_PROJECT_TASKS" }),
    ]);
    const listed = await handleListProjects({
      ddb,
      tableName: TABLE,
      user: ADMIN,
      accessTable: ACCESS,
    });
    assert.ok(!listed.body.some((p) => p.projectId === REST_ID));
    const read = await authorizeTaskRead({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: ADMIN,
      task: { taskId: "t1", projectId: REST_ID, assignee: ADMIN.email, assignees: [ADMIN.email] },
      cache: createCache(),
    });
    assert.strictEqual(read.allowed, false);
    const access = await handleProjectAccess({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: ADMIN,
      projectId: REST_ID,
      access: { action: ACTION_LIST },
    });
    assert.strictEqual(access.statusCode, 404);
  }

  {
    const ddb = mockStore([
      { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
      ...pair("admin", REST_ID, ADMIN.email, { taskVisibility: "ALL_PROJECT_TASKS" }),
      ...pair("member", REST_ID, "rahul@mydgv.com"),
    ]);
    const stale = await authorizeTaskRead({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: ADMIN,
      task: { taskId: "t1", projectId: REST_ID, assignee: ADMIN.email, assignees: [ADMIN.email] },
      cache: createCache(),
    });
    assert.strictEqual(stale.allowed, false);
  }

  {
    const cleaned = await persist.deleteAllProjectAclRecords(
      mockStore(seedRestricted()),
      TABLE,
      REST_ID
    );
    assert.strictEqual(cleaned.ok, true);
  }

  {
    const seeded = seedRestricted();
    seeded.push({
      TableName: TABLE,
      Item: {
        PK: `PROJECT#${REST_ID}`,
        SK: "TASK#keep-1",
        taskId: "keep-1",
        projectId: REST_ID,
      },
    });
    const ddb = mockStore(seeded);
    const beforeAcl = ddb.items.filter(
      (row) =>
        String(row.Item.SK).startsWith("MEMBER#") ||
        String(row.Item.SK).startsWith("PROJECT_ADMIN#") ||
        String(row.Item.SK).startsWith("PROJECT_MEMBER#")
    ).length;
    const res = await deleteCall(ddb, {
      projectId: REST_ID,
      body: { name: "Secret" },
    });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, "PROJECT_HAS_TASKS");
    const project = await getProject(ddb, TABLE, REST_ID);
    assert.ok(project);
    assert.notStrictEqual(project.deletionStatus, "DELETING");
    assert.ok(ddb.items.some((row) => row.Item.taskId === "keep-1"));
    const afterAcl = ddb.items.filter(
      (row) =>
        String(row.Item.SK).startsWith("MEMBER#") ||
        String(row.Item.SK).startsWith("PROJECT_ADMIN#") ||
        String(row.Item.SK).startsWith("PROJECT_MEMBER#")
    ).length;
    assert.strictEqual(afterAcl, beforeAcl);
  }

  {
    const seeded = [
      {
        TableName: TABLE,
        Item: catalog(REST_ID, { accessMode: "RESTRICTED", name: "Secret" }),
      },
      { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
      ...pair("admin", REST_ID, ADMIN.email, { taskVisibility: "ALL_PROJECT_TASKS" }),
    ];
    const ddb = mockStore(seeded);
    const last = await handleProjectAccess({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: ADMIN,
      projectId: REST_ID,
      access: { action: ACTION_REVOKE_ADMIN, email: ADMIN.email },
    });
    assert.strictEqual(last.statusCode, 409);
    const cat = ddb.items.find((r) => r.Item.PK === "ENTITY#PROJECT" && r.Item.projectId === REST_ID);
    assert.strictEqual(cat.Item.activeAdminCount, 1);
  }

  {
    const ddb = mockStore([
      { TableName: TABLE, Item: catalog(OPEN_ID, { accessMode: "OPEN", name: "Open" }) },
      { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
      { TableName: ACCESS, Item: accessRow(PA2.email, "ADMIN", "ACTIVE") },
    ]);
    const res = await handleProjectAccess({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: ADMIN,
      projectId: OPEN_ID,
      access: { action: ACTION_ADD_ADMIN, email: PA2.email },
    });
    assert.strictEqual(res.statusCode, 200);
    const tx = ddb.calls.find((c) => c instanceof TransactWriteCommand);
    assert.ok(tx);
    assert.strictEqual(tx.input.TransactItems.length, 2);
    assert.ok(tx.input.TransactItems.every((item) => !item.Update));
  }

  {
    const ddb = mockStore([
      { TableName: TABLE, Item: catalog(REST_ID, { accessMode: "RESTRICTED", name: "Secret" }) },
      { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
    ]);
    const res = await deleteCall(ddb, {
      projectId: REST_ID,
      body: { name: "Secret" },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(await getProject(ddb, TABLE, REST_ID), null);
  }

  {
    const ddb = mockStore([
      { TableName: TABLE, Item: catalog(REST_ID, { accessMode: "RESTRICTED", name: "Secret" }) },
      { TableName: ACCESS, Item: accessRow("super@mydgv.com", "SUPER_ADMIN", "ACTIVE") },
    ]);
    const res = await deleteCall(ddb, {
      user: { email: "super@mydgv.com", isAdmin: true },
      projectId: REST_ID,
      body: { name: "Secret" },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(await getProject(ddb, TABLE, REST_ID), null);
  }

  {
    const ddb = mockStore([
      { TableName: TABLE, Item: catalog(OPEN_ID, { accessMode: "OPEN", name: "Open" }) },
      { TableName: ACCESS, Item: accessRow("manager@mydgv.com", "MANAGER", "ACTIVE") },
    ]);
    const res = await deleteCall(ddb, {
      user: { email: "manager@mydgv.com", isAdmin: true },
      projectId: OPEN_ID,
      body: { name: "Open" },
    });
    assert.strictEqual(res.statusCode, 403);
    const project = await getProject(ddb, TABLE, OPEN_ID);
    assert.notStrictEqual(project.deletionStatus, "DELETING");
  }

  {
    const ddb = mockStore([
      { TableName: TABLE, Item: catalog(OPEN_ID, { accessMode: "OPEN", name: "Open" }) },
    ]);
    const res = await deleteCall(ddb, {
      user: { email: ADMIN.email, isAdmin: true },
      projectId: OPEN_ID,
      body: { name: "Open" },
    });
    assert.strictEqual(res.statusCode, 403);
  }

  {
    const ddb = mockStore([
      { TableName: TABLE, Item: catalog(OPEN_ID, { accessMode: "OPEN", name: "Open" }) },
      { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
    ]);
    ddb.failAccessGet = true;
    const res = await deleteCall(ddb, {
      projectId: OPEN_ID,
      body: { name: "Open" },
    });
    assert.strictEqual(res.statusCode, 500);
    const project = await getProject(ddb, TABLE, OPEN_ID);
    assert.ok(project);
    assert.notStrictEqual(project.deletionStatus, "DELETING");
  }

  {
    const ddb = mockStore(seedRestricted());
    ddb.failBatch = true;
    const first = await deleteCall(ddb, {
      projectId: REST_ID,
      body: { name: "Secret" },
    });
    assert.strictEqual(first.statusCode, 500);
    const denied = await deleteCall(ddb, {
      user: { email: "manager@mydgv.com", isAdmin: true },
      projectId: REST_ID,
      body: { name: "Secret" },
    });
    assert.strictEqual(denied.statusCode, 403);
    assert.strictEqual((await getProject(ddb, TABLE, REST_ID)).deletionStatus, "DELETING");
    const noName = await deleteCall(ddb, {
      projectId: REST_ID,
      body: {},
    });
    assert.strictEqual(noName.statusCode, 400);
  }

  {
    const ddb = mockStore([
      { TableName: TABLE, Item: catalog(REST_ID, { accessMode: "RESTRICTED", name: "Secret" }) },
      { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
      {
        TableName: TABLE,
        Item: {
          PK: "ENTITY#TASK",
          SK: "TASK#canon-1",
          taskId: "canon-1",
          projectId: REST_ID,
        },
      },
    ]);
    const before = ddb.items.length;
    const res = await deleteCall(ddb, {
      projectId: REST_ID,
      body: { name: "Secret" },
    });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, "PROJECT_HAS_TASKS");
    assert.strictEqual(ddb.items.length, before);
    assert.notStrictEqual((await getProject(ddb, TABLE, REST_ID)).deletionStatus, "DELETING");
  }

  {
    const ddb = mockStore([
      { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
    ]);
    const before = ddb.items.length;
    const missing = await deleteCall(ddb, {
      projectId: REST_ID,
      body: { name: "Secret" },
    });
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(ddb.items.length, before);
  }

  console.log("project ACL integrity tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

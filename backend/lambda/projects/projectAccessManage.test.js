const assert = require("assert");
const {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  handleProjectAccess,
  ACTION_LIST,
  ACTION_ADD_MEMBER,
  ACTION_REVOKE_MEMBER,
  ACTION_REACTIVATE_MEMBER,
  ACTION_ADD_ADMIN,
  ACTION_REVOKE_ADMIN,
  ACTION_REACTIVATE_ADMIN,
  ACTION_UPDATE_VISIBILITY,
} = require("./projectAccessManage");
const { handlePatchProject } = require("./projectManage");
const { projectMemberKeys, projectAdminKeys } = require("./projectAccess");

const TABLE = "work-table";
const ACCESS = "access-table";
const OPEN_ID = "open-1";
const REST_ID = "rest-1";
const NOW = "2026-09-21T18:00:00.000Z";

const ADMIN = { email: "  Admin@MyDGV.com ", isAdmin: true };
const SUPER = { email: "super@mydgv.com", isAdmin: true };
const PA2 = { email: "pa2@mydgv.com", isAdmin: true };
const MGR = { email: "mgr@mydgv.com", isAdmin: true };
const EMP = { email: "rahul@mydgv.com", isAdmin: false };
const OUTSIDER = { email: "outsider@mydgv.com", isAdmin: true };

function accessRow(email, role, status) {
  const e = String(email).trim().toLowerCase();
  return { PK: e, SK: e, email: e, role, status };
}

function projectItem(projectId, extra = {}) {
  return {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${projectId}`,
    projectId,
    name: projectId,
    client: "DGV",
    members: ["legacy@mydgv.com"],
    createdBy: "creator@mydgv.com",
    lead: "lead@mydgv.com",
    ...extra,
  };
}

function memberPair(projectId, email, status = "ACTIVE") {
  const e = email.trim().toLowerCase();
  const keys = projectMemberKeys(projectId, e);
  const base = {
    type: "PROJECT_MEMBER",
    projectId,
    email: e,
    status,
    addedAt: NOW,
  };
  return [
    { TableName: TABLE, Item: { ...keys.projectSide, ...base } },
    { TableName: TABLE, Item: { ...keys.userSide, ...base } },
  ];
}

function adminPair(projectId, email, extra = {}) {
  const e = email.trim().toLowerCase();
  const keys = projectAdminKeys(projectId, e);
  const base = {
    type: "PROJECT_ADMIN",
    projectId,
    email: e,
    status: extra.status || "ACTIVE",
    taskVisibility: extra.taskVisibility,
    addedAt: NOW,
  };
  return [
    { TableName: TABLE, Item: { ...keys.projectSide, ...base } },
    { TableName: TABLE, Item: { ...keys.userSide, ...base } },
  ];
}

function mockDdb(seedItems, { failGet, failQuery, failTx, txError, skipApply } = {}) {
  const items = seedItems.map((row) => ({ TableName: row.TableName, Item: { ...row.Item } }));
  const calls = [];
  return {
    calls,
    items,
    async send(command) {
      calls.push(command);
      const name = command.constructor.name;
      if (failGet && (name === "GetCommand" || command instanceof GetCommand)) {
        throw new Error("get failed");
      }
      if (failQuery && (name === "QueryCommand" || command instanceof QueryCommand)) {
        throw new Error("query failed");
      }
      if (name === "UpdateCommand" || command instanceof UpdateCommand) {
        const { TableName, Key, UpdateExpression = "", ExpressionAttributeValues = {}, ConditionExpression = "" } =
          command.input;
        const row = items.find(
          (r) => r.TableName === TableName && r.Item.PK === Key.PK && r.Item.SK === Key.SK
        );
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
        if (Object.prototype.hasOwnProperty.call(ExpressionAttributeValues, ":n")) {
          row.Item.activeAdminCount = ExpressionAttributeValues[":n"];
        }
        return {};
      }
      if (name === "GetCommand" || command instanceof GetCommand) {
        const { TableName, Key } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
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
      if (name === "TransactWriteCommand" || command instanceof TransactWriteCommand) {
        if (failTx) {
          const err = txError || new Error("tx failed");
          throw err;
        }
        if (skipApply) return {};
        for (const op of command.input.TransactItems || []) {
          if (op.Put) {
            const { TableName, Item, ConditionExpression } = op.Put;
            const idx = items.findIndex(
              (row) =>
                row.TableName === TableName &&
                row.Item.PK === Item.PK &&
                row.Item.SK === Item.SK
            );
            if (ConditionExpression && ConditionExpression.includes("attribute_not_exists") && idx >= 0) {
              const err = new Error("conditional");
              err.name = "TransactionCanceledException";
              err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
              throw err;
            }
            if (idx >= 0) items[idx] = { TableName, Item: { ...Item } };
            else items.push({ TableName, Item: { ...Item } });
          }
          if (op.Update) {
            const { TableName, Key, ExpressionAttributeValues = {}, UpdateExpression = "" } =
              op.Update;
            const row = items.find(
              (r) => r.TableName === TableName && r.Item.PK === Key.PK && r.Item.SK === Key.SK
            );
            if (!row) {
              const err = new Error("conditional");
              err.name = "TransactionCanceledException";
              err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
              throw err;
            }
            if (UpdateExpression.includes("#status = :revoked")) {
              row.Item.status = ExpressionAttributeValues[":revoked"];
            } else if (UpdateExpression.includes("#status = :active")) {
              row.Item.status = ExpressionAttributeValues[":active"];
            }
            if (UpdateExpression.includes("taskVisibility = :vis")) {
              row.Item.taskVisibility = ExpressionAttributeValues[":vis"];
            }
            if (UpdateExpression.includes("ADD activeAdminCount :dec")) {
              if (!(Number(row.Item.activeAdminCount) > 1)) {
                const err = new Error("conditional");
                err.name = "TransactionCanceledException";
                err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
                throw err;
              }
              row.Item.activeAdminCount = Number(row.Item.activeAdminCount) - 1;
            } else if (UpdateExpression.includes("ADD activeAdminCount :inc")) {
              if (row.Item.activeAdminCount == null) {
                const err = new Error("conditional");
                err.name = "TransactionCanceledException";
                err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
                throw err;
              }
              row.Item.activeAdminCount = Number(row.Item.activeAdminCount) + 1;
            }
          }
        }
        return {};
      }
      throw new Error(name);
    },
  };
}

function seedBase() {
  return [
    { TableName: TABLE, Item: projectItem(OPEN_ID, { accessMode: "OPEN" }) },
    { TableName: TABLE, Item: projectItem(REST_ID, { accessMode: "RESTRICTED", activeAdminCount: 1 }) },
    { TableName: ACCESS, Item: accessRow(ADMIN.email, "ADMIN", "ACTIVE") },
    { TableName: ACCESS, Item: accessRow(SUPER.email, "SUPER_ADMIN", "ACTIVE") },
    { TableName: ACCESS, Item: accessRow(PA2.email, "ADMIN", "ACTIVE") },
    { TableName: ACCESS, Item: accessRow(MGR.email, "MANAGER", "ACTIVE") },
    { TableName: ACCESS, Item: accessRow(EMP.email, "EMPLOYEE", "ACTIVE") },
    { TableName: ACCESS, Item: accessRow(OUTSIDER.email, "ADMIN", "ACTIVE") },
    ...adminPair(REST_ID, ADMIN.email, { taskVisibility: "ALL_PROJECT_TASKS" }),
  ];
}

function call(ddb, extra = {}) {
  return handleProjectAccess({
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    now: NOW,
    user: extra.user || ADMIN,
    projectId: extra.projectId || REST_ID,
    access: extra.access || { action: ACTION_LIST },
  });
}

async function run() {
  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, { access: { action: ACTION_LIST } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.accessMode, "RESTRICTED");
    assert.ok(res.body.projectAdmins.some((a) => a.email === "admin@mydgv.com" && a.active));
    assert.ok(!res.body.members.some((m) => m.email === "legacy@mydgv.com"));
    assert.ok(!JSON.stringify(res.body).includes("PK"));
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, { user: { email: "", isAdmin: true } });
    assert.strictEqual(res.statusCode, 401);
  }

  {
    const ddb = mockDdb(seedBase());
    const empRestricted = await call(ddb, { user: EMP, access: { action: ACTION_LIST } });
    assert.strictEqual(empRestricted.statusCode, 403);
    const empOpen = await call(ddb, {
      projectId: OPEN_ID,
      user: EMP,
      access: { action: ACTION_LIST },
    });
    assert.strictEqual(empOpen.statusCode, 403);
  }

  {
    const seeded = seedBase();
    const row = seeded.find(
      (r) => r.TableName === ACCESS && r.Item.email === "admin@mydgv.com"
    );
    row.Item.status = "BLOCKED";
    const ddb = mockDdb(seeded);
    const blocked = await call(ddb, { access: { action: ACTION_LIST } });
    assert.strictEqual(blocked.statusCode, 403);
    row.Item.status = "PENDING";
    const ddb2 = mockDdb(seeded);
    const pending = await call(ddb2, { access: { action: ACTION_LIST } });
    assert.strictEqual(pending.statusCode, 403);
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, { user: OUTSIDER, access: { action: ACTION_LIST } });
    assert.strictEqual(res.statusCode, 403);
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, { user: SUPER, access: { action: ACTION_LIST } });
    assert.strictEqual(res.statusCode, 403);
    const superWrite = await call(ddb, {
      user: SUPER,
      access: { action: ACTION_ADD_MEMBER, email: EMP.email },
    });
    assert.strictEqual(superWrite.statusCode, 403);
  }

  {
    const ddb = mockDdb([...seedBase(), ...memberPair(REST_ID, EMP.email)]);
    const res = await call(ddb, { user: EMP, access: { action: ACTION_LIST } });
    assert.strictEqual(res.statusCode, 403);
    const write = await call(ddb, {
      user: EMP,
      access: { action: ACTION_ADD_MEMBER, email: "ria@mydgv.com" },
    });
    assert.strictEqual(write.statusCode, 403);
  }

  {
    const seeded = [
      ...seedBase().filter(
        (row) =>
          !(
            row.TableName === TABLE &&
            String(row.Item.SK || "").includes("PROJECT_ADMIN#admin@mydgv.com")
          )
      ),
      ...adminPair(REST_ID, ADMIN.email, { status: "REVOKED" }),
    ];
    const ddb = mockDdb(seeded);
    const res = await call(ddb, { user: ADMIN, access: { action: ACTION_LIST } });
    assert.strictEqual(res.statusCode, 403);
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, {
      projectId: OPEN_ID,
      user: MGR,
      access: { action: ACTION_LIST },
    });
    assert.strictEqual(res.statusCode, 403);
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, {
      projectId: OPEN_ID,
      user: ADMIN,
      access: { action: ACTION_LIST },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.accessMode, "OPEN");
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, {
      access: {
        action: ACTION_ADD_MEMBER,
        email: "  Rahul@MyDGV.com ",
        PK: "CLIENT#PK",
        SK: "CLIENT#SK",
        type: "HACK",
        status: "ACTIVE",
        accessMode: "OPEN",
        projectId: OPEN_ID,
      },
    });
    assert.strictEqual(res.statusCode, 200);
    const tx = ddb.calls.find((c) => c instanceof TransactWriteCommand);
    assert.ok(tx);
    assert.strictEqual(tx.input.TransactItems.length, 2);
    const put = tx.input.TransactItems[0].Put.Item;
    assert.strictEqual(put.PK, "PROJECT#rest-1");
    assert.strictEqual(put.SK, "MEMBER#rahul@mydgv.com");
    assert.strictEqual(put.status, "ACTIVE");
    assert.strictEqual(tx.input.TransactItems[1].Put.Item.PK, "USER#rahul@mydgv.com");
    assert.strictEqual(tx.input.TransactItems[1].Put.Item.SK, "PROJECT_MEMBER#rest-1");
    assert.ok(res.body.members.some((m) => m.email === "rahul@mydgv.com" && m.active));
    assert.ok(!res.body.projectAdmins.some((a) => a.email === "rahul@mydgv.com"));
  }

  {
    const ddb = mockDdb(seedBase());
    const blocked = await call(ddb, {
      access: { action: ACTION_ADD_MEMBER, email: EMP.email },
    });
    assert.strictEqual(blocked.statusCode, 200);
    ddb.items.find((r) => r.Item.PK === ACCESS && r.Item.email === EMP.email);
    const pendingSeed = seedBase();
    pendingSeed.push({ TableName: ACCESS, Item: accessRow("pending@mydgv.com", "EMPLOYEE", "PENDING") });
    const ddb2 = mockDdb(pendingSeed);
    const pending = await call(ddb2, {
      access: { action: ACTION_ADD_MEMBER, email: "pending@mydgv.com" },
    });
    assert.strictEqual(pending.statusCode, 400);
  }

  {
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessRow("blocked@mydgv.com", "EMPLOYEE", "BLOCKED") },
    ]);
    const res = await call(ddb, {
      access: { action: ACTION_ADD_MEMBER, email: "blocked@mydgv.com" },
    });
    assert.strictEqual(res.statusCode, 400);
  }

  {
    const ddb = mockDdb(seedBase());
    const mgr = await call(ddb, {
      access: { action: ACTION_ADD_ADMIN, email: MGR.email },
    });
    assert.strictEqual(mgr.statusCode, 400);
    const emp = await call(ddb, {
      access: { action: ACTION_ADD_ADMIN, email: EMP.email },
    });
    assert.strictEqual(emp.statusCode, 400);
    const missing = await call(ddb, {
      access: { action: ACTION_ADD_ADMIN, email: "ghost@mydgv.com" },
    });
    assert.strictEqual(missing.statusCode, 400);
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, {
      access: { action: ACTION_ADD_ADMIN, email: PA2.email, taskVisibility: "ASSIGNED_ONLY" },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.projectAdmins.length, 2);
    const added = res.body.projectAdmins.find((a) => a.email === PA2.email);
    assert.strictEqual(added.taskVisibility, "ASSIGNED_ONLY");
    assert.ok(!res.body.members.some((m) => m.email === PA2.email));
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, {
      access: { action: ACTION_ADD_ADMIN, email: SUPER.email },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.projectAdmins.some((a) => a.email === SUPER.email));
  }

  {
    const ddb = mockDdb(seedBase());
    const last = await call(ddb, {
      access: { action: ACTION_REVOKE_ADMIN, email: ADMIN.email },
    });
    assert.strictEqual(last.statusCode, 409);
  }

  {
    const seeded = seedBase();
    seeded.push(...adminPair(REST_ID, PA2.email, { taskVisibility: "ASSIGNED_ONLY" }));
    seeded.find((row) => row.Item.projectId === REST_ID && row.Item.PK === "ENTITY#PROJECT").Item.activeAdminCount = 2;
    const ddb = mockDdb(seeded);
    const res = await call(ddb, {
      access: { action: ACTION_REVOKE_ADMIN, email: ADMIN.email },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!res.body.projectAdmins.some((a) => a.email === "admin@mydgv.com"));
    const withRevoked = await call(ddb, {
      user: PA2,
      access: { action: ACTION_LIST, includeRevoked: true },
    });
    const revoked = withRevoked.body.projectAdmins.find((a) => a.email === "admin@mydgv.com");
    assert.strictEqual(revoked.status, "REVOKED");
    assert.strictEqual(revoked.active, false);
  }

  {
    const seeded = seedBase();
    seeded.push(...memberPair(REST_ID, EMP.email, "REVOKED"));
    const ddb = mockDdb(seeded);
    const listed = await call(ddb, { access: { action: ACTION_LIST } });
    assert.ok(!listed.body.members.some((m) => m.email === EMP.email));
    const re = await call(ddb, {
      access: { action: ACTION_REACTIVATE_MEMBER, email: EMP.email },
    });
    assert.strictEqual(re.statusCode, 200);
    assert.ok(re.body.members.some((m) => m.email === EMP.email && m.active));
  }

  {
    const seeded = seedBase();
    seeded.push(
      ...adminPair(REST_ID, PA2.email, {
        status: "REVOKED",
        taskVisibility: "ASSIGNED_ONLY",
      })
    );
    const ddb = mockDdb(seeded);
    const res = await call(ddb, {
      access: { action: ACTION_REACTIVATE_ADMIN, email: PA2.email },
    });
    assert.strictEqual(res.statusCode, 200);
    const pa = res.body.projectAdmins.find((a) => a.email === PA2.email);
    assert.strictEqual(pa.taskVisibility, "ASSIGNED_ONLY");
  }

  {
    const ddb = mockDdb(seedBase());
    const bad = await call(ddb, {
      access: { action: ACTION_UPDATE_VISIBILITY, email: ADMIN.email, taskVisibility: "EVERYTHING" },
    });
    assert.strictEqual(bad.statusCode, 400);
    const ok = await call(ddb, {
      access: { action: ACTION_UPDATE_VISIBILITY, email: ADMIN.email, taskVisibility: "ASSIGNED_ONLY" },
    });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(
      ok.body.projectAdmins.find((a) => a.email === "admin@mydgv.com").taskVisibility,
      "ASSIGNED_ONLY"
    );
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, {
      access: { action: ACTION_REVOKE_MEMBER, email: "nobody@mydgv.com" },
    });
    assert.strictEqual(res.statusCode, 409);
  }

  {
    const err = new Error("canceled");
    err.name = "TransactionCanceledException";
    err.CancellationReasons = [{ Code: "TransactionConflict" }];
    const ddb = mockDdb(seedBase(), { failTx: true, txError: err });
    const res = await call(ddb, {
      access: { action: ACTION_ADD_MEMBER, email: EMP.email },
    });
    assert.strictEqual(res.statusCode, 500);
    const again = await call(ddb, {
      access: { action: ACTION_ADD_MEMBER, email: EMP.email },
    });
    assert.strictEqual(again.statusCode, 500);
    assert.ok(!ddb.items.some((r) => r.Item.SK === "MEMBER#rahul@mydgv.com"));
  }

  {
    const ddb = mockDdb(seedBase());
    const first = await call(ddb, {
      access: { action: ACTION_ADD_MEMBER, email: EMP.email },
    });
    assert.strictEqual(first.statusCode, 200);
    const dup = await call(ddb, {
      access: { action: ACTION_ADD_MEMBER, email: EMP.email },
    });
    assert.strictEqual(dup.statusCode, 409);
  }

  {
    const ddb = mockDdb(seedBase(), { failGet: true });
    const res = await call(ddb, { access: { action: ACTION_LIST } });
    assert.strictEqual(res.statusCode, 500);
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await call(ddb, { projectId: "missing-id", access: { action: ACTION_LIST } });
    assert.strictEqual(res.statusCode, 404);
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await handlePatchProject({
      user: ADMIN,
      projectId: REST_ID,
      body: { access: { action: ACTION_LIST } },
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.projectAdmins);
  }

  {
    const ddb = mockDdb(seedBase());
    const res = await handlePatchProject({
      user: { email: EMP.email, isAdmin: false },
      projectId: OPEN_ID,
      body: { name: "Hacked" },
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
    });
    assert.strictEqual(res.statusCode, 403);
  }

  console.log("project access management tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

const assert = require("assert");
const { QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { handleListProjects } = require("./projectManage");
const { projectMemberKeys, projectAdminKeys } = require("./projectAccess");

const TABLE = "work-table";
const ACCESS = "access-table";
const OPEN_ID = "open-1";
const LEGACY_ID = "legacy-1";
const REST_ID = "rest-1";
const REST_OTHER = "rest-2";

const ADMIN = { email: "  Admin@MyDGV.com ", isAdmin: true };
const SUPER = { email: "super@mydgv.com", isAdmin: true };
const MEMBER = { email: "rahul@mydgv.com", isAdmin: false };
const MGR = { email: "mgr@mydgv.com", isAdmin: true };

function catalog(projectId, extra = {}) {
  return {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${projectId}`,
    projectId,
    name: projectId,
    client: "DGV",
    lead: "lead@mydgv.com",
    members: ["outsider@mydgv.com"],
    status: extra.status || "ACTIVE",
    description: "",
    createdAt: "2026-09-01T00:00:00.000Z",
    createdBy: "creator@mydgv.com",
    ...extra,
  };
}

function accessItem(email, role, status) {
  const e = email.trim().toLowerCase();
  return { PK: e, SK: e, email: e, role, status };
}

function mockDdb(seedItems, { failQuery, failGet } = {}) {
  const items = seedItems.slice();
  const calls = [];
  return {
    calls,
    items,
    seed(tableName, item) {
      items.push({ TableName: tableName, Item: item });
    },
    async send(command) {
      calls.push(command);
      if (failGet && command.constructor.name === "GetCommand") {
        throw new Error("access lookup failed");
      }
      if (command.constructor.name === "GetCommand") {
        const { TableName, Key } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        return { Item: found ? { ...found.Item } : undefined };
      }
      if (command instanceof QueryCommand) {
        if (failQuery) throw new Error("query failed");
        const { TableName, ExpressionAttributeValues = {} } = command.input;
        const pk = ExpressionAttributeValues[":pk"];
        const skPrefix = ExpressionAttributeValues[":sk"];
        const found = items
          .filter((row) => row.TableName === TableName && row.Item.PK === pk)
          .filter((row) => (skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true))
          .map((row) => ({ ...row.Item }));
        return { Items: found };
      }
      throw new Error(command.constructor.name);
    },
  };
}

function seedBase() {
  return [
    { TableName: TABLE, Item: catalog(OPEN_ID, { accessMode: "OPEN" }) },
    { TableName: TABLE, Item: catalog(LEGACY_ID) },
    { TableName: TABLE, Item: catalog(REST_ID, { accessMode: "RESTRICTED" }) },
    { TableName: TABLE, Item: catalog(REST_OTHER, { accessMode: "RESTRICTED" }) },
  ];
}

function list(ddb, user, extra = {}) {
  return handleListProjects({
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    user,
    ...extra,
  });
}

async function run() {
  {
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(ADMIN.email, "ADMIN", "ACTIVE") },
    ]);
    const res = await list(ddb, ADMIN);
    assert.strictEqual(res.statusCode, 200);
    const ids = res.body.map((p) => p.projectId).sort();
    assert.deepStrictEqual(ids, [LEGACY_ID, OPEN_ID].sort());
    assert.ok(!ids.includes(REST_ID));
    assert.ok(res.body.every((p) => !p.type || p.type !== "PROJECT_ADMIN"));
    assert.ok(res.body.find((p) => p.projectId === REST_ID) == null);
  }

  {
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(SUPER.email, "SUPER_ADMIN", "ACTIVE") },
    ]);
    const res = await list(ddb, SUPER);
    assert.deepStrictEqual(res.body.map((p) => p.projectId).sort(), [LEGACY_ID, OPEN_ID].sort());
    assert.ok(!res.body.some((p) => p.accessMode === "RESTRICTED"));
  }

  {
    const keys = projectMemberKeys(REST_ID, MEMBER.email);
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(MEMBER.email, "EMPLOYEE", "ACTIVE") },
      {
        TableName: TABLE,
        Item: { ...keys.userSide, type: "PROJECT_MEMBER", status: "ACTIVE", projectId: REST_ID, email: MEMBER.email },
      },
    ]);
    const res = await list(ddb, MEMBER);
    assert.deepStrictEqual(res.body.map((p) => p.projectId), [REST_ID]);
    assert.ok(!res.body.some((p) => p.projectId === OPEN_ID));
  }

  {
    const keys = projectAdminKeys(REST_ID, ADMIN.email);
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(ADMIN.email, "ADMIN", "ACTIVE") },
      {
        TableName: TABLE,
        Item: {
          ...keys.userSide,
          type: "PROJECT_ADMIN",
          status: "ACTIVE",
          projectId: REST_ID,
          email: "admin@mydgv.com",
        },
      },
    ]);
    const res = await list(ddb, ADMIN);
    const ids = res.body.map((p) => p.projectId);
    assert.ok(ids.includes(REST_ID));
    assert.ok(ids.includes(OPEN_ID));
    assert.ok(!ids.includes(REST_OTHER));
    const rest = res.body.find((p) => p.projectId === REST_ID);
    const open = res.body.find((p) => p.projectId === OPEN_ID);
    assert.strictEqual(rest.canManageAccess, true);
    assert.strictEqual(open.canManageAccess, false);
  }

  {
    const keys = projectMemberKeys(REST_ID, MEMBER.email);
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(MEMBER.email, "EMPLOYEE", "ACTIVE") },
      {
        TableName: TABLE,
        Item: { ...keys.userSide, type: "PROJECT_MEMBER", status: "ACTIVE", projectId: REST_ID, email: MEMBER.email },
      },
    ]);
    const res = await list(ddb, MEMBER);
    assert.deepStrictEqual(
      res.body.map((p) => ({ id: p.projectId, canManageAccess: p.canManageAccess })),
      [{ id: REST_ID, canManageAccess: false }]
    );
  }

  {
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(SUPER.email, "SUPER_ADMIN", "ACTIVE") },
    ]);
    const res = await list(ddb, SUPER);
    const rest = res.body.find((p) => p.projectId === REST_ID);
    const open = res.body.find((p) => p.projectId === OPEN_ID);
    assert.ok(!rest);
    assert.strictEqual(open.canManageAccess, false);
  }

  {
    const keys = projectMemberKeys(REST_ID, MEMBER.email);
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(MEMBER.email, "EMPLOYEE", "ACTIVE") },
      {
        TableName: TABLE,
        Item: { ...keys.userSide, type: "PROJECT_MEMBER", status: "REVOKED", projectId: REST_ID, email: MEMBER.email },
      },
    ]);
    const res = await list(ddb, MEMBER);
    assert.deepStrictEqual(res.body, []);
  }

  {
    const keys = projectAdminKeys(REST_ID, SUPER.email);
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(SUPER.email, "SUPER_ADMIN", "ACTIVE") },
      {
        TableName: TABLE,
        Item: { ...keys.userSide, type: "PROJECT_ADMIN", status: "REVOKED", projectId: REST_ID, email: SUPER.email },
      },
    ]);
    const res = await list(ddb, SUPER);
    assert.ok(!res.body.some((p) => p.projectId === REST_ID));
  }

  {
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(SUPER.email, "SUPER_ADMIN", "ACTIVE") },
    ]);
    const res = await list(ddb, SUPER, { accessMode: "OPEN", isAdmin: true });
    assert.ok(!res.body.some((p) => p.projectId === REST_ID));
  }

  {
    const keys = projectMemberKeys(REST_OTHER, MEMBER.email);
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(MEMBER.email, "EMPLOYEE", "ACTIVE") },
      {
        TableName: TABLE,
        Item: { ...keys.userSide, status: "ACTIVE", type: "PROJECT_MEMBER", projectId: REST_ID, email: MEMBER.email },
      },
    ]);
    const res = await list(ddb, MEMBER);
    assert.ok(!res.body.some((p) => p.projectId === REST_ID));
  }

  {
    const keys = projectMemberKeys(REST_ID, "other@mydgv.com");
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(MEMBER.email, "EMPLOYEE", "ACTIVE") },
      {
        TableName: TABLE,
        Item: { ...keys.userSide, status: "ACTIVE", type: "PROJECT_MEMBER", projectId: REST_ID, email: "other@mydgv.com" },
      },
    ]);
    const res = await list(ddb, MEMBER);
    assert.deepStrictEqual(res.body, []);
  }

  {
    const res = await handleListProjects({
      ddb: mockDdb(seedBase()),
      tableName: TABLE,
      accessTable: ACCESS,
      user: { email: "", isAdmin: true },
    });
    assert.strictEqual(res.statusCode, 401);
    assert.notStrictEqual(res.statusCode, 200);
  }

  {
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(ADMIN.email, "ADMIN", "BLOCKED") },
    ]);
    const res = await list(ddb, ADMIN);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, []);
  }

  {
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(ADMIN.email, "ADMIN", "PENDING") },
    ]);
    const res = await list(ddb, ADMIN);
    assert.deepStrictEqual(res.body, []);
  }

  {
    const ddb = mockDdb(
      [...seedBase(), { TableName: ACCESS, Item: accessItem(ADMIN.email, "ADMIN", "ACTIVE") }],
      { failGet: true }
    );
    const res = await list(ddb, ADMIN);
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { error: "Internal server error" });
  }

  {
    const ddb = mockDdb(
      [...seedBase(), { TableName: ACCESS, Item: accessItem(ADMIN.email, "ADMIN", "ACTIVE") }],
      { failQuery: true }
    );
    const res = await list(ddb, ADMIN);
    assert.strictEqual(res.statusCode, 500);
  }

  {
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(MGR.email, "MANAGER", "ACTIVE") },
    ]);
    const res = await list(ddb, MGR);
    assert.ok(!res.body.some((p) => p.projectId === OPEN_ID));
    assert.ok(!res.body.some((p) => p.projectId === REST_ID));
  }

  {
    const listed = await handleListProjects({
      ddb: mockDdb(seedBase()),
      tableName: TABLE,
      status: "DELETED",
    });
    assert.strictEqual(listed.statusCode, 400);
  }

  {
    const ddb = mockDdb([
      ...seedBase(),
      { TableName: ACCESS, Item: accessItem(MEMBER.email, "EMPLOYEE", "ACTIVE") },
    ]);
    ddb.seed(TABLE, {
      PK: `PROJECT#${REST_ID}`,
      SK: `MEMBER#${MEMBER.email}`,
      status: "ACTIVE",
    });
    const res = await list(ddb, MEMBER);
    assert.deepStrictEqual(res.body, []);
  }

  console.log("project catalog authorization tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

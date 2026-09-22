const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  handleCreateProject,
  isRestrictedCreateEnabled,
  parseCreateMembers,
  RESTRICTED_CREATE_DISABLED,
  RESTRICTED_MEMBERS_REQUIRED,
  RESTRICTED_MEMBER_INACTIVE,
} = require("./projectManage");
const persist = require("./projectAccessPersist");
const { ACCESS_OPEN, ACCESS_RESTRICTED, VISIBILITY_ALL_PROJECT_TASKS, VISIBILITY_ASSIGNED_ONLY } = require("./projectAccess");

const WORK = "WorkTasks";
const ACCESS = "UserAccess";
const NOW = "2026-09-21T12:00:00.000Z";
const ID = "created-proj-1";

function accessRow(role, status) {
  return { PK: "admin@mydgv.com", SK: "admin@mydgv.com", email: "admin@mydgv.com", role, status };
}

function mockDdb({ access, accessRows, error, onSend } = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      if (typeof onSend === "function") return onSend(command);
      if (error && !(command instanceof GetCommand)) throw error;
      if (command instanceof GetCommand) {
        if (error && error.onGet) throw error;
        const pk = command.input?.Key?.PK;
        if (accessRows && pk && Object.prototype.hasOwnProperty.call(accessRows, pk)) {
          const item = accessRows[pk];
          return item ? { Item: item } : {};
        }
        return access ? { Item: access } : {};
      }
      if (command instanceof PutCommand) return {};
      if (command instanceof TransactWriteCommand) return {};
      throw new Error(command?.constructor?.name);
    },
  };
}

const MEMBER_EMAIL = "rahul@mydgv.com";
const MEMBER_ACCESS = {
  PK: MEMBER_EMAIL,
  SK: MEMBER_EMAIL,
  email: MEMBER_EMAIL,
  role: "EMPLOYEE",
  status: "ACTIVE",
};

function restrictedBody(extra = {}) {
  return {
    name: "Secret",
    accessMode: "RESTRICTED",
    members: [{ email: `  ${MEMBER_EMAIL.toUpperCase()}  ` }, { email: MEMBER_EMAIL }, ""],
    ...extra,
  };
}

function createOpts(overrides = {}) {
  return {
    user: { email: "  Admin@MyDGV.com ", isAdmin: true },
    body: { name: "Portal", client: "DGV", description: "Work" },
    ddb: mockDdb({ access: accessRow("ADMIN", "ACTIVE") }),
    tableName: WORK,
    accessTable: ACCESS,
    now: NOW,
    newId: () => ID,
    ...overrides,
  };
}

async function run() {
  assert.strictEqual(isRestrictedCreateEnabled(undefined, {}), false);
  assert.strictEqual(isRestrictedCreateEnabled(undefined, { PROJECT_ACL_RESTRICTED_CREATE: "true" }), true);
  assert.deepStrictEqual(
    parseCreateMembers(
      [
        { email: "  A@MyDGV.com " },
        "a@mydgv.com",
        { email: "" },
        "  ",
        { email: "b@mydgv.com" },
        "Admin@MyDGV.com",
      ],
      "admin@mydgv.com"
    ),
    ["a@mydgv.com", "b@mydgv.com"]
  );

  {
    const ddb = mockDdb({ access: accessRow("ADMIN", "ACTIVE") });
    const res = await handleCreateProject({
      ...createOpts({ ddb }),
      user: { email: "", isAdmin: true },
    });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { error: "Unauthorized" });
    assert.strictEqual(ddb.calls.length, 0);
  }

  {
    const ddb = mockDdb({ access: accessRow("ADMIN", "ACTIVE") });
    const res = await handleCreateProject(createOpts({ ddb }));
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.accessMode, ACCESS_OPEN);
    assert.strictEqual(res.body.createdBy, "admin@mydgv.com");
    assert.strictEqual(res.body.lead, "admin@mydgv.com");
    assert.strictEqual(res.body.projectId, ID);
    assert.strictEqual(res.body.PK, "ENTITY#PROJECT");
    assert.strictEqual(res.body.SK, `PROJECT#${ID}`);
    assert.strictEqual(res.body.name, "Portal");
    assert.strictEqual(res.body.client, "DGV");
    assert.strictEqual(res.body.description, "Work");
    assert.strictEqual(res.body.status, "ACTIVE");
    assert.ok(Array.isArray(res.body.members));
    const put = ddb.calls.find((c) => c instanceof PutCommand);
    assert.ok(put);
    assert.strictEqual(put.input.ConditionExpression, "attribute_not_exists(PK)");
    assert.strictEqual(put.input.Item.accessMode, ACCESS_OPEN);
    assert.ok(!ddb.calls.some((c) => c instanceof TransactWriteCommand));
    assert.ok(!String(put.input.Item.SK).startsWith("PROJECT_ADMIN"));
    assert.ok(!String(put.input.Item.SK).includes("MEMBER"));
  }

  {
    const ddb = mockDdb({ access: accessRow("SUPER_ADMIN", "ACTIVE") });
    const res = await handleCreateProject(
      createOpts({
        ddb,
        user: { email: "super@mydgv.com", isAdmin: true },
        body: { name: "X", lead: "  Lead@MyDGV.com " },
      })
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.createdBy, "super@mydgv.com");
    assert.strictEqual(res.body.lead, "lead@mydgv.com");
  }

  {
    const ddb = mockDdb({ access: accessRow("MANAGER", "ACTIVE") });
    const res = await handleCreateProject(
      createOpts({ ddb, user: { email: "mgr@mydgv.com", isAdmin: true } })
    );
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: "Admin required" });
    assert.ok(!ddb.calls.some((c) => c instanceof PutCommand));
  }

  {
    const ddb = mockDdb({ access: accessRow("EMPLOYEE", "ACTIVE") });
    const res = await handleCreateProject(
      createOpts({ ddb, user: { email: "rahul@mydgv.com", isAdmin: false } })
    );
    assert.strictEqual(res.statusCode, 403);
    assert.ok(!ddb.calls.some((c) => c instanceof PutCommand));
  }

  {
    const ddb = mockDdb({ access: accessRow("ADMIN", "BLOCKED") });
    const res = await handleCreateProject(createOpts({ ddb }));
    assert.strictEqual(res.statusCode, 403);
  }

  {
    const ddb = mockDdb({ access: accessRow("ADMIN", "PENDING") });
    const res = await handleCreateProject(createOpts({ ddb }));
    assert.strictEqual(res.statusCode, 403);
  }

  {
    const ddb = mockDdb({ access: null });
    const res = await handleCreateProject(createOpts({ ddb }));
    assert.strictEqual(res.statusCode, 403);
  }

  {
    const ddb = mockDdb({ access: accessRow("ADMIN", "ACTIVE") });
    const res = await handleCreateProject(
      createOpts({
        ddb,
        body: {
          name: "Portal",
          projectId: "client-id",
          PK: "FORGED",
          SK: "FORGED",
        },
      })
    );
    assert.strictEqual(res.body.projectId, ID);
    assert.strictEqual(res.body.PK, "ENTITY#PROJECT");
    assert.strictEqual(res.body.SK, `PROJECT#${ID}`);
  }

  {
    const ddb = mockDdb({ access: accessRow("ADMIN", "ACTIVE") });
    const res = await handleCreateProject(
      createOpts({
        ddb,
        body: restrictedBody(),
        restrictedCreateEnabled: false,
      })
    );
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: RESTRICTED_CREATE_DISABLED });
    assert.ok(!ddb.calls.some((c) => c instanceof TransactWriteCommand));
    assert.ok(!ddb.calls.some((c) => c instanceof PutCommand));
  }

  {
    const ddb = mockDdb({
      access: accessRow("ADMIN", "ACTIVE"),
      accessRows: {
        "admin@mydgv.com": accessRow("ADMIN", "ACTIVE"),
        [MEMBER_EMAIL]: MEMBER_ACCESS,
      },
    });
    const res = await handleCreateProject(
      createOpts({
        ddb,
        body: restrictedBody({ accessMode: "restricted", taskVisibility: "assigned_only" }),
        restrictedCreateEnabled: true,
      })
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.accessMode, ACCESS_RESTRICTED);
    assert.strictEqual(res.body.createdBy, "admin@mydgv.com");
    assert.deepStrictEqual(res.body.members, [MEMBER_EMAIL]);
    assert.ok(!res.body.PK.startsWith("PROJECT#admin"));
    const tx = ddb.calls.find((c) => c instanceof TransactWriteCommand);
    assert.ok(tx);
    assert.strictEqual(tx.input.TransactItems.length, 5);
    const items = tx.input.TransactItems.map((t) => t.Put.Item);
    assert.strictEqual(items[0].PK, "ENTITY#PROJECT");
    assert.strictEqual(items[0].SK, `PROJECT#${ID}`);
    assert.strictEqual(items[0].accessMode, ACCESS_RESTRICTED);
    assert.strictEqual(items[0].activeAdminCount, 1);
    assert.strictEqual(items[1].PK, `PROJECT#${ID}`);
    assert.strictEqual(items[1].SK, "PROJECT_ADMIN#admin@mydgv.com");
    assert.strictEqual(items[2].PK, "USER#admin@mydgv.com");
    assert.strictEqual(items[2].SK, `PROJECT_ADMIN#${ID}`);
    assert.strictEqual(items[3].PK, `PROJECT#${ID}`);
    assert.strictEqual(items[3].SK, `MEMBER#${MEMBER_EMAIL}`);
    assert.strictEqual(items[3].status, "ACTIVE");
    assert.strictEqual(items[3].type, "PROJECT_MEMBER");
    assert.strictEqual(items[4].PK, `USER#${MEMBER_EMAIL}`);
    assert.strictEqual(items[4].SK, `PROJECT_MEMBER#${ID}`);
    assert.strictEqual(items[4].status, "ACTIVE");
    assert.ok(items.slice(1, 3).every((it) => it.type === "PROJECT_ADMIN"));
    assert.ok(items.slice(1, 3).every((it) => it.taskVisibility === VISIBILITY_ASSIGNED_ONLY));
    assert.ok(items.slice(1).every((it) => it.status === "ACTIVE"));
    assert.ok(!items.some((it) => String(it.SK).startsWith("PROJECT_MEMBER#") && it.PK.startsWith("PROJECT#")));
    assert.ok(!items.some((it) => String(it.SK).startsWith("PROJECT_MEMBER#") && it.type === "PROJECT_ADMIN"));
    assert.ok(!ddb.calls.some((c) => c instanceof PutCommand));
  }

  {
    const ddb = mockDdb({
      access: accessRow("ADMIN", "ACTIVE"),
      accessRows: {
        "admin@mydgv.com": accessRow("ADMIN", "ACTIVE"),
        [MEMBER_EMAIL]: MEMBER_ACCESS,
      },
    });
    const res = await handleCreateProject(
      createOpts({
        ddb,
        body: restrictedBody(),
        restrictedCreateEnabled: true,
      })
    );
    assert.strictEqual(res.statusCode, 201);
    const vis = ddb.calls
      .find((c) => c instanceof TransactWriteCommand)
      .input.TransactItems.slice(1, 3)
      .map((t) => t.Put.Item.taskVisibility);
    assert.deepStrictEqual(vis, [VISIBILITY_ALL_PROJECT_TASKS, VISIBILITY_ALL_PROJECT_TASKS]);
  }

  {
    const ddb = mockDdb({ access: accessRow("ADMIN", "ACTIVE") });
    const res = await handleCreateProject(
      createOpts({
        ddb,
        body: restrictedBody({ taskVisibility: "NOPE" }),
        restrictedCreateEnabled: true,
      })
    );
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: "Invalid taskVisibility" });
    assert.ok(!ddb.calls.some((c) => c instanceof TransactWriteCommand));
  }

  {
    const ddb = mockDdb({
      access: accessRow("ADMIN", "ACTIVE"),
      error: Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" }),
    });
    const res = await handleCreateProject(createOpts({ ddb }));
    assert.strictEqual(res.statusCode, 409);
    assert.notStrictEqual(res.statusCode, 201);
  }

  {
    const err = new Error("cancelled");
    err.name = "TransactionCanceledException";
    err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
    const ddb = mockDdb({
      access: accessRow("ADMIN", "ACTIVE"),
      onSend: async (command) => {
        if (command instanceof TransactWriteCommand) throw err;
        if (command instanceof GetCommand) {
          const pk = command.input?.Key?.PK;
          if (pk === MEMBER_EMAIL) return { Item: MEMBER_ACCESS };
          return { Item: accessRow("ADMIN", "ACTIVE") };
        }
        return {};
      },
    });
    const res = await handleCreateProject(
      createOpts({
        ddb,
        body: restrictedBody(),
        restrictedCreateEnabled: true,
      })
    );
    assert.strictEqual(res.statusCode, 409);
    assert.notStrictEqual(res.statusCode, 201);
    assert.strictEqual(ddb.calls.filter((c) => c instanceof TransactWriteCommand).length, 1);
  }

  {
    const written = await persist.createRestrictedProject(mockDdb(), WORK, {
      projectId: ID,
      email: "  Admin@MyDGV.com ",
      catalog: { name: "X", PK: "NO", SK: "NO", projectId: "client" },
      now: NOW,
    });
    assert.strictEqual(written.ok, true);
    assert.strictEqual(written.catalog.PK, "ENTITY#PROJECT");
    assert.strictEqual(written.catalog.projectId, ID);
    assert.strictEqual(written.catalog.createdBy, "admin@mydgv.com");
    assert.strictEqual(written.catalog.activeAdminCount, 1);
  }

  {
    const ddb = mockDdb({ access: accessRow("ADMIN", "ACTIVE") });
    const res = await handleCreateProject(
      createOpts({
        ddb,
        body: { name: "Secret", accessMode: "RESTRICTED" },
        restrictedCreateEnabled: true,
      })
    );
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: RESTRICTED_MEMBERS_REQUIRED });
    assert.ok(!ddb.calls.some((c) => c instanceof TransactWriteCommand));
  }

  {
    const ddb = mockDdb({
      access: accessRow("ADMIN", "ACTIVE"),
      accessRows: {
        "admin@mydgv.com": accessRow("ADMIN", "ACTIVE"),
        [MEMBER_EMAIL]: { ...MEMBER_ACCESS, status: "BLOCKED" },
      },
    });
    const res = await handleCreateProject(
      createOpts({
        ddb,
        body: restrictedBody(),
        restrictedCreateEnabled: true,
      })
    );
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: RESTRICTED_MEMBER_INACTIVE });
    assert.ok(!ddb.calls.some((c) => c instanceof TransactWriteCommand));
  }

  {
    const ddb = mockDdb();
    const written = await persist.createRestrictedProject(ddb, WORK, {
      projectId: ID,
      email: "admin@mydgv.com",
      catalog: { name: "X" },
      now: NOW,
      members: [
        { email: ` ${MEMBER_EMAIL.toUpperCase()} ` },
        MEMBER_EMAIL,
        "admin@mydgv.com",
      ],
    });
    assert.strictEqual(written.ok, true);
    assert.strictEqual(written.members.length, 1);
    const tx = ddb.calls.find((c) => c instanceof TransactWriteCommand);
    assert.strictEqual(tx.input.TransactItems.length, 5);
    const sks = tx.input.TransactItems.map((t) => t.Put.Item.SK);
    assert.ok(sks.includes(`MEMBER#${MEMBER_EMAIL}`));
    assert.ok(sks.includes(`PROJECT_MEMBER#${ID}`));
    assert.ok(sks.includes("PROJECT_ADMIN#admin@mydgv.com"));
  }

  console.log("project create authorization tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

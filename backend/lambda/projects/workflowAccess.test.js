const assert = require("assert");
const { GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const {
  listImportableProjects,
  applyImportAclToRows,
  authorizeImportRowCreate,
  filterScheduledAssignees,
  adminNotifyRecipientsForTask,
  authorizeTimeEntryAccess,
  resolveTimeEntryQueryEmail,
  authorizeImportOperator,
  authorizeImportBatchView,
} = require("./workflowAccess");
const { projectMemberKeys, projectAdminKeys } = require("./projectAccess");
const { createCache } = require("./taskReadAccess");

const TABLE = "work-table";
const ACCESS = "access-table";
const OPEN_ID = "open-1";
const REST_ID = "rest-1";

function projectItem(projectId, extra = {}) {
  return {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${projectId}`,
    projectId,
    name: extra.name || projectId,
    status: "ACTIVE",
    ...extra,
  };
}

function accessRow(email, role, status) {
  const e = String(email).trim().toLowerCase();
  return { PK: e, SK: e, email: e, role, status };
}

function memberRow(projectId, email, status = "ACTIVE") {
  const e = String(email).trim().toLowerCase();
  const keys = projectMemberKeys(projectId, e);
  return { ...keys.projectSide, type: "PROJECT_MEMBER", projectId, email: e, status };
}

function adminRow(projectId, email, extra = {}) {
  const e = String(email).trim().toLowerCase();
  const keys = projectAdminKeys(projectId, e);
  return {
    ...keys.projectSide,
    type: "PROJECT_ADMIN",
    projectId,
    email: e,
    status: extra.status || "ACTIVE",
    taskVisibility: extra.taskVisibility || "ALL_PROJECT_TASKS",
  };
}

function mockDdb(seedItems, { failGet, failQuery } = {}) {
  const items = seedItems.slice();
  return {
    async send(command) {
      const name = command.constructor.name;
      if (failGet && (name === "GetCommand" || command instanceof GetCommand)) {
        throw new Error("ddb get failed");
      }
      if (failQuery && (name === "QueryCommand" || command instanceof QueryCommand)) {
        throw new Error("ddb query failed");
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
        const found = items
          .filter((row) => row.TableName === TableName && row.Item.PK === pk)
          .filter((row) => (skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true))
          .map((row) => ({ ...row.Item }));
        return { Items: found };
      }
      throw new Error(name);
    },
  };
}

const paUser = { email: "pa@mydgv.com", isAdmin: true };
const outsiderAdmin = { email: "outsider@mydgv.com", isAdmin: true };
const superUser = { email: "super@mydgv.com", isAdmin: true };
const memberUser = { email: "rahul@mydgv.com", isAdmin: false };

async function run() {
  const seed = [
    { TableName: TABLE, Item: projectItem(OPEN_ID, { accessMode: "OPEN", name: "Open Work" }) },
    { TableName: TABLE, Item: projectItem(REST_ID, { accessMode: "RESTRICTED", name: "Secret" }) },
    { TableName: ACCESS, Item: accessRow(paUser.email, "ADMIN", "ACTIVE") },
    { TableName: ACCESS, Item: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE") },
    { TableName: ACCESS, Item: accessRow(superUser.email, "SUPER_ADMIN", "ACTIVE") },
    { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE") },
    { TableName: TABLE, Item: adminRow(REST_ID, paUser.email) },
    { TableName: TABLE, Item: memberRow(REST_ID, memberUser.email) },
  ];

  {
    const ddb = mockDdb(seed);
    const listed = await listImportableProjects({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
    });
    assert.strictEqual(listed.ok, true);
    assert.deepStrictEqual(
      listed.projects.map((p) => p.projectId).sort(),
      [OPEN_ID]
    );
  }

  {
    const ddb = mockDdb(seed);
    const listed = await listImportableProjects({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: paUser,
    });
    assert.ok(listed.projects.some((p) => p.projectId === REST_ID));
    assert.ok(listed.projects.some((p) => p.projectId === OPEN_ID));
  }

  {
    const ddb = mockDdb(seed);
    const listed = await listImportableProjects({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: superUser,
    });
    assert.ok(!listed.projects.some((p) => p.projectId === REST_ID));
  }

  {
    const ddb = mockDdb(seed);
    const acl = await applyImportAclToRows(
      [
        {
          projectId: REST_ID,
          status: "VALID",
          errors: [],
          values: { projectId: REST_ID },
          resolvedAssignees: [{ email: memberUser.email }],
        },
      ],
      { ddb, tableName: TABLE, accessTable: ACCESS, user: paUser }
    );
    assert.strictEqual(acl.ok, true);
    assert.strictEqual(acl.rows[0].status, "VALID");
  }

  {
    const ddb = mockDdb(seed);
    const acl = await applyImportAclToRows(
      [
        {
          projectId: REST_ID,
          status: "VALID",
          errors: [],
          values: { projectId: REST_ID },
          resolvedAssignees: [{ email: "outsider@mydgv.com" }],
        },
      ],
      { ddb, tableName: TABLE, accessTable: ACCESS, user: paUser }
    );
    assert.strictEqual(acl.rows[0].status, "INVALID");
  }

  {
    const ddb = mockDdb(seed);
    const denied = await authorizeImportRowCreate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      projectId: REST_ID,
      emails: [memberUser.email],
      cache: createCache(),
    });
    assert.strictEqual(denied.allowed, false);
  }

  {
    const ddb = mockDdb(seed);
    const allowed = await authorizeImportRowCreate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: paUser,
      projectId: REST_ID,
      emails: [memberUser.email],
    });
    assert.strictEqual(allowed.allowed, true);
  }

  {
    const ddb = mockDdb(seed);
    const blocked = await authorizeImportRowCreate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: paUser,
      projectId: REST_ID,
      emails: ["ghost@mydgv.com"],
    });
    assert.strictEqual(blocked.allowed, false);
  }

  {
    const ddb = mockDdb(seed);
    const open = await filterScheduledAssignees({
      ddb,
      tableName: TABLE,
      task: { projectId: OPEN_ID },
      emails: ["anyone@mydgv.com"],
    });
    assert.deepStrictEqual(open.active, ["anyone@mydgv.com"]);
  }

  {
    const ddb = mockDdb(seed);
    const rest = await filterScheduledAssignees({
      ddb,
      tableName: TABLE,
      task: { projectId: REST_ID },
      emails: [memberUser.email, "outsider@mydgv.com"],
    });
    assert.deepStrictEqual(rest.active, [memberUser.email]);
    assert.ok(rest.skipped.includes("outsider@mydgv.com"));
    const missingSched = await filterScheduledAssignees({
      ddb,
      tableName: TABLE,
      task: { projectId: "gone-project" },
      emails: [memberUser.email],
    });
    assert.deepStrictEqual(missingSched.active, []);
    assert.strictEqual(missingSched.reason, "PROJECT_MISSING");
  }

  {
    const ddb = mockDdb(seed, { failGet: true });
    const failed = await filterScheduledAssignees({
      ddb,
      tableName: TABLE,
      task: { projectId: REST_ID },
      emails: [memberUser.email],
    });
    assert.strictEqual(failed.ok, false);
  }

  {
    const ddb = mockDdb(seed);
    const openRecipients = await adminNotifyRecipientsForTask({
      ddb,
      tableName: TABLE,
      projectId: OPEN_ID,
      fallbackEmails: ["super@mydgv.com"],
    });
    assert.deepStrictEqual(openRecipients.emails, ["super@mydgv.com"]);
    const restRecipients = await adminNotifyRecipientsForTask({
      ddb,
      tableName: TABLE,
      projectId: REST_ID,
      fallbackEmails: ["super@mydgv.com"],
    });
    assert.deepStrictEqual(restRecipients.emails, [paUser.email]);
    assert.ok(!restRecipients.emails.includes("super@mydgv.com"));
    const missingNotify = await adminNotifyRecipientsForTask({
      ddb,
      tableName: TABLE,
      projectId: "deleted-project",
      fallbackEmails: ["super@mydgv.com"],
    });
    assert.deepStrictEqual(missingNotify.emails, []);
  }

  {
    const ddb = mockDdb([
      ...seed,
      {
        TableName: TABLE,
        Item: {
          PK: "ENTITY#TASK",
          SK: "TASK#t1",
          taskId: "t1",
          projectId: REST_ID,
          assignee: memberUser.email,
          assignees: [memberUser.email],
        },
      },
    ]);
    const memberOk = await authorizeTimeEntryAccess({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: memberUser,
      task: { taskId: "t1", projectId: REST_ID, assignee: memberUser.email, assignees: [memberUser.email] },
    });
    assert.strictEqual(memberOk.allowed, true);
    const outsider = await authorizeTimeEntryAccess({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      task: { taskId: "t1", projectId: REST_ID, assignee: memberUser.email, assignees: [memberUser.email] },
    });
    assert.strictEqual(outsider.allowed, false);
  }

  {
    const ddb = mockDdb([
      { TableName: TABLE, Item: projectItem(REST_ID, { accessMode: "RESTRICTED", name: "Secret" }) },
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "BLOCKED") },
      { TableName: TABLE, Item: memberRow(REST_ID, memberUser.email) },
    ]);
    const blocked = await authorizeTimeEntryAccess({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: { email: memberUser.email, isAdmin: false },
      task: { taskId: "t1", projectId: REST_ID, assignee: memberUser.email, assignees: [memberUser.email] },
    });
    assert.strictEqual(blocked.allowed, false);
  }

  {
    const ddb = mockDdb(seed);
    const blank = await filterScheduledAssignees({
      ddb,
      tableName: TABLE,
      task: { projectId: "  " },
      emails: [memberUser.email],
    });
    assert.deepStrictEqual(blank.active, []);
    const noId = await adminNotifyRecipientsForTask({
      ddb,
      tableName: TABLE,
      projectId: "",
      fallbackEmails: ["super@mydgv.com"],
    });
    assert.deepStrictEqual(noId.emails, []);
  }

  {
    const ddb = mockDdb([
      ...seed,
      { TableName: ACCESS, Item: accessRow("mgr@mydgv.com", "MANAGER", "ACTIVE") },
    ]);
    const self = await resolveTimeEntryQueryEmail({
      user: memberUser,
      requestedEmail: "  Rahul@MyDGV.com ",
      ddb,
      accessTable: ACCESS,
    });
    assert.strictEqual(self.ok, true);
    assert.strictEqual(self.email, "rahul@mydgv.com");
    const adminLookup = await resolveTimeEntryQueryEmail({
      user: outsiderAdmin,
      requestedEmail: "  RAHUL@mydgv.com ",
      ddb,
      accessTable: ACCESS,
    });
    assert.strictEqual(adminLookup.ok, true);
    assert.strictEqual(adminLookup.email, "rahul@mydgv.com");
    const mgr = await resolveTimeEntryQueryEmail({
      user: { email: "mgr@mydgv.com", isAdmin: true },
      requestedEmail: memberUser.email,
      ddb,
      accessTable: ACCESS,
    });
    assert.strictEqual(mgr.statusCode, 403);
    const pending = await resolveTimeEntryQueryEmail({
      user: { email: "pending-admin@mydgv.com", isAdmin: true },
      requestedEmail: memberUser.email,
      ddb,
      accessTable: ACCESS,
    });
    assert.strictEqual(pending.statusCode, 403);
  }

  {
    const ddb = mockDdb([
      ...seed,
      { TableName: ACCESS, Item: accessRow("cog@mydgv.com", "ADMIN", "PENDING") },
    ]);
    const cog = await authorizeImportOperator({
      user: { email: "cog@mydgv.com", isAdmin: true },
      ddb,
      accessTable: ACCESS,
    });
    assert.strictEqual(cog.statusCode, 403);
    const ok = await authorizeImportOperator({
      user: outsiderAdmin,
      ddb,
      accessTable: ACCESS,
    });
    assert.strictEqual(ok.ok, true);
    const secret = await authorizeImportBatchView({
      user: outsiderAdmin,
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      rows: [{ projectId: REST_ID }],
    });
    assert.strictEqual(secret.allowed, false);
    const openRows = await authorizeImportBatchView({
      user: outsiderAdmin,
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      rows: [{ projectId: OPEN_ID }],
    });
    assert.strictEqual(openRows.allowed, true);
    const emptyOwner = await authorizeImportBatchView({
      user: outsiderAdmin,
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      rows: [],
      meta: { uploadedBy: outsiderAdmin.email, status: "UPLOADED" },
    });
    assert.strictEqual(emptyOwner.allowed, true);
    const emptyOther = await authorizeImportBatchView({
      user: outsiderAdmin,
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      rows: [],
      meta: { uploadedBy: paUser.email, status: "UPLOADED" },
    });
    assert.strictEqual(emptyOther.allowed, false);
    const completedEmpty = await authorizeImportBatchView({
      user: outsiderAdmin,
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      rows: [],
      meta: { uploadedBy: paUser.email, status: "COMPLETED" },
    });
    assert.strictEqual(completedEmpty.allowed, false);
  }

  {
    const ddb = mockDdb(seed);
    const blank = await applyImportAclToRows(
      [
        { projectId: "   ", status: "VALID", errors: [], values: {} },
        { status: "VALID", errors: [], values: {} },
        {
          projectId: OPEN_ID,
          status: "VALID",
          errors: [],
          values: { projectId: OPEN_ID },
          resolvedAssignees: [{ email: memberUser.email }],
        },
      ],
      { ddb, tableName: TABLE, accessTable: ACCESS, user: outsiderAdmin }
    );
    assert.strictEqual(blank.ok, true);
    assert.strictEqual(blank.rows[0].status, "INVALID");
    assert.strictEqual(blank.rows[1].status, "INVALID");
    assert.strictEqual(blank.rows[2].status, "VALID");
  }

  console.log("workflow authorization tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

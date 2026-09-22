const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const {
  canViewTask,
  decideTaskRead,
  authorizeTaskRead,
  filterVisibleTasks,
  authorizeAttachmentDownload,
  createCache,
} = require("./taskReadAccess");
const { projectMemberKeys, projectAdminKeys } = require("./projectAccess");

const TABLE = "work-table";
const ACCESS = "access-table";
const OPEN_ID = "open-1";
const LEGACY_ID = "legacy-1";
const REST_ID = "rest-1";

const assigned = {
  taskId: "t-assigned",
  projectId: OPEN_ID,
  assignee: "rahul@mydgv.com",
  assignees: ["rahul@mydgv.com"],
};

function projectItem(projectId, extra = {}) {
  return {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${projectId}`,
    projectId,
    name: projectId,
    accessMode: extra.accessMode,
    members: ["outsider@mydgv.com"],
    createdBy: "creator@mydgv.com",
    lead: "lead@mydgv.com",
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
  return {
    ...keys.projectSide,
    type: "PROJECT_MEMBER",
    projectId,
    email: e,
    status,
  };
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
    taskVisibility: extra.taskVisibility,
  };
}

function restTask(id, extra = {}) {
  return {
    taskId: id,
    projectId: REST_ID,
    assignee: extra.assignee || "rahul@mydgv.com",
    assignees: extra.assignees || [extra.assignee || "rahul@mydgv.com"],
    archived: extra.archived,
    status: extra.status || "TODO",
    accessMode: extra.accessMode,
  };
}

function mockDdb(seedItems, { failGet } = {}) {
  const items = seedItems.slice();
  return {
    async send(command) {
      if (command.constructor.name === "GetCommand" || command instanceof GetCommand) {
        if (failGet) throw new Error("ddb get failed");
        const { TableName, Key } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        return { Item: found ? { ...found.Item } : undefined };
      }
      throw new Error(command.constructor.name);
    },
  };
}

function seedOpenAndRestricted() {
  return [
    { TableName: TABLE, Item: projectItem(OPEN_ID, { accessMode: "OPEN" }) },
    { TableName: TABLE, Item: projectItem(LEGACY_ID) },
    { TableName: TABLE, Item: projectItem(REST_ID, { accessMode: "RESTRICTED" }) },
  ];
}

function authz(ddb, user, task, extra = {}) {
  return authorizeTaskRead({
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    user,
    task,
    cache: extra.cache || createCache(),
  });
}

async function run() {
  {
    assert.strictEqual(
      canViewTask({ email: "boss@mydgv.com", isAdmin: true }, { assignee: "other@mydgv.com" }),
      false
    );
    const openProject = projectItem(OPEN_ID, { accessMode: "OPEN" });
    const adminAccess = accessRow("admin@mydgv.com", "ADMIN", "ACTIVE");
    assert.strictEqual(
      canViewTask(
        { email: "admin@mydgv.com", isAdmin: true },
        assigned,
        { project: openProject, accessRow: adminAccess }
      ),
      true
    );
    assert.strictEqual(
      canViewTask(
        { email: "rahul@mydgv.com", isAdmin: false },
        assigned,
        { project: openProject }
      ),
      true
    );
    assert.strictEqual(
      canViewTask(
        { email: "other@mydgv.com", isAdmin: false },
        assigned,
        { project: openProject }
      ),
      false
    );
    assert.strictEqual(canViewTask({ email: "", isAdmin: true }, assigned, { project: openProject }), false);
    assert.strictEqual(
      canViewTask(
        { email: "  Rahul@MyDGV.com ", isAdmin: false },
        assigned,
        { project: openProject }
      ),
      true
    );
    assert.strictEqual(
      canViewTask(
        { email: "boss@mydgv.com", isAdmin: true },
        assigned
      ),
      false
    );
  }

  {
    const project = projectItem(LEGACY_ID);
    assert.strictEqual(
      decideTaskRead({
        user: { email: "admin@mydgv.com", isAdmin: true },
        task: { ...assigned, projectId: LEGACY_ID },
        project,
        accessRow: accessRow("admin@mydgv.com", "ADMIN", "ACTIVE"),
      }).allowed,
      true
    );
    assert.strictEqual(
      decideTaskRead({
        user: { email: "rahul@mydgv.com", isAdmin: false },
        task: { ...assigned, projectId: LEGACY_ID },
        project,
      }).allowed,
      true
    );
  }

  const memberUser = { email: "  Rahul@MyDGV.com ", isAdmin: false };
  const adminUser = { email: "pa@mydgv.com", isAdmin: true };
  const outsiderAdmin = { email: "outsider@mydgv.com", isAdmin: true };
  const superUser = { email: "super@mydgv.com", isAdmin: true };
  const cognitoOnly = { email: "cog@mydgv.com", isAdmin: true };

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE") },
      { TableName: TABLE, Item: memberRow(REST_ID, memberUser.email) },
    ]);
    const allowed = await authz(ddb, memberUser, restTask("t1"));
    assert.strictEqual(allowed.ok, true);
    assert.strictEqual(allowed.allowed, true);
    const other = await authz(
      ddb,
      memberUser,
      restTask("t2", { assignee: "other@mydgv.com", assignees: ["other@mydgv.com"] })
    );
    assert.strictEqual(other.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(adminUser.email, "ADMIN", "ACTIVE") },
      {
        TableName: TABLE,
        Item: adminRow(REST_ID, adminUser.email, { taskVisibility: "ALL_PROJECT_TASKS" }),
      },
    ]);
    const all = await authz(
      ddb,
      adminUser,
      restTask("t3", { assignee: "rahul@mydgv.com" })
    );
    assert.strictEqual(all.allowed, true);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(adminUser.email, "ADMIN", "ACTIVE") },
      {
        TableName: TABLE,
        Item: adminRow(REST_ID, adminUser.email, { taskVisibility: "ASSIGNED_ONLY" }),
      },
    ]);
    const own = await authz(
      ddb,
      adminUser,
      restTask("t4", { assignee: adminUser.email, assignees: [adminUser.email] })
    );
    assert.strictEqual(own.allowed, true);
    const other = await authz(
      ddb,
      adminUser,
      restTask("t5", { assignee: "rahul@mydgv.com" })
    );
    assert.strictEqual(other.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE") },
    ]);
    const denied = await authz(ddb, outsiderAdmin, restTask("t6"));
    assert.strictEqual(denied.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(superUser.email, "SUPER_ADMIN", "ACTIVE") },
    ]);
    const denied = await authz(ddb, superUser, restTask("t7"));
    assert.strictEqual(denied.allowed, false);
  }

  {
    const ddb = mockDdb([...seedOpenAndRestricted()]);
    const denied = await authz(ddb, cognitoOnly, restTask("t8"));
    assert.strictEqual(denied.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE") },
      { TableName: TABLE, Item: memberRow(REST_ID, memberUser.email, "REVOKED") },
    ]);
    const denied = await authz(ddb, memberUser, restTask("t9"));
    assert.strictEqual(denied.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(adminUser.email, "ADMIN", "ACTIVE") },
      {
        TableName: TABLE,
        Item: adminRow(REST_ID, adminUser.email, {
          status: "REVOKED",
          taskVisibility: "ALL_PROJECT_TASKS",
        }),
      },
    ]);
    const denied = await authz(ddb, adminUser, restTask("t10"));
    assert.strictEqual(denied.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE") },
      { TableName: TABLE, Item: memberRow("other-project", memberUser.email) },
    ]);
    const denied = await authz(ddb, memberUser, restTask("t11"));
    assert.strictEqual(denied.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(adminUser.email, "ADMIN", "ACTIVE") },
      {
        TableName: TABLE,
        Item: adminRow(REST_ID, adminUser.email, { taskVisibility: "EVERYTHING" }),
      },
    ]);
    const other = await authz(
      ddb,
      adminUser,
      restTask("t12", { assignee: "rahul@mydgv.com" })
    );
    assert.strictEqual(other.allowed, false);
    const own = await authz(
      ddb,
      adminUser,
      restTask("t13", { assignee: adminUser.email, assignees: [adminUser.email] })
    );
    assert.strictEqual(own.allowed, true);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE") },
    ]);
    const denied = await authz(ddb, memberUser, restTask("t14"));
    assert.strictEqual(denied.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "BLOCKED") },
      { TableName: TABLE, Item: memberRow(REST_ID, memberUser.email) },
    ]);
    const denied = await authz(ddb, memberUser, restTask("t15"));
    assert.strictEqual(denied.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "PENDING") },
      { TableName: TABLE, Item: memberRow(REST_ID, memberUser.email) },
    ]);
    const denied = await authz(ddb, memberUser, restTask("t16"));
    assert.strictEqual(denied.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE") },
      { TableName: TABLE, Item: memberRow(REST_ID, memberUser.email) },
    ]);
    const memberOk = await authz(ddb, memberUser, {
      ...restTask("t17"),
      accessMode: "OPEN",
      projectId: REST_ID,
    });
    assert.strictEqual(memberOk.allowed, true);
    const outsider = await authz(ddb, outsiderAdmin, {
      ...restTask("t18", {
        assignee: outsiderAdmin.email,
        assignees: [outsiderAdmin.email],
      }),
      accessMode: "OPEN",
    });
    assert.strictEqual(outsider.allowed, false);
  }

  {
    const ddb = mockDdb(seedOpenAndRestricted(), { failGet: true });
    const failed = await authz(ddb, memberUser, restTask("t19"));
    assert.strictEqual(failed.ok, false);
    assert.notStrictEqual(failed.allowed, true);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE") },
      { TableName: TABLE, Item: memberRow(REST_ID, memberUser.email) },
      { TableName: ACCESS, Item: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE") },
    ]);
    const openTask = { ...assigned, taskId: "open-a", projectId: OPEN_ID };
    const restVisible = restTask("rest-a");
    const restHidden = restTask("rest-b", {
      assignee: "other@mydgv.com",
      assignees: ["other@mydgv.com"],
    });
    const listed = await filterVisibleTasks({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: memberUser,
      tasks: [openTask, restVisible, restHidden],
    });
    assert.strictEqual(listed.ok, true);
    assert.deepStrictEqual(
      listed.tasks.map((t) => t.taskId),
      ["open-a", "rest-a"]
    );
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE") },
    ]);
    const listed = await filterVisibleTasks({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      tasks: [restTask("hidden-1"), restTask("hidden-2")],
    });
    assert.strictEqual(listed.ok, true);
    assert.deepStrictEqual(listed.tasks, []);
  }

  {
    const ddb = mockDdb(seedOpenAndRestricted(), { failGet: true });
    const listed = await filterVisibleTasks({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      tasks: [restTask("boom")],
    });
    assert.strictEqual(listed.ok, false);
    assert.ok(!listed.tasks);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE") },
      { TableName: TABLE, Item: memberRow(REST_ID, memberUser.email) },
    ]);
    const task = restTask("dl-1");
    const ok = await authorizeAttachmentDownload({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: memberUser,
      task,
      taskId: task.taskId,
      objectKey: `tasks/${task.taskId}/file.pdf`,
    });
    assert.strictEqual(ok.allowed, true);
    const prefixOnly = await authorizeAttachmentDownload({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      task,
      taskId: task.taskId,
      objectKey: `tasks/${task.taskId}/file.pdf`,
    });
    assert.strictEqual(prefixOnly.allowed, false);
    const noTask = await authorizeAttachmentDownload({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      task: null,
      taskId: task.taskId,
      objectKey: `tasks/${task.taskId}/file.pdf`,
    });
    assert.strictEqual(noTask.allowed, false);
    const profile = await authorizeAttachmentDownload({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: memberUser,
      task: null,
      taskId: task.taskId,
      objectKey: "profiles/rahul@mydgv.com/pic.png",
    });
    assert.strictEqual(profile.allowed, true);
    const otherProfile = await authorizeAttachmentDownload({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: memberUser,
      task: null,
      taskId: task.taskId,
      objectKey: "profiles/outsider@mydgv.com/pic.png",
    });
    assert.strictEqual(otherProfile.allowed, false);
    const traversal = await authorizeAttachmentDownload({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: memberUser,
      task,
      taskId: task.taskId,
      objectKey: `tasks/${task.taskId}/../secret.pdf`,
    });
    assert.strictEqual(traversal.allowed, false);
  }

  {
    const ddb = mockDdb([
      { TableName: ACCESS, Item: accessRow("admin@mydgv.com", "ADMIN", "ACTIVE") },
      {
        TableName: TABLE,
        Item: memberRow("gone-1", "admin@mydgv.com"),
      },
    ]);
    const adminUser = { email: "admin@mydgv.com", isAdmin: true };
    const orphan = await authz(ddb, adminUser, {
      taskId: "orphan",
      projectId: "gone-1",
      assignee: "admin@mydgv.com",
      assignees: ["admin@mydgv.com"],
    });
    assert.strictEqual(orphan.ok, true);
    assert.strictEqual(orphan.allowed, false);
    const blank = await authz(ddb, adminUser, {
      taskId: "blank",
      projectId: "  ",
      assignee: "other@mydgv.com",
      assignees: ["other@mydgv.com"],
    });
    assert.strictEqual(blank.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedOpenAndRestricted(),
      { TableName: ACCESS, Item: accessRow("admin@mydgv.com", "ADMIN", "ACTIVE") },
      { TableName: ACCESS, Item: accessRow("mgr@mydgv.com", "MANAGER", "ACTIVE") },
      { TableName: ACCESS, Item: accessRow("pending@mydgv.com", "ADMIN", "PENDING") },
    ]);
    const openOther = {
      taskId: "open-admin",
      projectId: OPEN_ID,
      assignee: "rahul@mydgv.com",
      assignees: ["rahul@mydgv.com"],
    };
    const adminOk = await authz(ddb, { email: "admin@mydgv.com", isAdmin: true }, openOther);
    assert.strictEqual(adminOk.allowed, true);
    const mgr = await authz(ddb, { email: "mgr@mydgv.com", isAdmin: true }, openOther);
    assert.strictEqual(mgr.allowed, false);
    const pending = await authz(ddb, { email: "pending@mydgv.com", isAdmin: true }, openOther);
    assert.strictEqual(pending.allowed, false);
    const cog = await authz(ddb, { email: "cog@mydgv.com", isAdmin: true }, openOther);
    assert.strictEqual(cog.allowed, false);
  }

  {
    const src = fs.readFileSync(path.join(__dirname, "handler.js"), "utf8");
    assert.ok(src.includes("taskReadAccess"));
    assert.ok(src.includes("filterVisibleTasks"));
    assert.ok(src.includes("authorizeAttachmentDownload"));
    assert.ok(src.includes("denyUnlessTaskReadable"));
    assert.ok(!src.includes("taskPrefix && objectKey.startsWith(taskPrefix)"));
    assert.ok(!src.includes("PROJECT_ACL_RESTRICTED_CREATE"));
  }

  console.log("task read authorization tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

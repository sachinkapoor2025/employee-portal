const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const {
  decideTaskCreate,
  decideTaskDelete,
  decideTaskUpdate,
  decideCommentCreate,
  authorizeTaskCreate,
  authorizeTaskUpdate,
  authorizeTaskDelete,
  authorizeCommentCreate,
  assertRestrictedAssigneesAreMembers,
  CODE_ASSIGNEE_NOT_MEMBER,
} = require("./taskMutateAccess");
const { projectMemberKeys, projectAdminKeys } = require("./projectAccess");
const { createCache } = require("./taskReadAccess");

const TABLE = "work-table";
const ACCESS = "access-table";
const OPEN_ID = "open-1";
const LEGACY_ID = "legacy-1";
const REST_ID = "rest-1";
const OTHER_ID = "rest-other";

function projectItem(projectId, extra = {}) {
  return {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${projectId}`,
    projectId,
    name: projectId,
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

function seedProjects() {
  return [
    { TableName: TABLE, Item: projectItem(OPEN_ID, { accessMode: "OPEN" }) },
    { TableName: TABLE, Item: projectItem(LEGACY_ID) },
    { TableName: TABLE, Item: projectItem(REST_ID, { accessMode: "RESTRICTED" }) },
    { TableName: TABLE, Item: projectItem(OTHER_ID, { accessMode: "RESTRICTED" }) },
  ];
}

const memberUser = { email: "  Rahul@MyDGV.com ", isAdmin: false };
const paUser = { email: "pa@mydgv.com", isAdmin: true };
const outsiderAdmin = { email: "outsider@mydgv.com", isAdmin: true };
const superUser = { email: "super@mydgv.com", isAdmin: true };

function restTask(extra = {}) {
  return {
    taskId: extra.taskId || "t1",
    projectId: REST_ID,
    assignee: extra.assignee || "rahul@mydgv.com",
    assignees: extra.assignees || [extra.assignee || "rahul@mydgv.com"],
    accessMode: extra.accessMode,
  };
}

async function run() {
  const openProject = projectItem(OPEN_ID, { accessMode: "OPEN" });
  const legacyProject = projectItem(LEGACY_ID);
  const restProject = projectItem(REST_ID, { accessMode: "RESTRICTED" });

  const openAdminAccess = accessRow("admin@mydgv.com", "ADMIN", "ACTIVE");
  {
    assert.strictEqual(
      decideTaskCreate({
        user: { email: "admin@mydgv.com", isAdmin: true },
        project: openProject,
        accessRow: openAdminAccess,
      }).allowed,
      true
    );
    assert.strictEqual(
      decideTaskCreate({
        user: { email: "rahul@mydgv.com", isAdmin: false },
        project: openProject,
      }).allowed,
      false
    );
    assert.strictEqual(
      decideTaskCreate({
        user: { email: "admin@mydgv.com", isAdmin: true },
        project: legacyProject,
        accessRow: openAdminAccess,
      }).allowed,
      true
    );
    assert.strictEqual(
      decideTaskCreate({
        user: { email: "admin@mydgv.com", isAdmin: true },
        project: openProject,
      }).allowed,
      false
    );
    assert.strictEqual(
      decideTaskUpdate({
        user: { email: "rahul@mydgv.com", isAdmin: false },
        task: restTask(),
        project: openProject,
      }).allowed,
      true
    );
    const openAdmin = decideTaskUpdate({
      user: outsiderAdmin,
      task: restTask({ assignee: "rahul@mydgv.com" }),
      project: openProject,
      accessRow: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE"),
    });
    assert.strictEqual(openAdmin.allowed, true);
    assert.strictEqual(openAdmin.mayAdminMutate, true);
    assert.strictEqual(
      decideTaskDelete({
        user: outsiderAdmin,
        project: openProject,
        accessRow: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE"),
      }).allowed,
      true
    );
    assert.strictEqual(
      decideTaskDelete({
        user: { email: "mgr@mydgv.com", isAdmin: true },
        project: openProject,
        accessRow: accessRow("mgr@mydgv.com", "MANAGER", "ACTIVE"),
      }).allowed,
      false
    );
    assert.strictEqual(
      decideCommentCreate({
        user: { email: "rahul@mydgv.com", isAdmin: false },
        task: restTask(),
        project: openProject,
      }).allowed,
      true
    );
    assert.strictEqual(
      decideTaskCreate({
        user: { email: "admin@mydgv.com", isAdmin: true },
        project: null,
        accessRow: openAdminAccess,
      }).allowed,
      false
    );
  }

  {
    assert.strictEqual(decideTaskCreate({ user: { email: "", isAdmin: true }, project: openProject }).allowed, false);
    assert.strictEqual(decideTaskUpdate({ user: { email: "   ", isAdmin: true }, task: restTask(), project: openProject }).allowed, false);
  }

  const paAdminItem = adminRow(REST_ID, paUser.email, { taskVisibility: "ALL_PROJECT_TASKS" });
  const memberItem = memberRow(REST_ID, memberUser.email);
  const activeAccess = accessRow(paUser.email, "ADMIN", "ACTIVE");

  {
    assert.strictEqual(
      decideTaskCreate({
        user: paUser,
        project: restProject,
        projectAdminItem: paAdminItem,
        accessRow: activeAccess,
      }).allowed,
      true
    );
    assert.strictEqual(
      decideTaskCreate({
        user: memberUser,
        project: restProject,
        regularMemberItem: memberItem,
        accessRow: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE"),
      }).allowed,
      false
    );
    assert.strictEqual(
      decideTaskCreate({
        user: outsiderAdmin,
        project: restProject,
        accessRow: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE"),
      }).allowed,
      false
    );
    assert.strictEqual(
      decideTaskCreate({
        user: superUser,
        project: restProject,
        accessRow: accessRow(superUser.email, "SUPER_ADMIN", "ACTIVE"),
      }).allowed,
      false
    );
    assert.strictEqual(
      decideTaskDelete({
        user: outsiderAdmin,
        project: restProject,
        accessRow: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE"),
      }).allowed,
      false
    );
  }

  {
    const memberUpdate = decideTaskUpdate({
      user: memberUser,
      task: restTask(),
      project: restProject,
      regularMemberItem: memberItem,
      accessRow: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE"),
    });
    assert.strictEqual(memberUpdate.allowed, true);
    assert.strictEqual(memberUpdate.mayAdminMutate, false);

    const unassignedMember = decideTaskUpdate({
      user: memberUser,
      task: restTask({ assignee: "other@mydgv.com", assignees: ["other@mydgv.com"] }),
      project: restProject,
      regularMemberItem: memberItem,
      accessRow: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE"),
    });
    assert.strictEqual(unassignedMember.allowed, false);

    const paUpdate = decideTaskUpdate({
      user: paUser,
      task: restTask({ assignee: "rahul@mydgv.com" }),
      project: restProject,
      projectAdminItem: paAdminItem,
      accessRow: activeAccess,
    });
    assert.strictEqual(paUpdate.allowed, true);
    assert.strictEqual(paUpdate.mayAdminMutate, true);
  }

  {
    assert.strictEqual(
      decideTaskUpdate({
        user: outsiderAdmin,
        task: restTask({ assignee: outsiderAdmin.email, assignees: [outsiderAdmin.email] }),
        project: restProject,
        accessRow: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE"),
      }).allowed,
      false
    );
    assert.strictEqual(
      decideCommentCreate({
        user: outsiderAdmin,
        task: restTask(),
        project: restProject,
        accessRow: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE"),
      }).allowed,
      false
    );
  }

  {
    assert.strictEqual(
      decideTaskUpdate({
        user: memberUser,
        task: restTask(),
        project: restProject,
        regularMemberItem: memberRow(REST_ID, memberUser.email, "REVOKED"),
        accessRow: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE"),
      }).allowed,
      false
    );
    assert.strictEqual(
      decideTaskDelete({
        user: paUser,
        project: restProject,
        projectAdminItem: adminRow(REST_ID, paUser.email, { status: "REVOKED" }),
        accessRow: activeAccess,
      }).allowed,
      false
    );
    assert.strictEqual(
      decideTaskUpdate({
        user: memberUser,
        task: restTask(),
        project: restProject,
        regularMemberItem: memberRow(OTHER_ID, memberUser.email),
        accessRow: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE"),
      }).allowed,
      false
    );
    assert.strictEqual(
      decideTaskUpdate({
        user: memberUser,
        task: restTask(),
        project: restProject,
        regularMemberItem: memberItem,
        accessRow: accessRow(memberUser.email, "EMPLOYEE", "BLOCKED"),
      }).allowed,
      false
    );
    assert.strictEqual(
      decideTaskUpdate({
        user: memberUser,
        task: restTask(),
        project: restProject,
        regularMemberItem: memberItem,
        accessRow: accessRow(memberUser.email, "EMPLOYEE", "PENDING"),
      }).allowed,
      false
    );
  }

  {
    const fakeOpen = decideTaskUpdate({
      user: outsiderAdmin,
      task: restTask({ accessMode: "OPEN" }),
      project: restProject,
      accessRow: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE"),
    });
    assert.strictEqual(fakeOpen.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedProjects(),
      { TableName: ACCESS, Item: accessRow(paUser.email, "ADMIN", "ACTIVE") },
      { TableName: TABLE, Item: paAdminItem },
      { TableName: TABLE, Item: memberRow(REST_ID, "rahul@mydgv.com") },
    ]);
    const created = await authorizeTaskCreate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: paUser,
      projectId: REST_ID,
      cache: createCache(),
    });
    assert.strictEqual(created.allowed, true);
    const membersOk = await assertRestrictedAssigneesAreMembers({
      ddb,
      tableName: TABLE,
      project: created.project,
      emails: ["  Rahul@MyDGV.com "],
    });
    assert.strictEqual(membersOk.allowed, true);
    const outsider = await assertRestrictedAssigneesAreMembers({
      ddb,
      tableName: TABLE,
      project: created.project,
      emails: ["outsider@mydgv.com"],
    });
    assert.strictEqual(outsider.allowed, false);
    assert.strictEqual(outsider.code, CODE_ASSIGNEE_NOT_MEMBER);
  }

  {
    const ddb = mockDdb([
      ...seedProjects(),
      { TableName: ACCESS, Item: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE") },
    ]);
    const created = await authorizeTaskCreate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      projectId: REST_ID,
    });
    assert.strictEqual(created.allowed, false);
    const updated = await authorizeTaskUpdate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      task: restTask({ projectId: REST_ID }),
    });
    assert.strictEqual(updated.allowed, false);
    const deleted = await authorizeTaskDelete({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      task: restTask(),
    });
    assert.strictEqual(deleted.allowed, false);
    const comment = await authorizeCommentCreate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      task: restTask(),
    });
    assert.strictEqual(comment.allowed, false);
  }

  {
    const ddb = mockDdb([
      ...seedProjects(),
      { TableName: ACCESS, Item: accessRow(memberUser.email, "EMPLOYEE", "ACTIVE") },
      { TableName: TABLE, Item: memberItem },
    ]);
    const comment = await authorizeCommentCreate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: memberUser,
      task: restTask(),
    });
    assert.strictEqual(comment.allowed, true);
    const hidden = await authorizeCommentCreate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: memberUser,
      task: restTask({ assignee: "other@mydgv.com", assignees: ["other@mydgv.com"] }),
    });
    assert.strictEqual(hidden.allowed, false);
  }

  {
    const ddb = mockDdb(seedProjects(), { failGet: true });
    const created = await authorizeTaskCreate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: paUser,
      projectId: REST_ID,
    });
    assert.strictEqual(created.ok, false);
    const updated = await authorizeTaskUpdate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: paUser,
      task: restTask(),
    });
    assert.strictEqual(updated.ok, false);
  }

  {
    const ddb = mockDdb([
      ...seedProjects(),
      { TableName: ACCESS, Item: accessRow(paUser.email, "ADMIN", "ACTIVE") },
      { TableName: ACCESS, Item: accessRow(outsiderAdmin.email, "ADMIN", "ACTIVE") },
      { TableName: TABLE, Item: paAdminItem },
    ]);
    const openCreate = await authorizeTaskCreate({
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      user: outsiderAdmin,
      projectId: OPEN_ID,
    });
    assert.strictEqual(openCreate.allowed, true);
    const openAssign = await assertRestrictedAssigneesAreMembers({
      ddb,
      tableName: TABLE,
      project: openCreate.project,
      emails: ["anyone@mydgv.com"],
    });
    assert.strictEqual(openAssign.allowed, true);
  }

  {
    const src = fs.readFileSync(path.join(__dirname, "handler.js"), "utf8");
    assert.ok(src.includes("authorizeTaskCreate"));
    assert.ok(src.includes("authorizeTaskUpdate"));
    assert.ok(src.includes("authorizeTaskDelete"));
    assert.ok(src.includes("authorizeCommentCreate"));
    assert.ok(src.includes("assertRestrictedAssigneesAreMembers"));
    const createIdx = src.indexOf("authorizeTaskCreate");
    const persistIdx = src.indexOf("persistAssignmentsAndTask(item, assignments, { create: true })");
    assert.ok(createIdx > 0 && persistIdx > createIdx);
    const commentIdx = src.indexOf("authorizeCommentCreate");
    const commentWrite = src.indexOf("comment_added");
    assert.ok(commentIdx > 0 && commentWrite > commentIdx);
    const deleteIdx = src.indexOf("authorizeTaskDelete");
    const archiveIdx = src.indexOf('op: "archiveTask"');
    assert.ok(deleteIdx > 0 && archiveIdx > deleteIdx);
    assert.ok(src.includes("projectId: existing.projectId"));
    assert.ok(src.includes('const projectId = String(body.projectId || "").trim();'));
    assert.ok(src.includes("const projectId = String(projectIdRaw || \"\").trim();"));
    assert.ok(
      src.includes("persistAssignmentsAndTask(item, assignments, { create: true })")
    );
    assert.ok(!src.includes("PROJECT_ACL_RESTRICTED_CREATE"));
  }

  console.log("task mutation authorization tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

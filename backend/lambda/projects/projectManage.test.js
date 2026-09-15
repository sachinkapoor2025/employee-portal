const assert = require("assert");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  ACTION_ARCHIVED,
  ACTION_DELETED,
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  countActiveProjects,
  countProjectTasks,
  getProject,
  getProjectName,
  handleDeleteProject,
  handleListProjects,
  handlePatchProject,
  isActiveProject,
  projectPathMatch,
} = require("./projectManage");

const TABLE = "work-table";
const ACTIVE_ID = "project-active-1";
const EMPTY_ID = "project-empty-1";
const ARCHIVED_ID = "project-archived-1";
const MISSING_ID = "project-missing";
const NOW = "2026-09-15T11:30:00.000Z";
const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };
const EMPLOYEE = {
  email: "rahul@mydgv.com",
  groups: ["Employee"],
  isAdmin: false,
};

function createMemoryDdb() {
  const items = [];
  function keyOf(tableName, item) {
    return `${tableName}|${item.PK}|${item.SK}`;
  }
  return {
    items,
    seed(tableName, item) {
      const idx = items.findIndex(
        (row) => keyOf(row.TableName, row.Item) === keyOf(tableName, item)
      );
      const entry = { TableName: tableName, Item: { ...item } };
      if (idx >= 0) items[idx] = entry;
      else items.push(entry);
    },
    of(tableName) {
      return items
        .filter((row) => row.TableName === tableName)
        .map((row) => ({ ...row.Item }));
    },
    async send(command) {
      if (command instanceof GetCommand) {
        const { TableName, Key } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        return { Item: found ? { ...found.Item } : undefined };
      }
      if (command instanceof PutCommand) {
        this.seed(command.input.TableName, command.input.Item);
        return {};
      }
      if (command instanceof DeleteCommand) {
        const { TableName, Key } = command.input;
        const idx = items.findIndex(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        if (idx >= 0) items.splice(idx, 1);
        return {};
      }
      if (command instanceof QueryCommand) {
        const { TableName, ExpressionAttributeValues = {} } = command.input;
        const pk = ExpressionAttributeValues[":pk"];
        const skPrefix = ExpressionAttributeValues[":sk"];
        const found = items
          .filter((row) => row.TableName === TableName && row.Item.PK === pk)
          .filter((row) =>
            skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true
          )
          .map((row) => ({ ...row.Item }));
        return { Items: found, Count: found.length };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function projectItem({ projectId, name, status = "ACTIVE", extra = {} }) {
  return {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${projectId}`,
    projectId,
    name,
    client: "",
    lead: ADMIN.email,
    members: [],
    status,
    description: "",
    createdAt: "2026-09-01T00:00:00.000Z",
    createdBy: ADMIN.email,
    ...extra,
  };
}

function taskCopy({ projectId, taskId, archived = false, status = "TODO" }) {
  return {
    PK: `PROJECT#${projectId}`,
    SK: `TASK#${taskId}`,
    taskId,
    projectId,
    title: `Task ${taskId}`,
    status,
    archived,
  };
}

function entityTask(copy) {
  return {
    ...copy,
    PK: "ENTITY#TASK",
    SK: `TASK#${copy.taskId}`,
  };
}

function seedBase(ddb) {
  ddb.seed(TABLE, projectItem({ projectId: ACTIVE_ID, name: "Portal" }));
  ddb.seed(TABLE, projectItem({ projectId: EMPTY_ID, name: "Empty Project" }));
  ddb.seed(
    TABLE,
    projectItem({
      projectId: ARCHIVED_ID,
      name: "Legacy Archive",
      status: STATUS_ARCHIVED,
      extra: {
        archivedAt: "2026-09-10T00:00:00.000Z",
        archivedBy: ADMIN.email,
      },
    })
  );
}

async function del(ddb, { user = ADMIN, projectId, now = NOW } = {}) {
  return handleDeleteProject({
    user,
    projectId,
    ddb,
    tableName: TABLE,
    now,
  });
}

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    });
}

async function run() {
  await test("project path matcher", () => {
    assert.deepStrictEqual(projectPathMatch("/projects/abc-123"), {
      projectId: "abc-123",
    });
    assert.deepStrictEqual(projectPathMatch("/prod/projects/abc-123"), {
      projectId: "abc-123",
    });
    assert.deepStrictEqual(
      projectPathMatch("/projects/enc%20id", { projectId: "enc id" }),
      { projectId: "enc id" }
    );
    assert.strictEqual(projectPathMatch("/projects"), null);
    assert.strictEqual(projectPathMatch("/documents/projects/abc"), null);
    assert.strictEqual(projectPathMatch("/documents/projects/abc/folders"), null);
  });

  await test("A. DELETE nonexistent project returns 404", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { projectId: MISSING_ID });
    assert.strictEqual(result.statusCode, 404);
    assert.strictEqual(result.body.error, "Project not found");
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assert.ok(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("B. DELETE active project with zero tasks permanently deletes", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.action, ACTION_DELETED);
    assert.strictEqual(result.body.projectId, EMPTY_ID);
    assert.strictEqual(result.body.name, "Empty Project");
    assert.strictEqual(result.body.taskCount, 0);
    assert.strictEqual(await getProject(ddb, TABLE, EMPTY_ID), null);
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
  });

  await test("C. DELETE active project with tasks archives instead of deleting", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const copy = taskCopy({ projectId: ACTIVE_ID, taskId: "t1" });
    const entity = entityTask(copy);
    ddb.seed(TABLE, copy);
    ddb.seed(TABLE, entity);

    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.action, ACTION_ARCHIVED);
    assert.strictEqual(result.body.projectId, ACTIVE_ID);
    assert.strictEqual(result.body.name, "Portal");
    assert.strictEqual(result.body.taskCount, 1);

    const stored = await getProject(ddb, TABLE, ACTIVE_ID);
    assert.ok(stored);
    assert.strictEqual(stored.status, STATUS_ARCHIVED);
    assert.strictEqual(stored.archivedAt, NOW);
    assert.strictEqual(stored.archivedBy, ADMIN.email);
    assert.strictEqual(stored.name, "Portal");
  });

  await test("archived and completed task copies still force archive", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    ddb.seed(
      TABLE,
      taskCopy({
        projectId: ACTIVE_ID,
        taskId: "done-1",
        archived: true,
        status: "DONE",
      })
    );
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.body.action, ACTION_ARCHIVED);
    assert.strictEqual(result.body.taskCount, 1);
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
  });

  await test("D. archived project remains resolvable by getProjectName", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    ddb.seed(TABLE, taskCopy({ projectId: ACTIVE_ID, taskId: "t1" }));
    await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(
      await getProjectName(ddb, TABLE, ACTIVE_ID),
      "Portal"
    );
    assert.strictEqual(
      await getProjectName(ddb, TABLE, ARCHIVED_ID),
      "Legacy Archive"
    );
  });

  await test("E. GET /projects excludes ARCHIVED projects", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    ddb.seed(TABLE, taskCopy({ projectId: ACTIVE_ID, taskId: "t1" }));
    await del(ddb, { projectId: ACTIVE_ID });

    const listed = await handleListProjects({ ddb, tableName: TABLE });
    assert.strictEqual(listed.statusCode, 200);
    const ids = listed.body.map((p) => p.projectId).sort();
    assert.deepStrictEqual(ids, [EMPTY_ID]);
    assert.ok(listed.body.every((p) => isActiveProject(p)));
  });

  await test("legacy projects without status remain ACTIVE in the list", async () => {
    const ddb = createMemoryDdb();
    ddb.seed(
      TABLE,
      projectItem({
        projectId: "legacy",
        name: "Legacy",
        status: undefined,
        extra: { status: undefined },
      })
    );
    const listed = await handleListProjects({ ddb, tableName: TABLE });
    assert.strictEqual(listed.body.length, 1);
    assert.strictEqual(listed.body[0].projectId, "legacy");
  });

  await test("F. existing task references remain untouched when archived", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const copy = taskCopy({ projectId: ACTIVE_ID, taskId: "keep-1" });
    const entity = entityTask(copy);
    ddb.seed(TABLE, copy);
    ddb.seed(TABLE, entity);
    const before = ddb.of(TABLE).filter((item) => item.taskId === "keep-1");

    await del(ddb, { projectId: ACTIVE_ID });

    const after = ddb.of(TABLE).filter((item) => item.taskId === "keep-1");
    assert.strictEqual(after.length, 2);
    assert.deepStrictEqual(after, before);
    assert.strictEqual(await countProjectTasks(ddb, TABLE, ACTIVE_ID), 1);
  });

  await test("G. employee cannot DELETE /projects/{projectId}", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { user: EMPLOYEE, projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.body.error, "Admin required");
    assert.ok(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("dashboard KPI counts only ACTIVE projects", () => {
    const items = [
      { projectId: "a", status: "ACTIVE" },
      { projectId: "b", status: "ARCHIVED" },
      { projectId: "c" },
    ];
    assert.strictEqual(countActiveProjects(items), 2);
  });

  await test("GET /projects default and ACTIVE return only active projects", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const def = await handleListProjects({ ddb, tableName: TABLE });
    const active = await handleListProjects({
      ddb,
      tableName: TABLE,
      status: "ACTIVE",
    });
    const ids = def.body.map((p) => p.projectId).sort();
    assert.deepStrictEqual(ids, [ACTIVE_ID, EMPTY_ID].sort());
    assert.deepStrictEqual(
      active.body.map((p) => p.projectId).sort(),
      ids
    );
  });

  await test("GET /projects?status=ARCHIVED returns archived only", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const listed = await handleListProjects({
      ddb,
      tableName: TABLE,
      status: "ARCHIVED",
    });
    assert.deepStrictEqual(
      listed.body.map((p) => p.projectId),
      [ARCHIVED_ID]
    );
  });

  await test("GET /projects?status=ALL returns active and archived", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const listed = await handleListProjects({
      ddb,
      tableName: TABLE,
      status: "all",
    });
    assert.strictEqual(listed.statusCode, 200);
    assert.strictEqual(listed.body.length, 3);
  });

  await test("GET /projects rejects invalid status", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const listed = await handleListProjects({
      ddb,
      tableName: TABLE,
      status: "DELETED",
    });
    assert.strictEqual(listed.statusCode, 400);
  });

  await test("PATCH edits name client description", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await handlePatchProject({
      user: ADMIN,
      projectId: EMPTY_ID,
      body: {
        name: "Empty Renamed",
        client: "Acme",
        description: "Updated",
      },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.name, "Empty Renamed");
    assert.strictEqual(result.body.client, "Acme");
    assert.strictEqual(result.body.description, "Updated");
    assert.strictEqual(result.body.createdBy, ADMIN.email);
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.strictEqual(stored.name, "Empty Renamed");
  });

  await test("PATCH rejects duplicate active name", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await handlePatchProject({
      user: ADMIN,
      projectId: EMPTY_ID,
      body: { name: " portal " },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 409);
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.strictEqual(stored.name, "Empty Project");
  });

  await test("PATCH archive works with zero tasks", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await handlePatchProject({
      user: ADMIN,
      projectId: EMPTY_ID,
      body: { status: "ARCHIVED" },
      ddb,
      tableName: TABLE,
      now: NOW,
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, STATUS_ARCHIVED);
    assert.strictEqual(result.body.archivedAt, NOW);
    assert.strictEqual(result.body.archivedBy, ADMIN.email);
    assert.ok(await getProject(ddb, TABLE, EMPTY_ID));
    const listed = await handleListProjects({ ddb, tableName: TABLE });
    assert.ok(!listed.body.some((p) => p.projectId === EMPTY_ID));
  });

  await test("PATCH restore returns a project to ACTIVE", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await handlePatchProject({
      user: ADMIN,
      projectId: ARCHIVED_ID,
      body: { status: "ACTIVE" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, STATUS_ACTIVE);
    assert.strictEqual(result.body.archivedAt, undefined);
    assert.strictEqual(result.body.archivedBy, undefined);
    const listed = await handleListProjects({ ddb, tableName: TABLE });
    assert.ok(listed.body.some((p) => p.projectId === ARCHIVED_ID));
  });

  await test("PATCH restore rejects duplicate active name", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    ddb.seed(
      TABLE,
      projectItem({
        projectId: ARCHIVED_ID,
        name: "Portal",
        status: STATUS_ARCHIVED,
        extra: { archivedAt: NOW, archivedBy: ADMIN.email },
      })
    );
    const result = await handlePatchProject({
      user: ADMIN,
      projectId: ARCHIVED_ID,
      body: { status: "ACTIVE" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 409);
  });

  await test("PATCH missing project and invalid status", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const missing = await handlePatchProject({
      user: ADMIN,
      projectId: MISSING_ID,
      body: { name: "X" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(missing.statusCode, 404);
    const invalid = await handlePatchProject({
      user: ADMIN,
      projectId: EMPTY_ID,
      body: { status: "DELETED" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(invalid.statusCode, 400);
    const empty = await handlePatchProject({
      user: ADMIN,
      projectId: EMPTY_ID,
      body: {},
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(empty.statusCode, 400);
  });

  await test("employee cannot PATCH /projects/{projectId}", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await handlePatchProject({
      user: EMPLOYEE,
      projectId: EMPTY_ID,
      body: { name: "Nope" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 403);
  });

  await test("PATCH archive leaves task copies untouched", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const copy = taskCopy({ projectId: ACTIVE_ID, taskId: "keep-2" });
    ddb.seed(TABLE, copy);
    ddb.seed(TABLE, entityTask(copy));
    const before = ddb.of(TABLE).filter((item) => item.taskId === "keep-2");
    await handlePatchProject({
      user: ADMIN,
      projectId: ACTIVE_ID,
      body: { status: "ARCHIVED" },
      ddb,
      tableName: TABLE,
      now: NOW,
    });
    const after = ddb.of(TABLE).filter((item) => item.taskId === "keep-2");
    assert.deepStrictEqual(after, before);
    assert.strictEqual(await getProjectName(ddb, TABLE, ACTIVE_ID), "Portal");
  });

  await test("PATCH archived project can keep a name that matches an active project", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    ddb.seed(
      TABLE,
      projectItem({
        projectId: ARCHIVED_ID,
        name: "Portal",
        status: STATUS_ARCHIVED,
        extra: { archivedAt: NOW, archivedBy: ADMIN.email },
      })
    );
    const result = await handlePatchProject({
      user: ADMIN,
      projectId: ARCHIVED_ID,
      body: { name: "Portal", client: "Kept" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.client, "Kept");
    assert.strictEqual(result.body.status, STATUS_ARCHIVED);
  });

  console.log(`${passed} project management tests passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

const assert = require("assert");
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  ACTION_ARCHIVED,
  ACTION_DELETED,
  CONFIRM_NAME_MISMATCH,
  CONFIRM_NAME_REQUIRED,
  DYNAMO_BATCH_LIMIT,
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  confirmationNameOf,
  countActiveProjects,
  countProjectTasks,
  getProject,
  getProjectName,
  handleDeleteProject,
  handleListProjects,
  handlePatchProject,
  isActiveProject,
  isSafeTaskAttachmentKey,
  namesMatch,
  projectPathMatch,
} = require("./projectManage");

const TABLE = "work-table";
const ATTACH_BUCKET = "task-attachments";
const DOCS_BUCKET = "documents-bucket";
const ACTIVE_ID = "project-active-1";
const EMPTY_ID = "project-empty-1";
const ARCHIVED_ID = "project-archived-1";
const MISSING_ID = "project-missing";
const OTHER_ID = "project-other-1";
const NOW = "2026-09-15T11:30:00.000Z";
const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };
const EMPLOYEE = {
  email: "rahul@mydgv.com",
  groups: ["Employee"],
  isAdmin: false,
};
const NAMES = {
  [ACTIVE_ID]: "Portal",
  [EMPTY_ID]: "Empty Project",
  [ARCHIVED_ID]: "Legacy Archive",
  [OTHER_ID]: "Other Project",
};

function createMemoryDdb(options = {}) {
  const items = [];
  const unprocessedRounds = Number(options.unprocessedRounds || 0);
  let unprocessedLeft = unprocessedRounds;
  function keyOf(tableName, item) {
    return `${tableName}|${item.PK}|${item.SK}`;
  }
  return {
    items,
    batchWriteSizes: [],
    deletedKeys: [],
    putItems: [],
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
    remove(tableName, Key) {
      const idx = items.findIndex(
        (row) =>
          row.TableName === tableName &&
          row.Item.PK === Key.PK &&
          row.Item.SK === Key.SK
      );
      if (idx >= 0) {
        this.deletedKeys.push({ ...Key });
        items.splice(idx, 1);
      }
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
        this.putItems.push({ ...command.input.Item });
        this.seed(command.input.TableName, command.input.Item);
        return {};
      }
      if (command instanceof DeleteCommand) {
        const { TableName, Key } = command.input;
        this.remove(TableName, Key);
        return {};
      }
      if (command instanceof BatchWriteCommand) {
        const tableName = Object.keys(command.input.RequestItems || {})[0];
        const reqs = command.input.RequestItems?.[tableName] || [];
        this.batchWriteSizes.push(reqs.length);
        if (options.failBatch) {
          throw new Error("simulated batch write failure");
        }
        if (unprocessedLeft > 0) {
          unprocessedLeft -= 1;
          return { UnprocessedItems: { [tableName]: reqs } };
        }
        for (const req of reqs) {
          const Key = req.DeleteRequest?.Key;
          if (Key) this.remove(tableName, Key);
        }
        return { UnprocessedItems: {} };
      }
      if (command instanceof QueryCommand) {
        const {
          TableName,
          ExpressionAttributeValues = {},
          Limit,
          ExclusiveStartKey,
        } = command.input;
        const pk = ExpressionAttributeValues[":pk"];
        const skPrefix = ExpressionAttributeValues[":sk"];
        let found = items
          .filter((row) => row.TableName === TableName && row.Item.PK === pk)
          .filter((row) =>
            skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true
          )
          .map((row) => ({ ...row.Item }));
        found.sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
        if (ExclusiveStartKey) {
          const idx = found.findIndex(
            (item) =>
              item.PK === ExclusiveStartKey.PK &&
              item.SK === ExclusiveStartKey.SK
          );
          found = idx >= 0 ? found.slice(idx + 1) : found;
        }
        const sliced =
          Number.isFinite(Number(Limit)) && Number(Limit) > 0
            ? found.slice(0, Number(Limit))
            : found;
        const last = sliced[sliced.length - 1];
        const lastKey =
          last && sliced.length < found.length
            ? { PK: last.PK, SK: last.SK }
            : undefined;
        return {
          Items: sliced,
          Count: sliced.length,
          LastEvaluatedKey: lastKey,
        };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function createMemoryS3({ objects = {}, failKeys = [] } = {}) {
  const denied = new Set(failKeys);
  return {
    objects: { ...objects },
    deleted: [],
    buckets: [],
    async send(command) {
      if (!(command instanceof DeleteObjectsCommand)) {
        throw new Error(`unexpected s3 command ${command.constructor?.name}`);
      }
      const bucket = command.input.Bucket;
      this.buckets.push(bucket);
      const keys = (command.input.Delete?.Objects || []).map((row) => row.Key);
      const Errors = [];
      const Deleted = [];
      for (const Key of keys) {
        if (denied.has(Key)) {
          Errors.push({ Key, Code: "AccessDenied", Message: "denied" });
          continue;
        }
        Deleted.push({ Key });
        this.deleted.push(Key);
        delete this.objects[Key];
      }
      return { Deleted, Errors };
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

function childItem(taskId, sk, extra = {}) {
  return {
    PK: `TASK#${taskId}`,
    SK: sk,
    taskId,
    ...extra,
  };
}

function seedTaskGraph(
  ddb,
  {
    projectId = ACTIVE_ID,
    taskId,
    status = "TODO",
    archived = false,
    children = [],
  }
) {
  const copy = taskCopy({ projectId, taskId, status, archived });
  ddb.seed(TABLE, copy);
  ddb.seed(TABLE, entityTask(copy));
  for (const child of children) {
    ddb.seed(TABLE, childItem(taskId, child.SK, child));
  }
  return copy;
}

function seedRetained(ddb, projectId = ACTIVE_ID) {
  ddb.seed(TABLE, {
    PK: "ENTITY#TASK_IMPORT",
    SK: "IMPORT#2026-09-01T00:00:00.000Z#batch-1",
    batchId: "batch-1",
    type: "TASK_IMPORT",
    projectId,
  });
  ddb.seed(TABLE, {
    PK: "IMPORT#batch-1",
    SK: "META",
    batchId: "batch-1",
    type: "TASK_IMPORT",
    s3Key: "task-imports/admin@mydgv.com/batch-1/original.xlsx",
  });
  ddb.seed(TABLE, {
    PK: "IMPORT#batch-1",
    SK: "ROW#000001",
    batchId: "batch-1",
    type: "TASK_IMPORT_ROW",
    projectId,
    taskId: "imported-task",
  });
  ddb.seed(TABLE, {
    PK: `USER#${ADMIN.email}`,
    SK: "NOTIFY#2026-09-01T00:00:00.000Z#n1",
    notifyId: "n1",
    extra: { taskId: "t1", projectId },
  });
  ddb.seed(TABLE, {
    PK: `USER#${ADMIN.email}`,
    SK: "REMINDER#TASK_ASSIGNED#t1#admin@mydgv.com",
    type: "TASK_ASSIGNED",
    dedupKey: "t1#admin@mydgv.com",
  });
  ddb.seed(TABLE, {
    PK: `USER#${ADMIN.email}`,
    SK: "TIME#2026-09-01T00:00:00.000Z#time-1",
    timeId: "time-1",
    taskId: "t1",
    projectId,
    minutes: 30,
  });
  ddb.seed(TABLE, {
    PK: ADMIN.email,
    SK: ADMIN.email,
    email: ADMIN.email,
    name: "Admin",
  });
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
  ddb.seed(TABLE, projectItem({ projectId: OTHER_ID, name: "Other Project" }));
}

function noSleep() {
  return Promise.resolve();
}

async function del(
  ddb,
  {
    user = ADMIN,
    projectId,
    body,
    query,
    s3,
    attachmentsBucket = ATTACH_BUCKET,
    documentsBucket = DOCS_BUCKET,
    confirmName,
    maxAttempts,
    dynamoBatchLimit,
    s3DeleteLimit,
  } = {}
) {
  const resolvedConfirm =
    confirmName !== undefined
      ? confirmName
      : body
        ? undefined
        : NAMES[projectId] || "";
  return handleDeleteProject({
    user,
    projectId,
    body:
      body !== undefined
        ? body
        : { confirmName: resolvedConfirm },
    query: query || {},
    ddb,
    s3,
    tableName: TABLE,
    attachmentsBucket,
    documentsBucket,
    sleep: noSleep,
    maxAttempts,
    dynamoBatchLimit,
    s3DeleteLimit,
  });
}

function assertNoArchiveWrite(ddb) {
  assert.ok(
    ddb.putItems.every(
      (item) => String(item.status || "").toUpperCase() !== ACTION_ARCHIVED
    )
  );
}

function assertProjectOwnedGone(ddb, projectId, taskIds) {
  const remaining = ddb.of(TABLE).filter((item) => {
    if (item.PK === `PROJECT#${projectId}` && String(item.SK).startsWith("TASK#")) {
      return true;
    }
    if (item.PK === "ENTITY#TASK" && taskIds.includes(item.taskId)) {
      return true;
    }
    if (taskIds.some((taskId) => item.PK === `TASK#${taskId}`)) {
      return true;
    }
    return false;
  });
  assert.deepStrictEqual(remaining, []);
}

function assertRetained(ddb) {
  const items = ddb.of(TABLE);
  assert.ok(items.some((item) => item.PK === "ENTITY#TASK_IMPORT"));
  assert.ok(items.some((item) => item.PK === "IMPORT#batch-1" && item.SK === "META"));
  assert.ok(items.some((item) => item.PK === "IMPORT#batch-1" && item.SK === "ROW#000001"));
  assert.ok(items.some((item) => String(item.SK).startsWith("NOTIFY#")));
  assert.ok(items.some((item) => String(item.SK).startsWith("REMINDER#")));
  assert.ok(items.some((item) => String(item.SK).startsWith("TIME#")));
  assert.ok(items.some((item) => item.PK === ADMIN.email && item.SK === ADMIN.email));
  assert.ok(items.some((item) => item.projectId === OTHER_ID));
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

  await test("confirmation name helper uses body and query", () => {
    assert.strictEqual(confirmationNameOf({ confirmName: " Portal " }), "Portal");
    assert.strictEqual(
      confirmationNameOf({}, { confirmationName: "Portal" }),
      "Portal"
    );
    assert.strictEqual(confirmationNameOf({ name: "Portal" }), "Portal");
    assert.strictEqual(confirmationNameOf({}), "");
    assert.ok(namesMatch("Portal", " portal "));
  });

  await test("safe S3 key validation", () => {
    assert.strictEqual(
      isSafeTaskAttachmentKey("tasks/t1/123-file.pdf", "t1"),
      true
    );
    assert.strictEqual(
      isSafeTaskAttachmentKey("/tasks/t1/123-file.pdf", "t1"),
      true
    );
    assert.strictEqual(
      isSafeTaskAttachmentKey("tasks/t1/../secret.pdf", "t1"),
      false
    );
    assert.strictEqual(
      isSafeTaskAttachmentKey("tasks/t1/foo/../../etc/passwd", "t1"),
      false
    );
    assert.strictEqual(
      isSafeTaskAttachmentKey("C:\\windows\\file.pdf", "t1"),
      false
    );
    assert.strictEqual(
      isSafeTaskAttachmentKey("profiles/admin@mydgv.com/pic.png", "t1"),
      false
    );
    assert.strictEqual(
      isSafeTaskAttachmentKey(
        "task-imports/admin@mydgv.com/batch-1/original.xlsx",
        "t1"
      ),
      false
    );
    assert.strictEqual(
      isSafeTaskAttachmentKey("tasks/other/123-file.pdf", "t1"),
      false
    );
  });

  await test("1. missing project-name confirmation", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { projectId: EMPTY_ID, body: {} });
    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(result.body.error, CONFIRM_NAME_REQUIRED);
    assert.ok(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("2. incorrect project-name confirmation", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, {
      projectId: EMPTY_ID,
      body: { confirmName: "Wrong Name" },
    });
    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(result.body.error, CONFIRM_NAME_MISMATCH);
    assert.ok(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("3. valid project-name confirmation is case-insensitive", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, {
      projectId: EMPTY_ID,
      body: { confirmName: " empty project " },
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.action, ACTION_DELETED);
    assert.strictEqual(await getProject(ddb, TABLE, EMPTY_ID), null);
  });

  await test("4. unauthorized user", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { user: EMPLOYEE, projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.body.error, "Admin required");
    assert.ok(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("5. missing project", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { projectId: MISSING_ID, confirmName: "X" });
    assert.strictEqual(result.statusCode, 404);
    assert.strictEqual(result.body.error, "Project not found");
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assert.ok(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("6. ACTIVE project deletion", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.action, ACTION_DELETED);
    assert.strictEqual(result.body.projectId, EMPTY_ID);
    assert.strictEqual(result.body.taskCount, 0);
    assert.strictEqual(await getProject(ddb, TABLE, EMPTY_ID), null);
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assertNoArchiveWrite(ddb);
  });

  await test("7. ARCHIVED project deletion", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { projectId: ARCHIVED_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.action, ACTION_DELETED);
    assert.strictEqual(await getProject(ddb, TABLE, ARCHIVED_ID), null);
    assertNoArchiveWrite(ddb);
  });

  await test("8-10. active, completed, and archived tasks are deleted", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedRetained(ddb);
    seedTaskGraph(ddb, { taskId: "active-1", status: "TODO" });
    seedTaskGraph(ddb, { taskId: "done-1", status: "DONE" });
    seedTaskGraph(ddb, {
      taskId: "archived-1",
      status: "TODO",
      archived: true,
    });
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.action, ACTION_DELETED);
    assert.strictEqual(result.body.taskCount, 3);
    assert.strictEqual(await getProject(ddb, TABLE, ACTIVE_ID), null);
    assertProjectOwnedGone(ddb, ACTIVE_ID, ["active-1", "done-1", "archived-1"]);
    assertRetained(ddb);
    assertNoArchiveWrite(ddb);
  });

  await test("11. pagination of project task discovery", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, { taskId: "t-a" });
    seedTaskGraph(ddb, { taskId: "t-b" });
    seedTaskGraph(ddb, { taskId: "t-c" });
    const orig = ddb.send.bind(ddb);
    let copyQueries = 0;
    ddb.send = async (command) => {
      if (
        command instanceof QueryCommand &&
        command.input.ExpressionAttributeValues?.[":pk"] === `PROJECT#${ACTIVE_ID}`
      ) {
        command.input.Limit = 1;
        copyQueries += 1;
      }
      return orig(command);
    };
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.taskCount, 3);
    assert.ok(copyQueries >= 3);
    assertProjectOwnedGone(ddb, ACTIVE_ID, ["t-a", "t-b", "t-c"]);
  });

  await test("12. pagination of canonical task discovery", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    ddb.seed(
      TABLE,
      entityTask(taskCopy({ projectId: ACTIVE_ID, taskId: "orphan-a" }))
    );
    ddb.seed(
      TABLE,
      entityTask(taskCopy({ projectId: ACTIVE_ID, taskId: "orphan-b" }))
    );
    ddb.seed(
      TABLE,
      entityTask(taskCopy({ projectId: OTHER_ID, taskId: "other-task" }))
    );
    const orig = ddb.send.bind(ddb);
    let entityQueries = 0;
    ddb.send = async (command) => {
      if (
        command instanceof QueryCommand &&
        command.input.ExpressionAttributeValues?.[":pk"] === "ENTITY#TASK"
      ) {
        command.input.Limit = 1;
        entityQueries += 1;
      }
      return orig(command);
    };
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.taskCount, 2);
    assert.ok(entityQueries >= 2);
    assert.strictEqual(
      ddb.of(TABLE).some((item) => item.taskId === "orphan-a"),
      false
    );
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "other-task"));
  });

  await test("13. duplicate task IDs are deleted once", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const copy = taskCopy({ projectId: ACTIVE_ID, taskId: "dup-1" });
    ddb.seed(TABLE, copy);
    ddb.seed(TABLE, entityTask(copy));
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.taskCount, 1);
    const deletedTaskKeys = ddb.deletedKeys.filter(
      (key) => key.SK === "TASK#dup-1"
    );
    assert.strictEqual(deletedTaskKeys.length, 2);
    assertProjectOwnedGone(ddb, ACTIVE_ID, ["dup-1"]);
  });

  await test("14-17. child records, copies, and canonical tasks are deleted", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, {
      taskId: "child-1",
      children: [
        { SK: "ASSIGNMENT#rahul@mydgv.com", email: "rahul@mydgv.com" },
        { SK: "COMMENT#2026-09-01T00:00:00.000Z#c1", text: "hello" },
        { SK: "ACTIVITY#2026-09-01T00:00:00.000Z#a1", action: "created" },
        {
          SK: "ATTACHMENT#att-1",
          attachmentId: "att-1",
          s3Key: "tasks/child-1/1-file.pdf",
        },
      ],
    });
    const s3 = createMemoryS3({
      objects: { "tasks/child-1/1-file.pdf": true },
    });
    const result = await del(ddb, { projectId: ACTIVE_ID, s3 });
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(s3.deleted, ["tasks/child-1/1-file.pdf"]);
    assert.deepStrictEqual(s3.buckets, [ATTACH_BUCKET]);
    assertProjectOwnedGone(ddb, ACTIVE_ID, ["child-1"]);
  });

  await test("18. DynamoDB BatchWrite chunks at 25 items", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const children = [];
    for (let i = 0; i < 24; i += 1) {
      children.push({ SK: `COMMENT#2026-09-01T00:00:00.000Z#c${i}` });
    }
    seedTaskGraph(ddb, { taskId: "chunk-1", children });
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.ok(ddb.batchWriteSizes.length >= 2);
    assert.ok(ddb.batchWriteSizes.every((size) => size <= DYNAMO_BATCH_LIMIT));
    assert.ok(ddb.batchWriteSizes.includes(DYNAMO_BATCH_LIMIT));
  });

  await test("19. DynamoDB UnprocessedItems retry", async () => {
    const ddb = createMemoryDdb({ unprocessedRounds: 1 });
    seedBase(ddb);
    seedTaskGraph(ddb, { taskId: "retry-1" });
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.ok(ddb.batchWriteSizes.length >= 2);
    assertProjectOwnedGone(ddb, ACTIVE_ID, ["retry-1"]);
  });

  await test("20. bounded retry failure", async () => {
    const ddb = createMemoryDdb({ unprocessedRounds: 10 });
    seedBase(ddb);
    seedTaskGraph(ddb, { taskId: "fail-1" });
    const result = await del(ddb, { projectId: ACTIVE_ID, maxAttempts: 3 });
    assert.strictEqual(result.statusCode, 500);
    assert.strictEqual(result.body.code, "PROJECT_DELETE_UNPROCESSED");
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "fail-1"));
    assertNoArchiveWrite(ddb);
  });

  await test("21. registered attachment discovery", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, {
      taskId: "att-task",
      children: [
        {
          SK: "ATTACHMENT#keep",
          s3Key: "tasks/att-task/ok.pdf",
        },
      ],
    });
    const s3 = createMemoryS3({ objects: { "tasks/att-task/ok.pdf": true } });
    const result = await del(ddb, { projectId: ACTIVE_ID, s3 });
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(s3.deleted, ["tasks/att-task/ok.pdf"]);
  });

  await test("22-25. unsafe, traversal, profile, and import keys are rejected", async () => {
    const cases = [
      "tasks/t-unsafe/../secret.pdf",
      "profiles/admin@mydgv.com/pic.png",
      "task-imports/admin@mydgv.com/batch-1/original.xlsx",
    ];
    for (const s3Key of cases) {
      const ddb = createMemoryDdb();
      seedBase(ddb);
      seedTaskGraph(ddb, {
        taskId: "t-unsafe",
        children: [{ SK: "ATTACHMENT#bad", s3Key }],
      });
      const s3 = createMemoryS3({ objects: { [s3Key]: true } });
      const result = await del(ddb, { projectId: ACTIVE_ID, s3 });
      assert.strictEqual(result.statusCode, 500);
      assert.strictEqual(result.body.code, "PROJECT_DELETE_UNSAFE_S3_KEY");
      assert.strictEqual(s3.deleted.length, 0);
      assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
      assert.ok(s3.objects[s3Key]);
    }
  });

  await test("26. DocumentsBucket exclusion", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, {
      taskId: "docs-1",
      children: [
        {
          SK: "ATTACHMENT#a1",
          s3Key: "tasks/docs-1/file.pdf",
        },
      ],
    });
    const s3 = createMemoryS3({
      objects: { "tasks/docs-1/file.pdf": true },
    });
    const result = await del(ddb, {
      projectId: ACTIVE_ID,
      s3,
      attachmentsBucket: DOCS_BUCKET,
      documentsBucket: DOCS_BUCKET,
    });
    assert.strictEqual(result.statusCode, 500);
    assert.strictEqual(result.body.code, "PROJECT_DELETE_S3_FAILED");
    assert.strictEqual(s3.deleted.length, 0);
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
  });

  await test("27. S3 deletion failure blocks success", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, {
      taskId: "s3-fail",
      children: [
        { SK: "ATTACHMENT#a1", s3Key: "tasks/s3-fail/file.pdf" },
      ],
    });
    const s3 = createMemoryS3({
      objects: { "tasks/s3-fail/file.pdf": true },
      failKeys: ["tasks/s3-fail/file.pdf"],
    });
    const result = await del(ddb, {
      projectId: ACTIVE_ID,
      s3,
      maxAttempts: 2,
    });
    assert.strictEqual(result.statusCode, 500);
    assert.strictEqual(result.body.code, "PROJECT_DELETE_S3_FAILED");
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "s3-fail"));
    assertNoArchiveWrite(ddb);
  });

  await test("28. missing S3 object is idempotent", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, {
      taskId: "s3-missing",
      children: [
        { SK: "ATTACHMENT#a1", s3Key: "tasks/s3-missing/gone.pdf" },
      ],
    });
    const s3 = createMemoryS3();
    const result = await del(ddb, { projectId: ACTIVE_ID, s3 });
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(s3.deleted, ["tasks/s3-missing/gone.pdf"]);
    assert.strictEqual(await getProject(ddb, TABLE, ACTIVE_ID), null);
  });

  await test("29-32. import history, users, notifies, and time entries are retained", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedRetained(ddb);
    seedTaskGraph(ddb, { taskId: "keep-side" });
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    assertRetained(ddb);
  });

  await test("33. project item is deleted last", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, { taskId: "last-1" });
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    const last = ddb.deletedKeys[ddb.deletedKeys.length - 1];
    assert.deepStrictEqual(last, {
      PK: "ENTITY#PROJECT",
      SK: `PROJECT#${ACTIVE_ID}`,
    });
    assert.ok(
      ddb.deletedKeys.some(
        (key) => key.PK === "ENTITY#TASK" && key.SK === "TASK#last-1"
      )
    );
  });

  await test("34. verification failure blocks success", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, { taskId: "verify-1" });
    const orig = ddb.send.bind(ddb);
    let batchDone = false;
    ddb.send = async (command) => {
      const res = await orig(command);
      if (command instanceof BatchWriteCommand) {
        batchDone = true;
        ddb.seed(
          TABLE,
          taskCopy({ projectId: ACTIVE_ID, taskId: "verify-1" })
        );
      }
      if (batchDone && command instanceof DeleteCommand) {
        throw new Error("project delete should not run after verify failure");
      }
      return res;
    };
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 500);
    assert.strictEqual(result.body.code, "PROJECT_DELETE_VERIFY_FAILED");
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assertNoArchiveWrite(ddb);
  });

  await test("35. DELETE never writes ARCHIVED", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, { taskId: "no-archive" });
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.notStrictEqual(result.body.action, ACTION_ARCHIVED);
    assertNoArchiveWrite(ddb);
  });

  await test("36. no task records remain after successful cleanup", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedRetained(ddb);
    seedTaskGraph(ddb, {
      taskId: "final-1",
      children: [
        { SK: "ASSIGNMENT#rahul@mydgv.com" },
        { SK: "ACTIVITY#2026-09-01T00:00:00.000Z#a1" },
      ],
    });
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(await countProjectTasks(ddb, TABLE, ACTIVE_ID), 0);
    assertProjectOwnedGone(ddb, ACTIVE_ID, ["final-1"]);
    assert.ok(await getProject(ddb, TABLE, OTHER_ID));
  });

  await test("DELETE task lookup failure does not delete or archive", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const orig = ddb.send.bind(ddb);
    ddb.send = async (command) => {
      if (command instanceof QueryCommand) {
        throw new Error("simulated dynamo query failure");
      }
      return orig(command);
    };
    const result = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 500);
    assert.match(result.body.error, /Unable to verify project tasks/);
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.ok(stored);
    assert.strictEqual(stored.status, STATUS_ACTIVE);
    assertNoArchiveWrite(ddb);
  });

  await test("D. archived project remains resolvable by getProjectName", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    assert.strictEqual(
      await getProjectName(ddb, TABLE, ARCHIVED_ID),
      "Legacy Archive"
    );
    await handlePatchProject({
      user: ADMIN,
      projectId: ACTIVE_ID,
      body: { status: "ARCHIVED" },
      ddb,
      tableName: TABLE,
      now: NOW,
    });
    assert.strictEqual(await getProjectName(ddb, TABLE, ACTIVE_ID), "Portal");
  });

  await test("E. GET /projects excludes ARCHIVED projects", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    await handlePatchProject({
      user: ADMIN,
      projectId: ACTIVE_ID,
      body: { status: "ARCHIVED" },
      ddb,
      tableName: TABLE,
      now: NOW,
    });

    const listed = await handleListProjects({ ddb, tableName: TABLE });
    assert.strictEqual(listed.statusCode, 200);
    const ids = listed.body.map((p) => p.projectId).sort();
    assert.deepStrictEqual(ids, [EMPTY_ID, OTHER_ID].sort());
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
    assert.deepStrictEqual(ids, [ACTIVE_ID, EMPTY_ID, OTHER_ID].sort());
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
    assert.strictEqual(listed.body.length, 4);
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

const assert = require("assert");
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  ACTION_ARCHIVED,
  ACTION_DELETED,
  CONFIRM_NAME_MISMATCH,
  CONFIRM_NAME_REQUIRED,
  DYNAMO_BATCH_LIMIT,
  PROJECT_HAS_TASKS,
  PROJECT_HAS_TASKS_MESSAGE,
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
const { projectMemberKeys, projectAdminKeys } = require("./projectAccess");

const TABLE = "work-table";
const ACCESS_TABLE = "access-table";
const ATTACH_BUCKET = "task-attachments";
const DOCS_BUCKET = "documents-bucket";
const ACTIVE_ID = "project-active-1";
const EMPTY_ID = "project-empty-1";
const ARCHIVED_ID = "project-archived-1";
const MISSING_ID = "project-missing";
const OTHER_ID = "project-other-1";
const NOW = "2026-09-15T11:30:00.000Z";
const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };
const SUPER_ADMIN_USER = {
  email: "super@mydgv.com",
  groups: ["Admin"],
  isAdmin: true,
};
const MANAGER_USER = {
  email: "manager@mydgv.com",
  groups: ["Admin"],
  isAdmin: true,
};
const COGNITO_ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };
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

function evalCatalogCondition(item, expr, values = {}) {
  const s = String(expr || "");
  if (!s) return true;
  if (s.includes("attribute_exists(PK)") && !(item && item.PK)) return false;
  if (s.includes("attribute_not_exists(PK)") && item && item.PK) return false;
  if (s.includes("deletionStatus <> :deleting") || s.includes("deletionStatus <> :d")) {
    const deleting = String(values[":deleting"] || values[":d"] || "DELETING").toUpperCase();
    const raw =
      item && Object.prototype.hasOwnProperty.call(item, "deletionStatus")
        ? String(item.deletionStatus).toUpperCase()
        : "";
    if (raw === deleting) return false;
  }
  if (s.includes("deletionLockId = :lockId")) {
    if (!item || item.deletionLockId !== values[":lockId"]) return false;
  }
  if (s.includes("attribute_not_exists(deletionLockId)")) {
    const hasLock = Boolean(item && item.deletionLockId);
    if (s.includes("deletionLockAt < :stale")) {
      const staleOk =
        !hasLock || String(item.deletionLockAt || "") < String(values[":stale"] || "");
      if (!staleOk) return false;
    } else if (hasLock) {
      return false;
    }
  }
  return true;
}

function applyCatalogUpdate(item, expr, values = {}) {
  const next = { ...item };
  const text = String(expr || "");
  if (/SET /i.test(text)) {
    if (Object.prototype.hasOwnProperty.call(values, ":lockId")) {
      next.deletionLockId = values[":lockId"];
    }
    if (
      Object.prototype.hasOwnProperty.call(values, ":now") &&
      /deletionLockAt/.test(text)
    ) {
      next.deletionLockAt = values[":now"];
    }
    if (Object.prototype.hasOwnProperty.call(values, ":d")) {
      next.deletionStatus = values[":d"];
      if (values[":now"]) next.deletionStartedAt = values[":now"];
    }
    if (Object.prototype.hasOwnProperty.call(values, ":n")) {
      next.activeAdminCount = values[":n"];
    }
  }
  if (/REMOVE deletionLockId/.test(text)) {
    delete next.deletionLockId;
    delete next.deletionLockAt;
  }
  return next;
}

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
    failBatch: Boolean(options.failBatch),
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
        if (options.failAccessGet && TableName === ACCESS_TABLE) {
          throw new Error("simulated user access lookup failure");
        }
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        return { Item: found ? { ...found.Item } : undefined };
      }
      if (command instanceof PutCommand) {
        const { TableName, Item, ConditionExpression, ExpressionAttributeValues } =
          command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Item.PK &&
            row.Item.SK === Item.SK
        );
        if (
          ConditionExpression &&
          !evalCatalogCondition(
            found ? found.Item : {},
            ConditionExpression,
            ExpressionAttributeValues || {}
          )
        ) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        this.putItems.push({ ...Item });
        this.seed(TableName, Item);
        return {};
      }
      if (command instanceof DeleteCommand) {
        const { TableName, Key } = command.input;
        this.remove(TableName, Key);
        return {};
      }
      if (command instanceof UpdateCommand) {
        const {
          TableName,
          Key,
          UpdateExpression = "",
          ConditionExpression = "",
          ExpressionAttributeValues = {},
        } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        if (
          !evalCatalogCondition(
            found ? found.Item : {},
            ConditionExpression,
            ExpressionAttributeValues
          )
        ) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        found.Item = applyCatalogUpdate(
          found.Item,
          UpdateExpression,
          ExpressionAttributeValues
        );
        return {};
      }
      if (command instanceof BatchWriteCommand) {
        const tableName = Object.keys(command.input.RequestItems || {})[0];
        const reqs = command.input.RequestItems?.[tableName] || [];
        this.batchWriteSizes.push(reqs.length);
        if (this.failBatch) {
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

function seedAdminAccess(ddb, { email = ADMIN.email, role = "ADMIN", status = "ACTIVE" } = {}) {
  const id = String(email).toLowerCase();
  ddb.seed(ACCESS_TABLE, {
    PK: id,
    SK: id,
    email: id,
    role,
    status,
  });
}

function listProjects(ddb, extra = {}) {
  seedAdminAccess(ddb, {
    email: extra.user?.email || ADMIN.email,
    role: extra.role,
    status: extra.accessStatus,
  });
  return handleListProjects({
    ddb,
    tableName: TABLE,
    accessTable: ACCESS_TABLE,
    user: extra.user || ADMIN,
    status: extra.status,
  });
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

function seedAclPair(ddb, kind, projectId, email, extra = {}) {
  const keys =
    kind === "admin"
      ? projectAdminKeys(projectId, email)
      : projectMemberKeys(projectId, email);
  const base = {
    type: kind === "admin" ? "PROJECT_ADMIN" : "PROJECT_MEMBER",
    projectId,
    email: String(email).trim().toLowerCase(),
    status: extra.status || "ACTIVE",
    taskVisibility: extra.taskVisibility,
  };
  ddb.seed(TABLE, { ...keys.projectSide, ...base });
  ddb.seed(TABLE, { ...keys.userSide, ...base });
}

function seedRestrictedEmpty(ddb, projectId, name) {
  ddb.seed(
    TABLE,
    projectItem({
      projectId,
      name,
      extra: { accessMode: "RESTRICTED", activeAdminCount: 1 },
    })
  );
}

function assertNotDeleting(project) {
  assert.ok(project);
  assert.notStrictEqual(String(project.deletionStatus || "").toUpperCase(), "DELETING");
}

function seedBase(ddb) {
  seedAdminAccess(ddb);
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

function runPatch(opts) {
  return handlePatchProject({
    accessTable: ACCESS_TABLE,
    ...opts,
  });
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
    accessTable = ACCESS_TABLE,
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
    accessTable,
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
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.ok(stored);
    assertNotDeleting(stored);
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

  await test("8-10. active, completed, and archived tasks block deletion", async () => {
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
    const before = ddb.of(TABLE).map((item) => `${item.PK}|${item.SK}`).sort();
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(result.body.code, PROJECT_HAS_TASKS);
    assert.strictEqual(result.body.error, PROJECT_HAS_TASKS_MESSAGE);
    const stored = await getProject(ddb, TABLE, ACTIVE_ID);
    assert.ok(stored);
    assert.notStrictEqual(String(stored.deletionStatus || "").toUpperCase(), "DELETING");
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "active-1"));
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "done-1"));
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "archived-1"));
    assertRetained(ddb);
    assertNoArchiveWrite(ddb);
    assert.deepStrictEqual(
      ddb.of(TABLE).map((item) => `${item.PK}|${item.SK}`).sort(),
      before
    );
    assert.strictEqual(ddb.deletedKeys.length, 0);
  });

  await test("11. pagination of project task discovery still finds copies", async () => {
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
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(result.body.code, PROJECT_HAS_TASKS);
    assert.ok(copyQueries >= 3);
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "t-a"));
  });

  await test("12. canonical task history blocks deletion", async () => {
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
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(result.body.code, PROJECT_HAS_TASKS);
    assert.ok(entityQueries >= 2);
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "orphan-a"));
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "other-task"));
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
  });

  await test("13. duplicate copy and canonical records still block deletion", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const copy = taskCopy({ projectId: ACTIVE_ID, taskId: "dup-1" });
    ddb.seed(TABLE, copy);
    ddb.seed(TABLE, entityTask(copy));
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(result.body.code, PROJECT_HAS_TASKS);
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "dup-1"));
    assert.strictEqual(ddb.deletedKeys.length, 0);
  });

  await test("14-17. children and attachments are not deleted when tasks exist", async () => {
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
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(result.body.code, PROJECT_HAS_TASKS);
    assert.deepStrictEqual(s3.deleted, []);
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "child-1"));
    assert.ok(ddb.of(TABLE).some((item) => item.SK === "ASSIGNMENT#rahul@mydgv.com"));
  });

  await test("18-21. task and S3 cleanup are skipped when copies exist", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const children = [];
    for (let i = 0; i < 24; i += 1) {
      children.push({ SK: `COMMENT#2026-09-01T00:00:00.000Z#c${i}` });
    }
    seedTaskGraph(ddb, { taskId: "chunk-1", children });
    const s3 = createMemoryS3({ objects: { "tasks/att-task/ok.pdf": true } });
    const result = await del(ddb, { projectId: ACTIVE_ID, s3 });
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(result.body.code, PROJECT_HAS_TASKS);
    assert.deepStrictEqual(ddb.batchWriteSizes, []);
    assert.deepStrictEqual(s3.deleted, []);
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
  });

  await test("20. bounded retry of task deletes is not reached", async () => {
    const ddb = createMemoryDdb({ unprocessedRounds: 10 });
    seedBase(ddb);
    seedTaskGraph(ddb, { taskId: "fail-1" });
    const result = await del(ddb, { projectId: ACTIVE_ID, maxAttempts: 3 });
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(result.body.code, PROJECT_HAS_TASKS);
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "fail-1"));
    assertNoArchiveWrite(ddb);
  });

  await test("22-27. unsafe keys and S3 failures are not reached when tasks exist", async () => {
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
      assert.strictEqual(result.statusCode, 409);
      assert.strictEqual(result.body.code, PROJECT_HAS_TASKS);
      assert.strictEqual(s3.deleted.length, 0);
      const stored = await getProject(ddb, TABLE, ACTIVE_ID);
      assert.ok(stored);
      assert.notStrictEqual(String(stored.deletionStatus || "").toUpperCase(), "DELETING");
      assert.ok(s3.objects[s3Key]);
    }
  });

  await test("28-32. side records stay when deletion is blocked", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedRetained(ddb);
    seedTaskGraph(ddb, { taskId: "keep-side" });
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 409);
    assertRetained(ddb);
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "keep-side"));
  });

  await test("33. empty project catalog is deleted last", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 200);
    const last = ddb.deletedKeys[ddb.deletedKeys.length - 1];
    assert.deepStrictEqual(last, {
      PK: "ENTITY#PROJECT",
      SK: `PROJECT#${EMPTY_ID}`,
    });
  });

  await test("34. tasks remain and catalog is not deleted", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, { taskId: "verify-1" });
    const orig = ddb.send.bind(ddb);
    ddb.send = async (command) => {
      if (command instanceof DeleteCommand) {
        throw new Error("project delete should not run when tasks exist");
      }
      return orig(command);
    };
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(result.body.code, PROJECT_HAS_TASKS);
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assertNoArchiveWrite(ddb);
  });

  await test("35. DELETE with tasks never writes ARCHIVED", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedTaskGraph(ddb, { taskId: "no-archive" });
    const result = await del(ddb, { projectId: ACTIVE_ID });
    assert.strictEqual(result.statusCode, 409);
    assert.notStrictEqual(result.body.action, ACTION_ARCHIVED);
    assertNoArchiveWrite(ddb);
  });

  await test("36. task records remain after blocked deletion", async () => {
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
    assert.strictEqual(result.statusCode, 409);
    assert.ok((await countProjectTasks(ddb, TABLE, ACTIVE_ID)) > 0);
    assert.ok(await getProject(ddb, TABLE, ACTIVE_ID));
    assert.ok(await getProject(ddb, TABLE, OTHER_ID));
    assertRetained(ddb);
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
    await runPatch({
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
    await runPatch({
      user: ADMIN,
      projectId: ACTIVE_ID,
      body: { status: "ARCHIVED" },
      ddb,
      tableName: TABLE,
      now: NOW,
    });

    const listed = await listProjects(ddb);
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
    const listed = await listProjects(ddb);
    assert.strictEqual(listed.body.length, 1);
    assert.strictEqual(listed.body[0].projectId, "legacy");
  });

  await test("G. employee cannot DELETE /projects/{projectId}", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { user: EMPLOYEE, projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.body.error, "Admin required");
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.ok(stored);
    assertNotDeleting(stored);
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
    const def = await listProjects(ddb);
    const active = await listProjects(ddb, { status: "ACTIVE" });
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
    const listed = await listProjects(ddb, { status: "ARCHIVED" });
    assert.deepStrictEqual(
      listed.body.map((p) => p.projectId),
      [ARCHIVED_ID]
    );
  });

  await test("GET /projects?status=ALL returns active and archived", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const listed = await listProjects(ddb, { status: "all" });
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
    const result = await runPatch({
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
    const result = await runPatch({
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
    const result = await runPatch({
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
    const listed = await listProjects(ddb);
    assert.ok(!listed.body.some((p) => p.projectId === EMPTY_ID));
  });

  await test("PATCH restore returns a project to ACTIVE", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await runPatch({
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
    const listed = await listProjects(ddb);
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
    const result = await runPatch({
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
    const missing = await runPatch({
      user: ADMIN,
      projectId: MISSING_ID,
      body: { name: "X" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(missing.statusCode, 404);
    const invalid = await runPatch({
      user: ADMIN,
      projectId: EMPTY_ID,
      body: { status: "DELETED" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(invalid.statusCode, 400);
    const empty = await runPatch({
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
    const result = await runPatch({
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
    await runPatch({
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
    const result = await runPatch({
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

  await test("active ADMIN can delete an empty OPEN project", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.action, ACTION_DELETED);
    assert.strictEqual(await getProject(ddb, TABLE, EMPTY_ID), null);
  });

  await test("active SUPER_ADMIN can delete an empty RESTRICTED project", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedAdminAccess(ddb, { email: SUPER_ADMIN_USER.email, role: "SUPER_ADMIN" });
    seedRestrictedEmpty(ddb, "secret-empty", "Secret Empty");
    const result = await del(ddb, {
      user: SUPER_ADMIN_USER,
      projectId: "secret-empty",
      confirmName: "Secret Empty",
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(await getProject(ddb, TABLE, "secret-empty"), null);
  });

  await test("active ADMIN can delete RESTRICTED without Project Admin membership", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedRestrictedEmpty(ddb, "rest-no-pa", "No PA");
    seedAclPair(ddb, "admin", "rest-no-pa", "other-pa@mydgv.com", {
      taskVisibility: "ALL_PROJECT_TASKS",
    });
    const result = await del(ddb, {
      projectId: "rest-no-pa",
      confirmName: "No PA",
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(await getProject(ddb, TABLE, "rest-no-pa"), null);
  });

  await test("active SUPER_ADMIN can delete RESTRICTED without Project Admin membership", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedAdminAccess(ddb, { email: SUPER_ADMIN_USER.email, role: "SUPER_ADMIN" });
    seedRestrictedEmpty(ddb, "rest-sa", "SA Delete");
    const result = await del(ddb, {
      user: SUPER_ADMIN_USER,
      projectId: "rest-sa",
      confirmName: "SA Delete",
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(await getProject(ddb, TABLE, "rest-sa"), null);
  });

  await test("Cognito isAdmin without UserAccess cannot delete", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    ddb.remove(ACCESS_TABLE, { PK: ADMIN.email, SK: ADMIN.email });
    const result = await del(ddb, { user: COGNITO_ADMIN, projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 403);
    assertNotDeleting(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("Cognito isAdmin with PENDING UserAccess cannot delete", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedAdminAccess(ddb, { status: "PENDING" });
    const result = await del(ddb, { user: COGNITO_ADMIN, projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 403);
    assertNotDeleting(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("Cognito isAdmin with BLOCKED UserAccess cannot delete", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedAdminAccess(ddb, { status: "BLOCKED" });
    const result = await del(ddb, { user: COGNITO_ADMIN, projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 403);
    assertNotDeleting(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("Cognito isAdmin with inactive UserAccess cannot delete", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedAdminAccess(ddb, { status: "INACTIVE" });
    const result = await del(ddb, { user: COGNITO_ADMIN, projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 403);
    assertNotDeleting(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("active MANAGER cannot delete", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedAdminAccess(ddb, { email: MANAGER_USER.email, role: "MANAGER" });
    const result = await del(ddb, { user: MANAGER_USER, projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 403);
    assertNotDeleting(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("active EMPLOYEE cannot delete", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedAdminAccess(ddb, { email: EMPLOYEE.email, role: "EMPLOYEE" });
    const result = await del(ddb, { user: EMPLOYEE, projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 403);
    assertNotDeleting(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("UserAccess lookup failure returns 500", async () => {
    const ddb = createMemoryDdb({ failAccessGet: true });
    seedBase(ddb);
    const result = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 500);
    assert.strictEqual(result.body.error, "Internal server error");
    assertNotDeleting(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("missing caller email returns 401", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const missing = await del(ddb, {
      user: { isAdmin: true },
      projectId: EMPTY_ID,
    });
    assert.strictEqual(missing.statusCode, 401);
    assert.strictEqual(missing.body.error, "Unauthorized");
    const blank = await del(ddb, {
      user: { email: "   ", isAdmin: true },
      projectId: EMPTY_ID,
    });
    assert.strictEqual(blank.statusCode, 401);
    assertNotDeleting(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("normalized caller email authorizes deletion", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const result = await del(ddb, {
      user: { email: "  Admin@MyDGV.com ", isAdmin: false },
      projectId: EMPTY_ID,
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(await getProject(ddb, TABLE, EMPTY_ID), null);
  });

  await test("client-supplied role status and accessMode cannot authorize deletion", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    ddb.remove(ACCESS_TABLE, { PK: ADMIN.email, SK: ADMIN.email });
    const result = await del(ddb, {
      user: COGNITO_ADMIN,
      projectId: EMPTY_ID,
      body: {
        confirmName: "Empty Project",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        accessMode: "OPEN",
        PK: ADMIN.email,
        SK: ADMIN.email,
        projectId: EMPTY_ID,
      },
    });
    assert.strictEqual(result.statusCode, 403);
    assertNotDeleting(await getProject(ddb, TABLE, EMPTY_ID));
  });

  await test("empty project deletion cleans both ACL copies", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedAclPair(ddb, "member", EMPTY_ID, "rahul@mydgv.com");
    seedAclPair(ddb, "admin", EMPTY_ID, "pa@mydgv.com", {
      taskVisibility: "ALL_PROJECT_TASKS",
    });
    const result = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 200);
    const leftover = ddb.of(TABLE).filter(
      (item) =>
        String(item.SK).startsWith("MEMBER#") ||
        String(item.SK).startsWith("PROJECT_ADMIN#") ||
        String(item.SK) === `PROJECT_MEMBER#${EMPTY_ID}` ||
        String(item.SK) === `PROJECT_ADMIN#${EMPTY_ID}`
    );
    assert.deepStrictEqual(leftover, []);
  });

  await test("ACL cleanup failure returns 500 after tombstone", async () => {
    const ddb = createMemoryDdb({ failBatch: true });
    seedBase(ddb);
    seedAclPair(ddb, "member", EMPTY_ID, "rahul@mydgv.com");
    const result = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 500);
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.strictEqual(stored.deletionStatus, "DELETING");
    assert.ok(
      ddb.of(TABLE).some((item) => item.SK === "MEMBER#rahul@mydgv.com")
    );
  });

  await test("DELETING retry requires active UserAccess ADMIN or SUPER_ADMIN", async () => {
    const ddb = createMemoryDdb({ failBatch: true });
    seedBase(ddb);
    seedAclPair(ddb, "member", EMPTY_ID, "rahul@mydgv.com");
    const first = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(first.statusCode, 500);
    ddb.failBatch = false;
    seedAdminAccess(ddb, { email: MANAGER_USER.email, role: "MANAGER" });
    const denied = await del(ddb, { user: MANAGER_USER, projectId: EMPTY_ID });
    assert.strictEqual(denied.statusCode, 403);
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.strictEqual(stored.deletionStatus, "DELETING");
    const missingConfirm = await del(ddb, {
      projectId: EMPTY_ID,
      body: {},
    });
    assert.strictEqual(missingConfirm.statusCode, 400);
    assert.strictEqual(missingConfirm.body.error, CONFIRM_NAME_REQUIRED);
    assert.strictEqual(
      (await getProject(ddb, TABLE, EMPTY_ID)).deletionStatus,
      "DELETING"
    );
    const retry = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(retry.statusCode, 200);
    assert.strictEqual(await getProject(ddb, TABLE, EMPTY_ID), null);
  });

  await test("missing project does not fall back to OPEN", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const before = ddb.items.length;
    const result = await del(ddb, {
      projectId: MISSING_ID,
      confirmName: "Anything",
    });
    assert.strictEqual(result.statusCode, 404);
    assert.strictEqual(result.body.error, "Project not found");
    assert.strictEqual(ddb.items.length, before);
    assert.strictEqual(ddb.putItems.length, 0);
  });

  await test("catalog PATCH requires ACTIVE UserAccess ADMIN or SUPER_ADMIN", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    seedRestrictedEmpty(ddb, "rest-patch", "Restricted Patch");
    const okAdmin = await runPatch({
      user: ADMIN,
      projectId: "rest-patch",
      body: { client: "Acme" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(okAdmin.statusCode, 200);
    seedAdminAccess(ddb, { email: SUPER_ADMIN_USER.email, role: "SUPER_ADMIN" });
    const okSuper = await runPatch({
      user: SUPER_ADMIN_USER,
      projectId: "rest-patch",
      body: { description: "by super" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(okSuper.statusCode, 200);
    seedAdminAccess(ddb, { email: MANAGER_USER.email, role: "MANAGER" });
    const mgr = await runPatch({
      user: MANAGER_USER,
      projectId: EMPTY_ID,
      body: { name: "Nope" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(mgr.statusCode, 403);
    ddb.remove(ACCESS_TABLE, { PK: ADMIN.email, SK: ADMIN.email });
    const missing = await runPatch({
      user: COGNITO_ADMIN,
      projectId: EMPTY_ID,
      body: { name: "Nope", role: "ADMIN", status: "ACTIVE", isAdmin: true },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(missing.statusCode, 403);
    seedAdminAccess(ddb, { status: "PENDING" });
    const pending = await runPatch({
      user: COGNITO_ADMIN,
      projectId: EMPTY_ID,
      body: { name: "Nope" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(pending.statusCode, 403);
    seedAdminAccess(ddb, { status: "BLOCKED" });
    const blocked = await runPatch({
      user: COGNITO_ADMIN,
      projectId: EMPTY_ID,
      body: { name: "Nope" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(blocked.statusCode, 403);
  });

  await test("catalog PATCH missing and DELETING projects return 404", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const missing = await runPatch({
      user: ADMIN,
      projectId: MISSING_ID,
      body: { name: "X" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(missing.statusCode, 404);
    ddb.seed(
      TABLE,
      projectItem({
        projectId: "going",
        name: "Going",
        extra: { deletionStatus: "DELETING" },
      })
    );
    const deleting = await runPatch({
      user: ADMIN,
      projectId: "going",
      body: { name: "Still Going" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(deleting.statusCode, 404);
  });

  await test("PATCH returns 409 when Put condition fails but the project is still live", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const orig = ddb.send.bind(ddb);
    ddb.send = async (command) => {
      if (command instanceof PutCommand) {
        const err = new Error("conditional");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return orig(command);
    };
    const result = await runPatch({
      user: ADMIN,
      projectId: EMPTY_ID,
      body: { name: "Won't Stick" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 409);
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.strictEqual(stored.name, NAMES[EMPTY_ID]);
    assert.ok(!stored.deletionStatus);
  });

  await test("stale PATCH cannot overwrite a DELETING tombstone", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const orig = ddb.send.bind(ddb);
    ddb.send = async (command) => {
      const result = await orig(command);
      if (
        command instanceof GetCommand &&
        command.input.TableName === TABLE &&
        command.input.Key?.SK === `PROJECT#${EMPTY_ID}`
      ) {
        const row = ddb.items.find(
          (item) =>
            item.TableName === TABLE &&
            item.Item.SK === `PROJECT#${EMPTY_ID}`
        );
        if (row) row.Item.deletionStatus = "DELETING";
      }
      return result;
    };
    const result = await runPatch({
      user: ADMIN,
      projectId: EMPTY_ID,
      body: { name: "Resurrected" },
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 404);
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.strictEqual(stored.deletionStatus, "DELETING");
    assert.strictEqual(stored.name, NAMES[EMPTY_ID]);
  });

  await test("DELETE returns 409 when a task exists and does not tombstone", async () => {
    const ddb = createMemoryDdb();
    seedBase(ddb);
    ddb.seed(TABLE, {
      PK: `PROJECT#${EMPTY_ID}`,
      SK: "TASK#late",
      taskId: "late",
      projectId: EMPTY_ID,
    });
    const result = await del(ddb, { projectId: EMPTY_ID });
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(result.body.code, PROJECT_HAS_TASKS);
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.notStrictEqual(String(stored.deletionStatus || "").toUpperCase(), "DELETING");
    assert.ok(!stored.deletionLockId);
    assert.ok(
      ddb.of(TABLE).some((item) => item.taskId === "late")
    );
  });

  await test("fresh deletion lock is not stolen", async () => {
    const persist = require("./projectAccessPersist");
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const first = await persist.acquireDeletionLock(ddb, TABLE, EMPTY_ID, {
      now: "2026-09-21T12:00:00.000Z",
      lockId: "lock-a",
    });
    assert.strictEqual(first.ok, true);
    const second = await persist.acquireDeletionLock(ddb, TABLE, EMPTY_ID, {
      now: "2026-09-21T12:00:01.000Z",
      lockId: "lock-b",
    });
    assert.strictEqual(second.ok, false);
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.strictEqual(stored.deletionLockId, "lock-a");
  });

  await test("stale deletion lock can be recovered and wrong lock cannot be released", async () => {
    const persist = require("./projectAccessPersist");
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const first = await persist.acquireDeletionLock(ddb, TABLE, EMPTY_ID, {
      now: "2026-09-21T12:00:00.000Z",
      lockId: "lock-old",
      staleMs: 1000,
    });
    assert.strictEqual(first.ok, true);
    const stolen = await persist.releaseDeletionLock(
      ddb,
      TABLE,
      EMPTY_ID,
      "lock-other"
    );
    assert.strictEqual(stolen.ok, false);
    assert.strictEqual((await getProject(ddb, TABLE, EMPTY_ID)).deletionLockId, "lock-old");
    const recovered = await persist.acquireDeletionLock(ddb, TABLE, EMPTY_ID, {
      now: "2026-09-21T12:00:05.000Z",
      lockId: "lock-new",
      staleMs: 1000,
    });
    assert.strictEqual(recovered.ok, true);
    assert.strictEqual((await getProject(ddb, TABLE, EMPTY_ID)).deletionLockId, "lock-new");
  });

  await test("wrong lock ID cannot convert catalog to DELETING", async () => {
    const persist = require("./projectAccessPersist");
    const ddb = createMemoryDdb();
    seedBase(ddb);
    const locked = await persist.acquireDeletionLock(ddb, TABLE, EMPTY_ID, {
      lockId: "lock-owner",
    });
    assert.strictEqual(locked.ok, true);
    const stolen = await persist.convertLockToDeleting(
      ddb,
      TABLE,
      EMPTY_ID,
      "lock-other"
    );
    assert.strictEqual(stolen.ok, false);
    const stored = await getProject(ddb, TABLE, EMPTY_ID);
    assert.strictEqual(stored.deletionLockId, "lock-owner");
    assert.notStrictEqual(String(stored.deletionStatus || "").toUpperCase(), "DELETING");
  });

  console.log(`${passed} project management tests passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

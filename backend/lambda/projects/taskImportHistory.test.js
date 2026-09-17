const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  GetObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  HISTORY_PK,
  META_SK,
  TYPE_TASK_IMPORT,
  IMPORT_STATUSES,
  importPk,
  historySk,
  buildS3Key,
  buildImportMeta,
  buildHistoryCopy,
  syncImportHistory,
} = require("./taskImport");
const {
  handleListTaskImports,
  handleGetTaskImport,
  handleGetTaskImportDownloadUrl,
  listPathMatch,
  downloadPathMatch,
  detailPathMatch,
  encodeToken,
  isTrustedImportKey,
} = require("./taskImportHistory");

const TABLE = "work-table";
const BUCKET = "docs-bucket";
const NOW = "2026-09-15T11:00:00.000Z";
const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };
const OTHER_ADMIN = { email: "lead@mydgv.com", groups: ["Admin"], isAdmin: true };
const EMPLOYEE = { email: "rahul@mydgv.com", groups: ["Employee"], isAdmin: false };

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
      if (command instanceof QueryCommand) {
        const {
          TableName,
          ExpressionAttributeValues = {},
          ScanIndexForward = true,
          Limit,
          ExclusiveStartKey,
          Select,
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
        if (ScanIndexForward === false) found.reverse();
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
        if (Select === "COUNT") {
          return { Count: sliced.length, LastEvaluatedKey: lastKey };
        }
        return { Items: sliced, Count: sliced.length, LastEvaluatedKey: lastKey };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function createMemoryS3(objects = {}) {
  return {
    objects,
    commands: [],
    async send(command) {
      this.commands.push(command);
      const key = command.input.Key;
      const body = objects[key];
      if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
        if (!body) {
          const err = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return { Body: body };
      }
      throw new Error(`unexpected s3 command ${command.constructor.name}`);
    },
  };
}

function metaItem({
  batchId,
  uploadedAt,
  status = IMPORT_STATUSES.COMPLETED,
  extra = {},
}) {
  const uploadedBy = "admin@mydgv.com";
  return {
    ...buildImportMeta({
      batchId,
      uploadedBy,
      uploadedByName: "admin",
      uploadedAt,
      fileName: `${batchId}.xlsx`,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSize: 1024,
      s3Key: buildS3Key(uploadedBy, batchId),
    }),
    status,
    totalRows: 2,
    validRows: 2,
    invalidRows: 0,
    successCount: 2,
    failureCount: 0,
    confirmedAt: uploadedAt,
    completedAt: uploadedAt,
    ...extra,
  };
}

function seedBatch(ddb, meta, historyOverride) {
  ddb.seed(TABLE, meta);
  ddb.seed(TABLE, historyOverride || buildHistoryCopy(meta));
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
  await test("route matchers distinguish list, detail, and download-url", () => {
    assert.strictEqual(listPathMatch("/task-imports"), true);
    assert.strictEqual(listPathMatch("/prod/task-imports"), true);
    assert.strictEqual(listPathMatch("/task-imports/abc/download-url"), false);
    assert.strictEqual(
      downloadPathMatch("/task-imports/abc/download-url"),
      "abc"
    );
    assert.strictEqual(detailPathMatch("/task-imports/abc"), "abc");
    assert.strictEqual(detailPathMatch("/task-imports/abc/download-url"), null);
    assert.strictEqual(detailPathMatch("/task-imports/abc/preview"), null);
    assert.strictEqual(detailPathMatch("/task-imports/upload-url"), null);
    assert.strictEqual(isTrustedImportKey("task-imports/a@b.com/id/original.xlsx", "id"), true);
    assert.strictEqual(isTrustedImportKey("task-imports/../x/original.xlsx", "id"), false);
  });

  await test("employee cannot list history", async () => {
    const result = await handleListTaskImports({
      user: EMPLOYEE,
      ddb: createMemoryDdb(),
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 403);
    assert.match(result.body.error, /Admin required/);
  });

  await test("admin can list history newest first with total count", async () => {
    const ddb = createMemoryDdb();
    const older = metaItem({
      batchId: "batch-old",
      uploadedAt: "2026-09-01T00:00:00.000Z",
    });
    const newer = metaItem({
      batchId: "batch-new",
      uploadedAt: "2026-09-15T00:00:00.000Z",
    });
    seedBatch(ddb, older);
    seedBatch(ddb, newer);
    const result = await handleListTaskImports({
      user: OTHER_ADMIN,
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.totalCount, 2);
    assert.deepStrictEqual(
      result.body.items.map((item) => item.batchId),
      ["batch-new", "batch-old"]
    );
    assert.ok(!result.body.items[0].s3Key);
  });

  await test("pagination returns nextToken", async () => {
    const ddb = createMemoryDdb();
    for (let i = 0; i < 3; i += 1) {
      seedBatch(
        ddb,
        metaItem({
          batchId: `batch-${i}`,
          uploadedAt: `2026-09-0${i + 1}T00:00:00.000Z`,
        })
      );
    }
    const first = await handleListTaskImports({
      user: ADMIN,
      ddb,
      tableName: TABLE,
      limit: 2,
    });
    assert.strictEqual(first.body.items.length, 2);
    assert.ok(first.body.nextToken);
    const second = await handleListTaskImports({
      user: ADMIN,
      ddb,
      tableName: TABLE,
      limit: 2,
      nextToken: first.body.nextToken,
    });
    assert.strictEqual(second.body.items.length, 1);
    assert.strictEqual(second.body.totalCount, 3);
  });

  await test("stale history snapshot is hydrated from META", async () => {
    const ddb = createMemoryDdb();
    const meta = metaItem({
      batchId: "batch-stale",
      uploadedAt: NOW,
      status: IMPORT_STATUSES.COMPLETED,
      extra: { successCount: 4, totalRows: 4 },
    });
    const stale = {
      ...buildHistoryCopy(meta),
      status: IMPORT_STATUSES.UPLOADED,
      successCount: 0,
      totalRows: 0,
    };
    seedBatch(ddb, meta, stale);
    const result = await handleListTaskImports({
      user: ADMIN,
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.body.items[0].status, IMPORT_STATUSES.COMPLETED);
    assert.strictEqual(result.body.items[0].successCount, 4);
    assert.strictEqual(result.body.items[0].totalRows, 4);
  });

  await test("syncImportHistory overwrites the existing snapshot", async () => {
    const ddb = createMemoryDdb();
    const meta = metaItem({
      batchId: "batch-sync",
      uploadedAt: NOW,
      status: IMPORT_STATUSES.UPLOADED,
    });
    seedBatch(ddb, meta);
    const next = { ...meta, status: IMPORT_STATUSES.READY, totalRows: 3 };
    ddb.seed(TABLE, next);
    await syncImportHistory(ddb, TABLE, next);
    const copies = ddb
      .of(TABLE)
      .filter((item) => item.PK === HISTORY_PK && item.batchId === "batch-sync");
    assert.strictEqual(copies.length, 1);
    assert.strictEqual(copies[0].SK, historySk(NOW, "batch-sync"));
    assert.strictEqual(copies[0].status, IMPORT_STATUSES.READY);
    assert.strictEqual(copies[0].totalRows, 3);
  });

  await test("missing batch returns 404", async () => {
    const result = await handleGetTaskImport({
      user: ADMIN,
      batchId: "missing-batch",
      ddb: createMemoryDdb(),
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 404);
  });

  await test("employee cannot get batch detail", async () => {
    const result = await handleGetTaskImport({
      user: EMPLOYEE,
      batchId: "batch-1",
      ddb: createMemoryDdb(),
      tableName: TABLE,
    });
    assert.strictEqual(result.statusCode, 403);
  });

  await test("batch detail returns META, rows, and task linkage", async () => {
    const ddb = createMemoryDdb();
    const batchId = "batch-detail";
    const meta = metaItem({ batchId, uploadedAt: NOW });
    seedBatch(ddb, meta);
    ddb.seed(TABLE, {
      PK: importPk(batchId),
      SK: "ROW#000002",
      type: "TASK_IMPORT_ROW",
      batchId,
      rowNumber: 2,
      values: {
        taskTitle: "Banner",
        assignees: ["rahul@mydgv.com"],
        assignmentMode: "IMMEDIATE",
        taskType: "Development",
        priority: "HIGH",
        startDateTime: "2026-10-01T09:30:00+05:30",
        deadlineDateTime: "2026-10-03T18:00:00+05:30",
        description: "Do it",
      },
      status: "IMPORTED",
      projectName: "Portal",
      resolvedAssignees: [{ email: "rahul@mydgv.com" }],
      errors: [],
      warnings: [],
      cellErrors: [],
      taskId: "task-immediate",
    });
    ddb.seed(TABLE, {
      PK: "ENTITY#TASK",
      SK: "TASK#task-immediate",
      taskId: "task-immediate",
      assignmentMode: "IMMEDIATE",
      assignmentState: "ASSIGNED",
    });
    ddb.seed(TABLE, {
      PK: "TASK#task-immediate",
      SK: "ASSIGNMENT#rahul@mydgv.com",
      email: "rahul@mydgv.com",
      removed: false,
    });
    const result = await handleGetTaskImport({
      user: ADMIN,
      batchId,
      ddb,
      s3: createMemoryS3({ [meta.s3Key]: Buffer.from("xlsx") }),
      tableName: TABLE,
      bucket: BUCKET,
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.summary.batchId, batchId);
    assert.strictEqual(result.body.summary.fileAvailable, true);
    assert.ok(!result.body.summary.s3Key);
    assert.strictEqual(result.body.rows[0].taskId, "task-immediate");
    assert.deepStrictEqual(result.body.rows[0].assignment.emails, [
      "rahul@mydgv.com",
    ]);
    assert.strictEqual(result.body.rows[0].assignment.state, "ASSIGNED");
  });

  await test("immediate assignment uses assignment records not Excel emails", async () => {
    const ddb = createMemoryDdb();
    const batchId = "batch-assign";
    seedBatch(ddb, metaItem({ batchId, uploadedAt: NOW }));
    ddb.seed(TABLE, {
      PK: importPk(batchId),
      SK: "ROW#000002",
      rowNumber: 2,
      values: { taskTitle: "X", assignees: ["excel@mydgv.com"], assignmentMode: "IMMEDIATE" },
      status: "IMPORTED",
      taskId: "task-a",
      assignmentMode: "IMMEDIATE",
    });
    ddb.seed(TABLE, {
      PK: "ENTITY#TASK",
      SK: "TASK#task-a",
      taskId: "task-a",
      assignmentMode: "IMMEDIATE",
      assignmentState: "ASSIGNED",
    });
    ddb.seed(TABLE, {
      PK: "TASK#task-a",
      SK: "ASSIGNMENT#actual@mydgv.com",
      email: "actual@mydgv.com",
    });
    const result = await handleGetTaskImport({
      user: ADMIN,
      batchId,
      ddb,
      tableName: TABLE,
    });
    assert.deepStrictEqual(result.body.rows[0].assignment.emails, [
      "actual@mydgv.com",
    ]);
    assert.deepStrictEqual(result.body.rows[0].excelAssignees, [
      "excel@mydgv.com",
    ]);
  });

  await test("scheduled pending shows pendingAssignees", async () => {
    const ddb = createMemoryDdb();
    const batchId = "batch-sched";
    seedBatch(ddb, metaItem({ batchId, uploadedAt: NOW }));
    ddb.seed(TABLE, {
      PK: importPk(batchId),
      SK: "ROW#000003",
      rowNumber: 3,
      values: { taskTitle: "Later", assignees: ["priya@mydgv.com"], assignmentMode: "SCHEDULED" },
      status: "IMPORTED",
      taskId: "task-s",
      assignmentMode: "SCHEDULED",
    });
    const task = {
      PK: "ENTITY#TASK",
      SK: "TASK#task-s",
      taskId: "task-s",
      assignmentMode: "SCHEDULED",
      assignmentState: "PENDING",
      pendingAssignees: ["priya@mydgv.com"],
    };
    ddb.seed(TABLE, task);
    const before = { ...task };
    const result = await handleGetTaskImport({
      user: ADMIN,
      batchId,
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.body.rows[0].assignment.state, "PENDING");
    assert.strictEqual(result.body.rows[0].assignment.scheduled, true);
    assert.deepStrictEqual(result.body.rows[0].assignment.emails, [
      "priya@mydgv.com",
    ]);
    assert.deepStrictEqual(
      ddb.of(TABLE).find((item) => item.taskId === "task-s" && item.PK === "ENTITY#TASK"),
      before
    );
  });

  await test("scheduled assigned shows actual assignment records", async () => {
    const ddb = createMemoryDdb();
    const batchId = "batch-sched-done";
    seedBatch(ddb, metaItem({ batchId, uploadedAt: NOW }));
    ddb.seed(TABLE, {
      PK: importPk(batchId),
      SK: "ROW#000003",
      rowNumber: 3,
      values: { taskTitle: "Later", assignees: ["priya@mydgv.com"], assignmentMode: "SCHEDULED" },
      status: "IMPORTED",
      taskId: "task-s2",
      assignmentMode: "SCHEDULED",
    });
    ddb.seed(TABLE, {
      PK: "ENTITY#TASK",
      SK: "TASK#task-s2",
      taskId: "task-s2",
      assignmentMode: "SCHEDULED",
      assignmentState: "ASSIGNED",
      pendingAssignees: ["priya@mydgv.com"],
    });
    ddb.seed(TABLE, {
      PK: "TASK#task-s2",
      SK: "ASSIGNMENT#priya@mydgv.com",
      email: "priya@mydgv.com",
    });
    const result = await handleGetTaskImport({
      user: ADMIN,
      batchId,
      ddb,
      tableName: TABLE,
    });
    assert.strictEqual(result.body.rows[0].assignment.state, "ASSIGNED");
    assert.deepStrictEqual(result.body.rows[0].assignment.emails, [
      "priya@mydgv.com",
    ]);
  });

  await test("download requires admin", async () => {
    const result = await handleGetTaskImportDownloadUrl({
      user: EMPLOYEE,
      batchId: "batch-1",
      ddb: createMemoryDdb(),
      tableName: TABLE,
      bucket: BUCKET,
      s3: createMemoryS3(),
    });
    assert.strictEqual(result.statusCode, 403);
  });

  await test("download missing batch returns 404", async () => {
    const result = await handleGetTaskImportDownloadUrl({
      user: ADMIN,
      batchId: "missing",
      ddb: createMemoryDdb(),
      tableName: TABLE,
      bucket: BUCKET,
      s3: createMemoryS3(),
    });
    assert.strictEqual(result.statusCode, 404);
  });

  await test("download missing S3 object returns 404", async () => {
    const ddb = createMemoryDdb();
    const meta = metaItem({ batchId: "batch-file", uploadedAt: NOW });
    seedBatch(ddb, meta);
    const result = await handleGetTaskImportDownloadUrl({
      user: ADMIN,
      batchId: "batch-file",
      ddb,
      tableName: TABLE,
      bucket: BUCKET,
      s3: createMemoryS3(),
    });
    assert.strictEqual(result.statusCode, 404);
  });

  await test("download rejects untrusted s3Key", async () => {
    const ddb = createMemoryDdb();
    const meta = metaItem({
      batchId: "batch-bad-key",
      uploadedAt: NOW,
      extra: { s3Key: "profiles/secret.xlsx" },
    });
    seedBatch(ddb, meta);
    const result = await handleGetTaskImportDownloadUrl({
      user: ADMIN,
      batchId: "batch-bad-key",
      ddb,
      tableName: TABLE,
      bucket: BUCKET,
      s3: createMemoryS3({ "profiles/secret.xlsx": Buffer.from("x") }),
    });
    assert.strictEqual(result.statusCode, 404);
  });

  await test("download produces short-lived GET presigned URL", async () => {
    const ddb = createMemoryDdb();
    const meta = metaItem({ batchId: "batch-dl", uploadedAt: NOW });
    seedBatch(ddb, meta);
    const s3 = createMemoryS3({ [meta.s3Key]: Buffer.from("xlsx") });
    let signedCommand;
    const result = await handleGetTaskImportDownloadUrl({
      user: ADMIN,
      batchId: "batch-dl",
      ddb,
      tableName: TABLE,
      bucket: BUCKET,
      s3,
      signedTtl: 900,
      getSignedUrlFn: async (_client, command, opts) => {
        signedCommand = command;
        assert.ok(opts.expiresIn <= 300);
        return "https://s3.test/signed-get";
      },
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.downloadUrl, "https://s3.test/signed-get");
    assert.strictEqual(result.body.expiresIn, 300);
    assert.ok(signedCommand instanceof GetObjectCommand);
    assert.ok(!result.body.s3Key);
  });

  await test("history list does not mutate task data", async () => {
    const ddb = createMemoryDdb();
    const task = {
      PK: "ENTITY#TASK",
      SK: "TASK#keep",
      taskId: "keep",
      title: "Stay",
    };
    ddb.seed(TABLE, task);
    seedBatch(ddb, metaItem({ batchId: "batch-keep", uploadedAt: NOW }));
    const before = JSON.stringify(ddb.of(TABLE));
    await handleListTaskImports({ user: ADMIN, ddb, tableName: TABLE });
    assert.strictEqual(JSON.stringify(ddb.of(TABLE)), before);
  });

  await test("no re-import route is introduced", () => {
    assert.strictEqual(listPathMatch("/task-imports"), true);
    assert.strictEqual(detailPathMatch("/task-imports/abc/confirm"), null);
  });

  console.log(`${passed} task import history tests passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

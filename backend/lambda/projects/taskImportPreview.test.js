const assert = require("assert");
const XLSX = require("xlsx");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const {
  META_SK,
  TYPE_TASK_IMPORT,
  TASK_IMPORT_COLUMNS,
  buildImportMeta,
  buildS3Key,
  importPk,
  rowSk,
} = require("./taskImport");
const {
  previewPathMatch,
  handlePreviewRequest,
} = require("./taskImportPreview");

process.env.TASK_IMPORT_MAX_ROWS = "200";
process.env.TASK_IMPORT_MAX_BYTES = "5242880";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";

const NOW = "2026-09-15T09:40:00.000Z";
const NOW_MS = Date.parse("2026-09-15T09:00:00+05:30");
const BATCH_ID = "batch-preview-001";
const WORK_TABLE = "work-table";
const ACCESS_TABLE = "access-table";
const BUCKET = "docs-bucket";
const PORTAL_ID = "11111111-aaaa-bbbb-cccc-portal000001";
const TESTING_ID = "22222222-aaaa-bbbb-cccc-testing00002";
const TESTING_DUP_ID = "33333333-aaaa-bbbb-cccc-testing00003";

const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };
const OTHER_ADMIN = { email: "lead@mydgv.com", groups: ["Admin"], isAdmin: true };
const EMPLOYEE = { email: "rahul@mydgv.com", groups: ["Employee"], isAdmin: false };

const VALID_ROW = [
  "Homepage banner update",
  "DGV Employee Portal",
  "rahul@mydgv.com",
  "IMMEDIATE",
  "Development",
  "HIGH",
  "2026-10-01",
  "09:30",
  "2026-10-03",
  "18:00",
  "Update the homepage banner.",
];

function workbookBuffer({
  rows = [TASK_IMPORT_COLUMNS, VALID_ROW],
  sheetName = "Tasks",
} = {}) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const lastRow = Math.max(1, rows.length);
  sheet["!ref"] = `A1:K${lastRow}`;
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function paddedWorkbook(rowNumber, dataRow, extra = []) {
  const rows = [TASK_IMPORT_COLUMNS];
  for (let r = 2; r < rowNumber; r += 1) {
    rows.push(["", "", "", "", "", "", "", "", "", "", ""]);
  }
  rows.push(dataRow);
  extra.forEach((row) => rows.push(row));
  return workbookBuffer({ rows });
}

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
      return items.filter((row) => row.TableName === tableName).map((row) => row.Item);
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
        return { Items: found };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function createMemoryS3(objects = {}) {
  return {
    objects,
    async send(command) {
      assert.ok(command instanceof GetObjectCommand);
      const key = command.input.Key;
      const body = objects[key];
      if (!body) {
        const err = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return { Body: body };
    },
  };
}

function seedAccess(ddb) {
  const rows = [
    { email: "rahul@mydgv.com", status: "ACTIVE", role: "EMPLOYEE" },
    { email: "priya@mydgv.com", status: "ACTIVE", role: "EMPLOYEE" },
    { email: "anita@mydgv.com", status: "ACTIVE", role: "MANAGER" },
    { email: "blocked@mydgv.com", status: "BLOCKED", role: "EMPLOYEE" },
    { email: "pending@mydgv.com", status: "PENDING", role: "EMPLOYEE" },
    { email: "super@mydgv.com", status: "ACTIVE", role: "SUPER_ADMIN" },
    { email: "admin@mydgv.com", status: "ACTIVE", role: "ADMIN" },
  ];
  for (const row of rows) {
    ddb.seed(ACCESS_TABLE, {
      PK: row.email,
      SK: row.email,
      email: row.email,
      status: row.status,
      role: row.role,
    });
  }
}

function seedProjects(ddb, extra = []) {
  const projects = [
    { projectId: PORTAL_ID, name: "DGV Employee Portal" },
    { projectId: TESTING_ID, name: "Testing" },
    ...extra,
  ];
  for (const project of projects) {
    ddb.seed(WORK_TABLE, {
      PK: "ENTITY#PROJECT",
      SK: `PROJECT#${project.projectId}`,
      projectId: project.projectId,
      name: project.name,
      status: "ACTIVE",
    });
  }
}

function seedMeta(ddb, overrides = {}) {
  const meta = {
    ...buildImportMeta({
      batchId: BATCH_ID,
      uploadedBy: ADMIN.email,
      uploadedByName: "admin",
      uploadedAt: "2026-09-15T07:00:00.000Z",
      fileName: "bulk-tasks.xlsx",
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSize: 2048,
      s3Key: buildS3Key(ADMIN.email, BATCH_ID),
    }),
    ...overrides,
  };
  ddb.seed(WORK_TABLE, meta);
  return meta;
}

async function preview({ ddb, s3, user = ADMIN, batchId = BATCH_ID, extras = {} }) {
  return handlePreviewRequest({
    user,
    batchId,
    ddb,
    s3,
    now: NOW,
    nowMs: NOW_MS,
    tableName: WORK_TABLE,
    bucket: BUCKET,
    accessTable: ACCESS_TABLE,
    ...extras,
  });
}

function rowItems(ddb) {
  return ddb
    .of(WORK_TABLE)
    .filter((item) => item.PK === importPk(BATCH_ID) && String(item.SK).startsWith("ROW#"));
}

function metaItem(ddb) {
  return ddb
    .of(WORK_TABLE)
    .find((item) => item.PK === importPk(BATCH_ID) && item.SK === META_SK);
}

function taskItems(ddb) {
  return ddb.of(WORK_TABLE).filter((item) => item.PK === "ENTITY#TASK");
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
  await test("preview path matcher", () => {
    assert.strictEqual(
      previewPathMatch("/task-imports/abc-123/preview"),
      "abc-123"
    );
    assert.strictEqual(
      previewPathMatch("/prod/task-imports/abc-123/preview"),
      "abc-123"
    );
    assert.strictEqual(
      previewPathMatch("/task-imports/abc-123/preview", { batchId: "abc-123" }),
      "abc-123"
    );
    assert.strictEqual(previewPathMatch("/task-imports/upload-url"), null);
    assert.strictEqual(previewPathMatch("/tasks"), null);
  });

  await test("successful preview stores READY META and ROW records", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({
      [meta.s3Key]: workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, VALID_ROW] }),
    });
    const result = await preview({ ddb, s3 });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "READY");
    assert.strictEqual(result.body.batchId, BATCH_ID);
    assert.strictEqual(result.body.totalRows, 1);
    assert.strictEqual(result.body.validRows, 1);
    assert.strictEqual(result.body.invalidRows, 0);
    assert.strictEqual(result.body.rows[0].status, "VALID");
    assert.strictEqual(result.body.rows[0].rowNumber, 2);
    assert.strictEqual(result.body.rows[0].projectId, PORTAL_ID);
    assert.strictEqual(result.body.rows[0].projectName, "DGV Employee Portal");
    assert.deepStrictEqual(result.body.rows[0].resolvedAssignees, [
      { email: "rahul@mydgv.com", status: "ACTIVE" },
    ]);
    const stored = rowItems(ddb);
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].SK, rowSk(2));
    assert.strictEqual(stored[0].status, "VALID");
    assert.strictEqual(stored[0].projectId, PORTAL_ID);
    assert.strictEqual(stored[0].type, "TASK_IMPORT_ROW");
    assert.strictEqual(metaItem(ddb).status, "READY");
    assert.strictEqual(metaItem(ddb).previewedBy, ADMIN.email);
    assert.strictEqual(metaItem(ddb).previewedAt, NOW);
    assert.strictEqual(taskItems(ddb).length, 0);
  });

  await test("invalid project marks NEEDS_FIX and cell B", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const row = [...VALID_ROW];
    row[1] = "Testng";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({
      [meta.s3Key]: paddedWorkbook(7, row),
    });
    const result = await preview({ ddb, s3 });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "NEEDS_FIX");
    assert.strictEqual(result.body.invalidRows, 1);
    const previewRow = result.body.rows[0];
    assert.strictEqual(previewRow.rowNumber, 7);
    assert.strictEqual(previewRow.status, "INVALID");
    assert.ok(previewRow.cellErrors.some((item) => item.cell === "B7"));
    assert.ok(
      previewRow.cellErrors.some(
        (item) =>
          item.column === "Project" &&
          item.value === "Testng" &&
          /does not exist/i.test(item.message)
      )
    );
    assert.strictEqual(previewRow.projectId, null);
    assert.strictEqual(metaItem(ddb).status, "NEEDS_FIX");
    assert.strictEqual(rowItems(ddb)[0].status, "INVALID");
  });

  await test("H. Excel project catalog does not include archived projects", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    ddb.seed(WORK_TABLE, {
      PK: "ENTITY#PROJECT",
      SK: "PROJECT#archived-legacy-id",
      projectId: "archived-legacy-id",
      name: "Legacy Archive",
      status: "ARCHIVED",
    });
    const row = [...VALID_ROW];
    row[1] = "Legacy Archive";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({
      [meta.s3Key]: workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, row] }),
    });
    const result = await preview({ ddb, s3 });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "NEEDS_FIX");
    assert.strictEqual(result.body.rows[0].status, "INVALID");
    assert.strictEqual(result.body.rows[0].projectId, null);
    assert.ok(
      result.body.rows[0].cellErrors.some(
        (item) =>
          item.column === "Project" &&
          item.value === "Legacy Archive" &&
          /does not exist/i.test(item.message)
      )
    );

  });

  await test("project matching is case-insensitive and preserves UUID", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const row = [...VALID_ROW];
    row[1] = "testing";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, row] }) });
    const result = await preview({ ddb, s3 });
    assert.strictEqual(result.body.rows[0].status, "VALID");
    assert.strictEqual(result.body.rows[0].projectId, TESTING_ID);
    assert.strictEqual(result.body.rows[0].projectName, "Testing");
    assert.strictEqual(result.body.rows[0].values.project, "Testing");
  });

  await test("project matching trims whitespace", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const row = [...VALID_ROW];
    row[1] = " TESTING ";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, row] }) });
    const result = await preview({ ddb, s3 });
    assert.strictEqual(result.body.rows[0].status, "VALID");
    assert.strictEqual(result.body.rows[0].projectId, TESTING_ID);
    assert.strictEqual(result.body.rows[0].projectName, "Testing");
  });

  await test("duplicate project names are invalid and not auto-picked", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb, [{ projectId: TESTING_DUP_ID, name: "testing" }]);
    seedAccess(ddb);
    const row = [...VALID_ROW];
    row[1] = "Testing";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, row] }) });
    const result = await preview({ ddb, s3 });
    assert.strictEqual(result.body.rows[0].status, "INVALID");
    assert.ok(
      result.body.rows[0].errors.some((item) =>
        /more than one project/i.test(item.message)
      )
    );
    assert.strictEqual(result.body.rows[0].projectId, null);
  });

  await test("missing project is INVALID", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const row = [...VALID_ROW];
    row[1] = "";
    row[10] = "keep row non-blank";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, row] }) });
    const result = await preview({ ddb, s3 });
    assert.strictEqual(result.body.rows[0].status, "INVALID");
    assert.ok(result.body.rows[0].errors.some((item) => item.field === "project"));
  });

  await test("active assignee resolves", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: workbookBuffer() });
    const result = await preview({ ddb, s3 });
    assert.strictEqual(result.body.rows[0].status, "VALID");
    assert.deepStrictEqual(result.body.rows[0].resolvedAssignees, [
      { email: "rahul@mydgv.com", status: "ACTIVE" },
    ]);
  });

  await test("SUPER_ADMIN remains a valid assignee when ACTIVE", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const row = [...VALID_ROW];
    row[2] = "super@mydgv.com";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, row] }) });
    const result = await preview({ ddb, s3 });
    assert.strictEqual(result.body.rows[0].status, "VALID");
    assert.strictEqual(result.body.rows[0].resolvedAssignees[0].email, "super@mydgv.com");
  });

  await test("blocked assignee is invalid at cell C", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const row = [...VALID_ROW];
    row[2] = "blocked@mydgv.com";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: paddedWorkbook(8, row) });
    const result = await preview({ ddb, s3 });
    const previewRow = result.body.rows[0];
    assert.strictEqual(previewRow.status, "INVALID");
    assert.ok(
      previewRow.cellErrors.some(
        (item) => item.cell === "C8" && /BLOCKED/i.test(item.message)
      )
    );
  });

  await test("pending assignee is invalid", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const row = [...VALID_ROW];
    row[2] = "pending@mydgv.com";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, row] }) });
    const result = await preview({ ddb, s3 });
    assert.ok(result.body.rows[0].errors.some((item) => /PENDING/i.test(item.message)));
  });

  await test("missing assignee is invalid", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const row = [...VALID_ROW];
    row[2] = "ghost@mydgv.com";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, row] }) });
    const result = await preview({ ddb, s3 });
    assert.ok(
      result.body.rows[0].errors.some((item) =>
        /does not exist/i.test(item.message)
      )
    );
  });

  await test("multiple assignees report each invalid email separately", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const row = [...VALID_ROW];
    row[2] = "priya@mydgv.com; ghost@mydgv.com; blocked@mydgv.com";
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: paddedWorkbook(7, row) });
    const result = await preview({ ddb, s3 });
    const previewRow = result.body.rows[0];
    assert.strictEqual(previewRow.status, "INVALID");
    const assigneeErrors = previewRow.cellErrors.filter((item) => item.cell === "C7");
    assert.ok(assigneeErrors.some((item) => item.value === "ghost@mydgv.com"));
    assert.ok(assigneeErrors.some((item) => item.value === "blocked@mydgv.com"));
    assert.strictEqual(assigneeErrors.length, 2);
    assert.deepStrictEqual(previewRow.resolvedAssignees, [
      { email: "priya@mydgv.com", status: "ACTIVE" },
    ]);
  });

  await test("exact cell references for priority and start date", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const priorityRow = [...VALID_ROW];
    priorityRow[5] = "URGENT";
    const startRow = [...VALID_ROW];
    startRow[6] = "15/10/2026";
    const rows = [TASK_IMPORT_COLUMNS];
    for (let r = 2; r <= 20; r += 1) {
      if (r === 14) rows.push(priorityRow);
      else if (r === 20) rows.push(startRow);
      else rows.push(["", "", "", "", "", "", "", "", "", "", ""]);
    }
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: workbookBuffer({ rows }) });
    const result = await preview({ ddb, s3 });
    const byRow = Object.fromEntries(result.body.rows.map((row) => [row.rowNumber, row]));
    assert.ok(byRow[14].cellErrors.some((item) => item.cell === "F14"));
    assert.ok(byRow[20].cellErrors.some((item) => item.cell === "G20"));
    assert.strictEqual(byRow[14].cellErrors.find((item) => item.cell === "F14").column, "Priority");
    assert.strictEqual(byRow[20].cellErrors.find((item) => item.cell === "G20").column, "Start Date");
  });

  await test("repeated preview overwrites the same ROW keys", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const meta = seedMeta(ddb);
    const objects = {
      [meta.s3Key]: workbookBuffer({
        rows: [TASK_IMPORT_COLUMNS, VALID_ROW, VALID_ROW],
      }),
    };
    const s3 = createMemoryS3(objects);
    const first = await preview({ ddb, s3 });
    assert.strictEqual(first.body.totalRows, 2);
    assert.strictEqual(rowItems(ddb).length, 2);
    objects[meta.s3Key] = workbookBuffer({
      rows: [TASK_IMPORT_COLUMNS, VALID_ROW],
    });
    const second = await preview({ ddb, s3 });
    assert.strictEqual(second.body.totalRows, 1);
    assert.strictEqual(rowItems(ddb).length, 1);
    assert.strictEqual(rowItems(ddb)[0].SK, rowSk(2));
    assert.strictEqual(metaItem(ddb).totalRows, 1);
    assert.strictEqual(metaItem(ddb).validRows, 1);
  });

  await test("unauthorized employee is denied", async () => {
    const ddb = createMemoryDdb();
    seedMeta(ddb);
    const result = await preview({
      ddb,
      s3: createMemoryS3({}),
      user: EMPLOYEE,
    });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(rowItems(ddb).length, 0);
  });

  await test("nonexistent batch returns 404", async () => {
    const ddb = createMemoryDdb();
    seedAccess(ddb);
    const result = await preview({
      ddb,
      s3: createMemoryS3({}),
      batchId: "missing-batch-id",
    });
    assert.strictEqual(result.statusCode, 404);
  });

  await test("wrong uploader cannot preview another admin batch", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({ [meta.s3Key]: workbookBuffer() });
    const result = await preview({ ddb, s3, user: OTHER_ADMIN });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(rowItems(ddb).length, 0);
    assert.strictEqual(metaItem(ddb).status, "UPLOADED");
  });

  await test("missing S3 object returns 404", async () => {
    const ddb = createMemoryDdb();
    seedAccess(ddb);
    seedMeta(ddb);
    const result = await preview({ ddb, s3: createMemoryS3({}) });
    assert.strictEqual(result.statusCode, 404);
    assert.match(result.body.error, /file not found/i);
    assert.strictEqual(metaItem(ddb).status, "UPLOADED");
  });

  await test("parser workbook errors are stored as NEEDS_FIX", async () => {
    const ddb = createMemoryDdb();
    seedProjects(ddb);
    seedAccess(ddb);
    const meta = seedMeta(ddb);
    const s3 = createMemoryS3({
      [meta.s3Key]: workbookBuffer({
        rows: [["Note"], ["hello"]],
        sheetName: "Instructions",
      }),
    });
    const result = await preview({ ddb, s3 });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "NEEDS_FIX");
    assert.ok(result.body.errors.some((item) => /Tasks/i.test(item.message)));
    assert.strictEqual(result.body.rows.length, 0);
    assert.strictEqual(metaItem(ddb).status, "NEEDS_FIX");
    assert.strictEqual(rowItems(ddb).length, 0);
  });

  await test("invalid batchId is rejected", async () => {
    const ddb = createMemoryDdb();
    seedAccess(ddb);
    const result = await preview({
      ddb,
      s3: createMemoryS3({}),
      batchId: "../secret",
    });
    assert.strictEqual(result.statusCode, 400);
  });

  console.log(`taskImportPreview.test.js: ${passed} tests passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

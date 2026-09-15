const assert = require("assert");
const XLSX = require("xlsx");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { GetObjectCommand } = require("@aws-sdk/client-s3");

const emailCalls = [];
const email = require("../common/email");
email.sendEmail = async (payload) => {
  emailCalls.push(payload);
  return { ok: true, messageId: "test-ses" };
};

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
  confirmPathMatch,
  handleConfirmRequest,
  importedTaskId,
  assignedNotifyKey,
  isPendingScheduledTask,
  isProcessingLeaseStale,
  isAssigningLeaseStale,
  assignDueScheduledTasks,
  ROW_IMPORTED,
  ASSIGNMENT_PENDING,
  ASSIGNMENT_ASSIGNING,
  ASSIGNMENT_ASSIGNED,
} = require("./taskImportConfirm");

process.env.TASK_IMPORT_MAX_ROWS = "200";
process.env.TASK_IMPORT_MAX_BYTES = "5242880";
process.env.TASK_IMPORT_PROCESSING_LEASE_MS = "180000";
process.env.TASK_SCHEDULED_ASSIGN_LEASE_MS = "180000";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";

const NOW = "2026-09-15T09:40:00.000Z";
const NOW_MS = Date.parse("2026-09-15T09:00:00+05:30");
const SCHEDULED_DUE_MS = Date.parse("2026-10-15T10:00:00+05:30");
const BATCH_ID = "batch-confirm-001";
const WORK_TABLE = "work-table";
const ACCESS_TABLE = "access-table";
const BUCKET = "docs-bucket";
const PORTAL_ID = "11111111-aaaa-bbbb-cccc-portal000001";
const TESTING_ID = "22222222-aaaa-bbbb-cccc-testing00002";
const TESTING_DUP_ID = "33333333-aaaa-bbbb-cccc-testing00003";

process.env.WORK_TABLE = WORK_TABLE;

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

const SCHEDULED_ROW = [
  "Leave calendar",
  "DGV Employee Portal",
  "priya@mydgv.com",
  "SCHEDULED",
  "Development",
  "MEDIUM",
  "2026-10-15",
  "10:00",
  "2026-10-20",
  "18:00",
  "Upcoming leave calendar.",
];

const MULTI_ASSIGNEE_ROW = [
  "Shared homepage work",
  "DGV Employee Portal",
  "rahul@mydgv.com; priya@mydgv.com",
  "IMMEDIATE",
  "Development",
  "HIGH",
  "2026-10-01",
  "09:30",
  "2026-10-03",
  "18:00",
  "Two assignees.",
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

function resolveAttrName(token, names = {}) {
  const key = String(token || "").trim();
  if (key.startsWith("#")) return names[key] || key.slice(1);
  return key;
}

function failConditional() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  throw err;
}

function evalCondition(item, expr, names, values) {
  if (!expr) return true;
  const s = String(expr);
  let i = 0;
  function skip() {
    while (i < s.length && s[i] === " ") i += 1;
  }
  function parseOr() {
    let left = parseAnd();
    skip();
    while (/^OR\b/i.test(s.slice(i))) {
      i += 2;
      skip();
      left = parseAnd() || left;
      skip();
    }
    return left;
  }
  function parseAnd() {
    let left = parsePrimary();
    skip();
    while (/^AND\b/i.test(s.slice(i))) {
      i += 3;
      skip();
      left = parsePrimary() && left;
      skip();
    }
    return left;
  }
  function parsePrimary() {
    skip();
    if (s[i] === "(") {
      i += 1;
      const value = parseOr();
      skip();
      if (s[i] === ")") i += 1;
      return value;
    }
    const rest = s.slice(i);
    const notExists = rest.match(/^attribute_not_exists\(([^)]+)\)/i);
    if (notExists) {
      i += notExists[0].length;
      const attr = resolveAttrName(notExists[1], names);
      return item[attr] === undefined || item[attr] === null;
    }
    const cmp = rest.match(/^([#A-Za-z0-9_]+)\s*(=|<=|<|>=|>)\s*(:[A-Za-z0-9_]+)/);
    if (!cmp) {
      throw new Error(`unparsed condition: ${rest}`);
    }
    i += cmp[0].length;
    const left = item[resolveAttrName(cmp[1], names)];
    const right = values[cmp[3]];
    if (cmp[2] === "=") return left === right;
    if (cmp[2] === "<") return left < right;
    if (cmp[2] === "<=") return left <= right;
    if (cmp[2] === ">") return left > right;
    if (cmp[2] === ">=") return left >= right;
    return false;
  }
  const ok = parseOr();
  skip();
  if (i < s.length) throw new Error(`trailing condition: ${s.slice(i)}`);
  return ok;
}

function applyUpdateExpression(item, updateExpression, names, values) {
  const next = { ...item };
  const setMatch = String(updateExpression || "").match(/SET\s+(.+)/i);
  if (!setMatch) return next;
  for (const part of setMatch[1].split(",")) {
    const [rawLeft, rawRight] = part.split("=").map((piece) => piece.trim());
    next[resolveAttrName(rawLeft, names)] = values[rawRight];
  }
  return next;
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
        const { TableName, Item, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues } =
          command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Item.PK &&
            row.Item.SK === Item.SK
        );
        if (ConditionExpression) {
          const current = found ? found.Item : {};
          if (
            !evalCondition(
              current,
              ConditionExpression,
              ExpressionAttributeNames || {},
              ExpressionAttributeValues || {}
            )
          ) {
            failConditional();
          }
        }
        this.seed(TableName, Item);
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
      if (command instanceof UpdateCommand) {
        const {
          TableName,
          Key,
          ConditionExpression,
          UpdateExpression,
          ExpressionAttributeNames = {},
          ExpressionAttributeValues = {},
        } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        if (!found) failConditional();
        if (
          ConditionExpression &&
          !evalCondition(
            found.Item,
            ConditionExpression,
            ExpressionAttributeNames,
            ExpressionAttributeValues
          )
        ) {
          failConditional();
        }
        const next = applyUpdateExpression(
          found.Item,
          UpdateExpression,
          ExpressionAttributeNames,
          ExpressionAttributeValues
        );
        found.Item = next;
        return { Attributes: { ...next } };
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
    status: "READY",
    totalRows: 1,
    validRows: 1,
    invalidRows: 0,
    ...overrides,
  };
  ddb.seed(WORK_TABLE, meta);
  return meta;
}

function readyEnv({ rows, extraProjects, metaOverrides } = {}) {
  const ddb = createMemoryDdb();
  seedProjects(ddb, extraProjects);
  seedAccess(ddb);
  const sheetRows = rows || [TASK_IMPORT_COLUMNS, VALID_ROW];
  const meta = seedMeta(ddb, {
    totalRows: Math.max(0, sheetRows.length - 1),
    ...metaOverrides,
  });
  const s3 = createMemoryS3({
    [meta.s3Key]: workbookBuffer({ rows: sheetRows }),
  });
  return { ddb, s3, meta };
}

async function confirm(env, extras = {}) {
  return handleConfirmRequest({
    user: extras.user || ADMIN,
    batchId: extras.batchId || BATCH_ID,
    ddb: env.ddb,
    s3: env.s3,
    now: NOW,
    nowMs: NOW_MS,
    tableName: WORK_TABLE,
    bucket: BUCKET,
    accessTable: ACCESS_TABLE,
    ...extras,
  });
}

function metaItem(ddb) {
  return ddb
    .of(WORK_TABLE)
    .find((item) => item.PK === importPk(BATCH_ID) && item.SK === META_SK);
}

function entityTasks(ddb) {
  return ddb.of(WORK_TABLE).filter((item) => item.PK === "ENTITY#TASK");
}

function assignmentItems(ddb, taskId) {
  return ddb
    .of(WORK_TABLE)
    .filter(
      (item) => item.PK === `TASK#${taskId}` && String(item.SK).startsWith("ASSIGNMENT#")
    );
}

function reminderItems(ddb) {
  return ddb
    .of(WORK_TABLE)
    .filter((item) => String(item.SK || "").startsWith("REMINDER#"));
}

function notifyItems(ddb) {
  return ddb
    .of(WORK_TABLE)
    .filter((item) => String(item.SK || "").startsWith("NOTIFY#"));
}

function rowItems(ddb) {
  return ddb
    .of(WORK_TABLE)
    .filter((item) => item.PK === importPk(BATCH_ID) && String(item.SK).startsWith("ROW#"));
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
  await test("confirm path matcher", () => {
    assert.strictEqual(
      confirmPathMatch("/task-imports/abc-123/confirm"),
      "abc-123"
    );
    assert.strictEqual(
      confirmPathMatch("/prod/task-imports/abc-123/confirm"),
      "abc-123"
    );
    assert.strictEqual(
      confirmPathMatch("/task-imports/abc-123/confirm", { batchId: "abc-123" }),
      "abc-123"
    );
    assert.strictEqual(confirmPathMatch("/task-imports/upload-url"), null);
    assert.strictEqual(confirmPathMatch("/task-imports/abc-123/preview"), null);
  });

  await test("valid confirmation creates immediate and scheduled tasks", async () => {
    emailCalls.length = 0;
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, VALID_ROW, SCHEDULED_ROW],
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "COMPLETED");
    assert.strictEqual(result.body.totalRows, 2);
    assert.strictEqual(result.body.successCount, 2);
    assert.strictEqual(result.body.failureCount, 0);
    assert.strictEqual(result.body.tasks.length, 2);
    const immediate = result.body.tasks.find((row) => row.assignmentMode === "IMMEDIATE");
    const scheduled = result.body.tasks.find((row) => row.assignmentMode === "SCHEDULED");
    assert.ok(immediate.taskId);
    assert.strictEqual(immediate.status, "ASSIGNED");
    assert.strictEqual(scheduled.status, "SCHEDULED");
    const tasks = entityTasks(env.ddb);
    assert.strictEqual(tasks.length, 2);
    const createdImmediate = tasks.find((item) => item.taskId === immediate.taskId);
    const createdScheduled = tasks.find((item) => item.taskId === scheduled.taskId);
    assert.strictEqual(createdImmediate.importSource, "EXCEL");
    assert.strictEqual(createdImmediate.importBatchId, BATCH_ID);
    assert.strictEqual(createdImmediate.importRowNumber, 2);
    assert.strictEqual(createdImmediate.createdBy, ADMIN.email);
    assert.ok(createdImmediate.createdByName);
    assert.strictEqual(createdImmediate.projectId, PORTAL_ID);
    assert.strictEqual(createdImmediate.title, "Homepage banner update");
    assert.strictEqual(createdImmediate.category, "Development");
    assert.strictEqual(createdImmediate.priority, "HIGH");
    assert.strictEqual(createdImmediate.archived, false);
    assert.ok(createdImmediate.createdAt);
    assert.ok(createdImmediate.updatedAt);
    assert.ok(Array.isArray(createdImmediate.labels));
    assert.strictEqual(createdImmediate.assignmentMode, "IMMEDIATE");
    assert.strictEqual(createdImmediate.assignmentState, "ASSIGNED");
    assert.deepStrictEqual(assignmentItems(env.ddb, createdImmediate.taskId).map((a) => a.email).sort(), [
      "rahul@mydgv.com",
    ]);
    assert.ok(isPendingScheduledTask(createdScheduled));
    assert.deepStrictEqual(createdScheduled.assignees, []);
    assert.strictEqual(createdScheduled.assignmentState, "PENDING");
    assert.strictEqual(createdScheduled.scheduledAssignAt, "2026-10-15T10:00:00+05:30");
    assert.deepStrictEqual(createdScheduled.pendingAssignees, ["priya@mydgv.com"]);
    assert.strictEqual(assignmentItems(env.ddb, createdScheduled.taskId).length, 0);
    const meta = metaItem(env.ddb);
    assert.strictEqual(meta.status, "COMPLETED");
    assert.strictEqual(meta.confirmedBy, ADMIN.email);
    assert.strictEqual(meta.confirmedAt, NOW);
    assert.strictEqual(meta.completedAt, NOW);
    assert.strictEqual(meta.processedRows, 2);
    assert.strictEqual(meta.successCount, 2);
    assert.strictEqual(meta.failureCount, 0);
    assert.strictEqual(meta.processingStartedAt, undefined);
    assert.strictEqual(meta.processingOwner, undefined);
    assert.ok(env.s3.objects[meta.s3Key], "original.xlsx must remain after confirm");
  });

  await test("invalid batch cannot confirm", async () => {
    const env = readyEnv();
    seedMeta(env.ddb, { status: "NEEDS_FIX", invalidRows: 1, validRows: 0 });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(result.body.status, "NEEDS_FIX");
    assert.strictEqual(entityTasks(env.ddb).length, 0);
  });

  await test("employee is denied", async () => {
    const env = readyEnv();
    const result = await confirm(env, { user: EMPLOYEE });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(entityTasks(env.ddb).length, 0);
  });

  await test("wrong uploader is denied", async () => {
    const env = readyEnv();
    const result = await confirm(env, { user: OTHER_ADMIN });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(entityTasks(env.ddb).length, 0);
  });

  await test("READY to PROCESSING conditional lock prevents duplicate creates", async () => {
    const env = readyEnv();
    const first = confirm(env);
    const second = confirm(env);
    const results = await Promise.all([first, second]);
    assert.ok(results.every((item) => item.statusCode === 200));
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    const ids = new Set(
      results.flatMap((item) => (item.body.tasks || []).map((row) => row.taskId)).filter(Boolean)
    );
    assert.ok(ids.size <= 1);
  });

  await test("duplicate confirmation reuses existing tasks", async () => {
    const env = readyEnv();
    const first = await confirm(env);
    const second = await confirm(env);
    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(second.body.status, "COMPLETED");
    assert.deepStrictEqual(
      second.body.tasks.map((row) => row.taskId),
      first.body.tasks.map((row) => row.taskId)
    );
    assert.strictEqual(entityTasks(env.ddb).length, 1);
  });

  await test("already COMPLETED confirmation returns existing state", async () => {
    const env = readyEnv();
    const first = await confirm(env);
    const meta = metaItem(env.ddb);
    assert.strictEqual(meta.status, "COMPLETED");
    const again = await confirm(env);
    assert.strictEqual(again.statusCode, 200);
    assert.strictEqual(again.body.status, "COMPLETED");
    assert.strictEqual(again.body.tasks[0].taskId, first.body.tasks[0].taskId);
    assert.strictEqual(entityTasks(env.ddb).length, 1);
  });

  await test("revalidation catches a project that no longer exists", async () => {
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, [
        "Broken row",
        "Missing Project",
        "rahul@mydgv.com",
        "IMMEDIATE",
        "Development",
        "HIGH",
        "2026-10-01",
        "09:30",
        "2026-10-03",
        "18:00",
        "Gone.",
      ]],
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(result.body.status, "NEEDS_FIX");
    assert.strictEqual(entityTasks(env.ddb).length, 0);
    assert.ok(result.body.rows[0].cellErrors.some((item) => item.cell === "B2"));
    assert.strictEqual(metaItem(env.ddb).status, "NEEDS_FIX");
  });

  await test("project matching is case-insensitive and trims whitespace", async () => {
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, [
        "Case match",
        "  testing ",
        "rahul@mydgv.com",
        "IMMEDIATE",
        "Development",
        "HIGH",
        "2026-10-01",
        "09:30",
        "2026-10-03",
        "18:00",
        "Matched.",
      ]],
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(entityTasks(env.ddb)[0].projectId, TESTING_ID);
  });

  await test("duplicate normalized project names fail confirmation", async () => {
    const env = readyEnv({
      extraProjects: [{ projectId: TESTING_DUP_ID, name: "TESTING" }],
      rows: [TASK_IMPORT_COLUMNS, [
        "Ambiguous project",
        "Testing",
        "rahul@mydgv.com",
        "IMMEDIATE",
        "Development",
        "HIGH",
        "2026-10-01",
        "09:30",
        "2026-10-03",
        "18:00",
        "Ambiguous.",
      ]],
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(result.body.status, "NEEDS_FIX");
    assert.strictEqual(entityTasks(env.ddb).length, 0);
    assert.ok(
      result.body.rows[0].errors.some((item) => /more than one project/i.test(item.message))
    );
  });

  await test("nonexistent project reports the Excel cell and creates no tasks", async () => {
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, [
        "Missing",
        "No Such Project",
        "rahul@mydgv.com",
        "IMMEDIATE",
        "Development",
        "HIGH",
        "2026-10-01",
        "09:30",
        "2026-10-03",
        "18:00",
        "Missing.",
      ]],
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 400);
    const cell = result.body.rows[0].cellErrors.find((item) => item.cell === "B2");
    assert.ok(cell);
    assert.match(cell.message, /does not exist/i);
    assert.strictEqual(entityTasks(env.ddb).length, 0);
  });

  await test("ACTIVE assignee is accepted", async () => {
    const env = readyEnv();
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(entityTasks(env.ddb)[0].assignee, "rahul@mydgv.com");
  });

  await test("BLOCKED assignee is rejected", async () => {
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, [
        "Blocked",
        "DGV Employee Portal",
        "blocked@mydgv.com",
        "IMMEDIATE",
        "Development",
        "HIGH",
        "2026-10-01",
        "09:30",
        "2026-10-03",
        "18:00",
        "Blocked.",
      ]],
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 400);
    assert.ok(result.body.rows[0].errors.some((item) => /BLOCKED/i.test(item.message)));
    assert.strictEqual(entityTasks(env.ddb).length, 0);
  });

  await test("PENDING assignee is rejected", async () => {
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, [
        "Pending",
        "DGV Employee Portal",
        "pending@mydgv.com",
        "IMMEDIATE",
        "Development",
        "HIGH",
        "2026-10-01",
        "09:30",
        "2026-10-03",
        "18:00",
        "Pending.",
      ]],
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 400);
    assert.ok(result.body.rows[0].errors.some((item) => /PENDING/i.test(item.message)));
    assert.strictEqual(entityTasks(env.ddb).length, 0);
  });

  await test("missing assignee is rejected", async () => {
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, [
        "Missing user",
        "DGV Employee Portal",
        "ghost@mydgv.com",
        "IMMEDIATE",
        "Development",
        "HIGH",
        "2026-10-01",
        "09:30",
        "2026-10-03",
        "18:00",
        "Ghost.",
      ]],
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 400);
    assert.ok(result.body.rows[0].errors.some((item) => /does not exist/i.test(item.message)));
    assert.strictEqual(entityTasks(env.ddb).length, 0);
  });

  await test("multiple semicolon-separated assignees are created", async () => {
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, MULTI_ASSIGNEE_ROW] });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    const task = entityTasks(env.ddb)[0];
    assert.deepStrictEqual([...task.assignees].sort(), [
      "priya@mydgv.com",
      "rahul@mydgv.com",
    ]);
    assert.strictEqual(assignmentItems(env.ddb, task.taskId).length, 2);
  });

  await test("IMMEDIATE assignment records and TASK_ASSIGNED in-app notification", async () => {
    emailCalls.length = 0;
    const env = readyEnv();
    const result = await confirm(env);
    const taskId = result.body.tasks[0].taskId;
    const assignments = assignmentItems(env.ddb, taskId);
    assert.strictEqual(assignments.length, 1);
    assert.strictEqual(assignments[0].email, "rahul@mydgv.com");
    assert.strictEqual(assignments[0].status, "TODO");
    assert.strictEqual(assignments[0].assignedBy, ADMIN.email);
    const reminderSk = `REMINDER#TASK_ASSIGNED#${assignedNotifyKey(taskId, "rahul@mydgv.com")}`;
    const reminder = env.ddb
      .of(WORK_TABLE)
      .find((item) => item.PK === "USER#rahul@mydgv.com" && item.SK === reminderSk);
    assert.ok(reminder);
    assert.strictEqual(reminder.channel, "inapp");
    assert.ok(
      notifyItems(env.ddb).some(
        (item) => item.email === "rahul@mydgv.com" && item.type === "TASK_ASSIGNED"
      )
    );
    assert.strictEqual(emailCalls.length, 0);
  });

  await test("SCHEDULED task remains unassigned and is not notified before start", async () => {
    emailCalls.length = 0;
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    const result = await confirm(env);
    const taskId = result.body.tasks[0].taskId;
    const task = entityTasks(env.ddb)[0];
    assert.strictEqual(result.body.tasks[0].status, "SCHEDULED");
    assert.ok(isPendingScheduledTask(task));
    assert.strictEqual(assignmentItems(env.ddb, taskId).length, 0);
    assert.strictEqual(reminderItems(env.ddb).length, 0);
    assert.strictEqual(notifyItems(env.ddb).length, 0);
    const early = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: NOW_MS,
    });
    assert.strictEqual(early.processed, 0);
    assert.strictEqual(assignmentItems(env.ddb, taskId).length, 0);
    const late = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: SCHEDULED_DUE_MS + 5 * 60 * 1000,
    });
    assert.strictEqual(late.processed, 1);
    assert.strictEqual(assignmentItems(env.ddb, taskId).length, 1);
    const assigned = entityTasks(env.ddb)[0];
    assert.strictEqual(assigned.assignmentState, "ASSIGNED");
    assert.ok(!isPendingScheduledTask(assigned));
    assert.ok(notifyItems(env.ddb).some((item) => item.type === "TASK_ASSIGNED"));
    assert.strictEqual(emailCalls.length, 0);
  });

  await test("import provenance and row idempotency", async () => {
    const env = readyEnv();
    const taskId = importedTaskId(BATCH_ID, 2);
    env.ddb.seed(WORK_TABLE, {
      PK: importPk(BATCH_ID),
      SK: rowSk(2),
      type: "TASK_IMPORT_ROW",
      batchId: BATCH_ID,
      rowNumber: 2,
      status: ROW_IMPORTED,
      taskId,
      assignmentMode: "IMMEDIATE",
      importedAt: "2026-09-15T08:00:00.000Z",
    });
    env.ddb.seed(WORK_TABLE, {
      PK: "ENTITY#TASK",
      SK: `TASK#${taskId}`,
      taskId,
      title: "Homepage banner update",
      importSource: "EXCEL",
      importBatchId: BATCH_ID,
      importRowNumber: 2,
      assignmentMode: "IMMEDIATE",
      assignmentState: "ASSIGNED",
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.tasks[0].taskId, taskId);
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    const row = rowItems(env.ddb).find((item) => item.rowNumber === 2);
    assert.strictEqual(row.status, ROW_IMPORTED);
    assert.strictEqual(row.taskId, taskId);
    assert.strictEqual(row.importedAt, "2026-09-15T08:00:00.000Z");
  });

  await test("retry does not duplicate TASK_ASSIGNED notifications", async () => {
    emailCalls.length = 0;
    const env = readyEnv();
    await confirm(env);
    const beforeNotify = notifyItems(env.ddb).length;
    const beforeReminder = reminderItems(env.ddb).length;
    await confirm(env);
    assert.strictEqual(notifyItems(env.ddb).length, beforeNotify);
    assert.strictEqual(reminderItems(env.ddb).length, beforeReminder);
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    assert.strictEqual(emailCalls.length, 0);
  });

  await test("unexpected row creation failure records PARTIAL or FAILED", async () => {
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, VALID_ROW, SCHEDULED_ROW],
    });
    const orig = env.ddb.send.bind(env.ddb);
    let taskPuts = 0;
    env.ddb.send = async (command) => {
      if (
        command instanceof PutCommand &&
        command.input.Item?.PK === "ENTITY#TASK"
      ) {
        taskPuts += 1;
        if (taskPuts === 2) {
          throw new Error("simulated dynamo failure");
        }
      }
      return orig(command);
    };
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.ok(["PARTIAL", "FAILED"].includes(result.body.status));
    assert.ok(result.body.failureCount >= 1);
    assert.notStrictEqual(result.body.status, "COMPLETED");
    const meta = metaItem(env.ddb);
    assert.notStrictEqual(meta.status, "COMPLETED");
    assert.ok(meta.failureCount >= 1);
  });

  await test("active PROCESSING cannot be concurrently claimed", async () => {
    const env = readyEnv();
    seedMeta(env.ddb, {
      status: "PROCESSING",
      processingStartedAt: new Date(NOW_MS).toISOString(),
      processingOwner: "owner-live",
      confirmedBy: ADMIN.email,
      confirmedAt: NOW,
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "PROCESSING");
    assert.strictEqual(entityTasks(env.ddb).length, 0);
    assert.ok(isProcessingLeaseStale(metaItem(env.ddb), NOW_MS) === false);
  });

  await test("stale PROCESSING can be reclaimed and resumed", async () => {
    const env = readyEnv();
    seedMeta(env.ddb, {
      status: "PROCESSING",
      processingStartedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
      processingOwner: "owner-stale",
      confirmedBy: ADMIN.email,
      confirmedAt: NOW,
    });
    assert.ok(isProcessingLeaseStale(metaItem(env.ddb), NOW_MS));
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "COMPLETED");
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    assert.strictEqual(metaItem(env.ddb).processingStartedAt, undefined);
  });

  await test("only one stale-recovery request wins", async () => {
    const env = readyEnv();
    seedMeta(env.ddb, {
      status: "PROCESSING",
      processingStartedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
      processingOwner: "owner-stale",
      confirmedBy: ADMIN.email,
    });
    const results = await Promise.all([confirm(env), confirm(env)]);
    assert.ok(results.every((item) => item.statusCode === 200));
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    const completed = results.filter((item) => item.body.status === "COMPLETED");
    assert.ok(completed.length >= 1);
  });

  await test("recovery skips IMPORTED rows and reuses deterministic taskId", async () => {
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, VALID_ROW, SCHEDULED_ROW],
    });
    const taskId = importedTaskId(BATCH_ID, 2);
    env.ddb.seed(WORK_TABLE, {
      PK: importPk(BATCH_ID),
      SK: rowSk(2),
      type: "TASK_IMPORT_ROW",
      batchId: BATCH_ID,
      rowNumber: 2,
      status: ROW_IMPORTED,
      taskId,
      assignmentMode: "IMMEDIATE",
      importedAt: "2026-09-15T08:00:00.000Z",
    });
    env.ddb.seed(WORK_TABLE, {
      PK: "ENTITY#TASK",
      SK: `TASK#${taskId}`,
      taskId,
      title: "Homepage banner update",
      importSource: "EXCEL",
      importBatchId: BATCH_ID,
      importRowNumber: 2,
      assignmentMode: "IMMEDIATE",
      assignmentState: "ASSIGNED",
    });
    seedMeta(env.ddb, {
      status: "PROCESSING",
      processingStartedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
      processingOwner: "owner-stale",
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "COMPLETED");
    assert.strictEqual(result.body.tasks[0].taskId, taskId);
    assert.strictEqual(
      entityTasks(env.ddb).filter((item) => item.taskId === taskId).length,
      1
    );
    assert.strictEqual(entityTasks(env.ddb).length, 2);
  });

  await test("PARTIAL can resume remaining rows", async () => {
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, VALID_ROW, SCHEDULED_ROW],
    });
    const orig = env.ddb.send.bind(env.ddb);
    let taskPuts = 0;
    env.ddb.send = async (command) => {
      if (
        command instanceof PutCommand &&
        command.input.Item?.PK === "ENTITY#TASK"
      ) {
        taskPuts += 1;
        if (taskPuts === 2) throw new Error("simulated dynamo failure");
      }
      return orig(command);
    };
    const first = await confirm(env);
    assert.ok(["PARTIAL", "FAILED"].includes(first.body.status));
    const firstIds = (first.body.tasks || []).map((row) => row.taskId);
    env.ddb.send = orig;
    const second = await confirm(env);
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(second.body.status, "COMPLETED");
    assert.strictEqual(second.body.successCount, 2);
    assert.strictEqual(entityTasks(env.ddb).length, 2);
    if (firstIds[0]) {
      assert.ok(second.body.tasks.some((row) => row.taskId === firstIds[0]));
    }
  });

  await test("FAILED can safely retry remaining rows", async () => {
    const env = readyEnv();
    const orig = env.ddb.send.bind(env.ddb);
    env.ddb.send = async (command) => {
      if (
        command instanceof PutCommand &&
        command.input.Item?.PK === "ENTITY#TASK"
      ) {
        throw new Error("simulated dynamo failure");
      }
      return orig(command);
    };
    const first = await confirm(env);
    assert.strictEqual(first.body.status, "FAILED");
    env.ddb.send = orig;
    const second = await confirm(env);
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(second.body.status, "COMPLETED");
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    assert.strictEqual(metaItem(env.ddb).processingStartedAt, undefined);
  });

  await test("existing deterministic task is marked IMPORTED on recovery", async () => {
    const env = readyEnv();
    const taskId = importedTaskId(BATCH_ID, 2);
    env.ddb.seed(WORK_TABLE, {
      PK: "ENTITY#TASK",
      SK: `TASK#${taskId}`,
      taskId,
      title: "Homepage banner update",
      assignmentMode: "IMMEDIATE",
      assignmentState: "ASSIGNED",
    });
    seedMeta(env.ddb, {
      status: "FAILED",
      failureCount: 1,
      successCount: 0,
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "COMPLETED");
    assert.strictEqual(result.body.tasks[0].taskId, taskId);
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    const row = rowItems(env.ddb).find((item) => item.rowNumber === 2);
    assert.strictEqual(row.status, ROW_IMPORTED);
    assert.strictEqual(row.taskId, taskId);
  });

  await test("PENDING to ASSIGNING is conditional and exclusive", async () => {
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    const dueMs = SCHEDULED_DUE_MS + 5 * 60 * 1000;
    const first = assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: dueMs,
    });
    const second = assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: dueMs,
    });
    const results = await Promise.all([first, second]);
    assert.strictEqual(results.reduce((sum, item) => sum + item.processed, 0), 1);
    const task = entityTasks(env.ddb)[0];
    assert.strictEqual(task.assignmentState, ASSIGNMENT_ASSIGNED);
    assert.strictEqual(assignmentItems(env.ddb, task.taskId).length, 1);
    assert.strictEqual(
      notifyItems(env.ddb).filter((item) => item.type === "TASK_ASSIGNED").length,
      1
    );
  });

  await test("active ASSIGNING is not reclaimed", async () => {
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    const dueMs = SCHEDULED_DUE_MS + 5 * 60 * 1000;
    const task = entityTasks(env.ddb)[0];
    env.ddb.seed(WORK_TABLE, {
      ...task,
      assignmentState: ASSIGNMENT_ASSIGNING,
      assigningStartedAt: new Date(dueMs).toISOString(),
      assigningOwner: "live-owner",
    });
    assert.strictEqual(isAssigningLeaseStale(entityTasks(env.ddb)[0], dueMs), false);
    const result = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(result.processed, 0);
    assert.strictEqual(entityTasks(env.ddb)[0].assignmentState, ASSIGNMENT_ASSIGNING);
    assert.strictEqual(assignmentItems(env.ddb, task.taskId).length, 0);
    assert.ok(isPendingScheduledTask(entityTasks(env.ddb)[0]));
  });

  await test("stale ASSIGNING can be reclaimed without duplicate notify", async () => {
    emailCalls.length = 0;
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    const dueMs = SCHEDULED_DUE_MS + 5 * 60 * 1000;
    const task = entityTasks(env.ddb)[0];
    env.ddb.seed(WORK_TABLE, {
      ...task,
      assignmentState: ASSIGNMENT_ASSIGNING,
      assigningStartedAt: new Date(dueMs - 5 * 60 * 1000).toISOString(),
      assigningOwner: "stale-owner",
    });
    assert.ok(isAssigningLeaseStale(entityTasks(env.ddb)[0], dueMs));
    const first = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(first.processed, 1);
    const assigned = entityTasks(env.ddb)[0];
    assert.strictEqual(assigned.assignmentState, ASSIGNMENT_ASSIGNED);
    assert.strictEqual(assigned.assigningStartedAt, undefined);
    const notifyCount = notifyItems(env.ddb).filter((item) => item.type === "TASK_ASSIGNED").length;
    assert.strictEqual(notifyCount, 1);
    const second = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(second.processed, 0);
    assert.strictEqual(
      notifyItems(env.ddb).filter((item) => item.type === "TASK_ASSIGNED").length,
      1
    );
    assert.strictEqual(assignmentItems(env.ddb, task.taskId).length, 1);
    assert.strictEqual(emailCalls.length, 0);
  });

  await test("failed scheduled assignment remains recoverable", async () => {
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    const dueMs = SCHEDULED_DUE_MS + 5 * 60 * 1000;
    const orig = env.ddb.send.bind(env.ddb);
    env.ddb.send = async (command) => {
      if (
        command instanceof PutCommand &&
        command.input.Item?.PK &&
        String(command.input.Item.SK || "").startsWith("ASSIGNMENT#")
      ) {
        throw new Error("simulated assignment failure");
      }
      return orig(command);
    };
    const failed = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(failed.processed, 0);
    const afterFail = entityTasks(env.ddb)[0];
    assert.strictEqual(afterFail.assignmentState, ASSIGNMENT_ASSIGNING);
    env.ddb.send = orig;
    env.ddb.seed(WORK_TABLE, {
      ...afterFail,
      assigningStartedAt: new Date(dueMs - 5 * 60 * 1000).toISOString(),
    });
    const recovered = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(recovered.processed, 1);
    assert.strictEqual(entityTasks(env.ddb)[0].assignmentState, ASSIGNMENT_ASSIGNED);
    assert.strictEqual(assignmentItems(env.ddb, afterFail.taskId).length, 1);
  });

  await test("pending scheduled tasks remain excluded from escalation helpers", async () => {
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    const task = entityTasks(env.ddb)[0];
    assert.strictEqual(task.assignmentState, ASSIGNMENT_PENDING);
    assert.ok(isPendingScheduledTask(task));
    const early = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: NOW_MS,
    });
    assert.strictEqual(early.processed, 0);
    assert.strictEqual(assignmentItems(env.ddb, task.taskId).length, 0);
  });

  await test("manual tasks are unaffected by scheduled assignment sweep", async () => {
    const env = readyEnv();
    await confirm(env);
    env.ddb.seed(WORK_TABLE, {
      PK: "ENTITY#TASK",
      SK: "TASK#manual-task-1",
      taskId: "manual-task-1",
      title: "Manual task",
      status: "TODO",
      assignee: "rahul@mydgv.com",
      assignees: ["rahul@mydgv.com"],
    });
    const before = env.ddb
      .of(WORK_TABLE)
      .find((item) => item.taskId === "manual-task-1");
    await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: SCHEDULED_DUE_MS + 5 * 60 * 1000,
    });
    const after = env.ddb
      .of(WORK_TABLE)
      .find((item) => item.taskId === "manual-task-1");
    assert.deepStrictEqual(after, before);
    assert.strictEqual(isPendingScheduledTask(after), false);
  });
}

run()
  .then(() => {
    console.log(`\n${passed} tests passed`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

const assert = require("assert");
const XLSX = require("xlsx");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

const emailCalls = [];
const email = require("../common/email");
email.sendEmail = async (payload) => {
  emailCalls.push(payload);
  return { ok: true, messageId: "test-ses" };
};

function summaryEmails() {
  return emailCalls.filter((call) =>
    /Excel Task Import Completed/i.test(String(call.subject || ""))
  );
}

function assignmentEmails() {
  return emailCalls.filter((call) =>
    /new task assigned|excel task assigned|scheduled task assigned/i.test(
      String(call.subject || "")
    )
  );
}

function postponeEmails() {
  return emailCalls.filter((call) =>
    /scheduled task postponed/i.test(String(call.subject || ""))
  );
}

const {
  META_SK,
  TYPE_TASK_IMPORT,
  TASK_IMPORT_COLUMNS,
  AUDIT_ELIGIBILITY,
  WAIT_PK,
  buildImportMeta,
  buildS3Key,
  buildHoldS3Key,
  buildAuditS3Key,
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
  promoteWaitingImportAudits,
  ROW_IMPORTED,
  ASSIGNMENT_PENDING,
  ASSIGNMENT_ASSIGNING,
  ASSIGNMENT_ASSIGNED,
  ASSIGNMENT_SKIPPED,
  postponeScheduledTask,
} = require("./taskImportConfirm");
const escalation = require("./escalation");

process.env.TASK_IMPORT_MAX_ROWS = "200";
process.env.TASK_IMPORT_MAX_BYTES = "5242880";
process.env.TASK_IMPORT_PROCESSING_LEASE_MS = "180000";
process.env.TASK_SCHEDULED_ASSIGN_LEASE_MS = "180000";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";
process.env.PORTAL_URL = "https://login.mydgv.com";

const NOW = "2026-09-15T09:40:00.000Z";
const NOW_MS = Date.parse("2026-09-15T09:00:00+05:30");
const SCHEDULED_DUE_MS = Date.parse("2026-10-15T10:00:00+05:30");
const BATCH_ID = "batch-confirm-001";
const WORK_TABLE = "work-table";
const ACCESS_TABLE = "access-table";
const ATTENDANCE_TABLE = "attendance-table";
const BUCKET = "docs-bucket";
const PORTAL_ID = "11111111-aaaa-bbbb-cccc-portal000001";
const TESTING_ID = "22222222-aaaa-bbbb-cccc-testing00002";
const TESTING_DUP_ID = "33333333-aaaa-bbbb-cccc-testing00003";

process.env.WORK_TABLE = WORK_TABLE;
process.env.USER_ACCESS_TABLE = ACCESS_TABLE;
process.env.ATTENDANCE_TABLE = ATTENDANCE_TABLE;
process.env.TASK_ORANGE_MS = "86400000";

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

function isEntityTaskWrite(command) {
  if (command instanceof PutCommand && command.input.Item?.PK === "ENTITY#TASK") {
    return true;
  }
  if (command instanceof TransactWriteCommand) {
    return (command.input.TransactItems || []).some(
      (op) => op.Put?.Item?.PK === "ENTITY#TASK"
    );
  }
  return false;
}

function entityTaskWriteHasCondition(command) {
  if (command instanceof PutCommand) {
    return Boolean(command.input.ConditionExpression);
  }
  if (command instanceof TransactWriteCommand) {
    return (command.input.TransactItems || []).some(
      (op) => op.Put?.Item?.PK === "ENTITY#TASK" && op.Put.ConditionExpression
    );
  }
  return false;
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
    const exists = rest.match(/^attribute_exists\(([^)]+)\)/i);
    if (exists) {
      i += exists[0].length;
      const attr = resolveAttrName(exists[1], names);
      return item[attr] !== undefined && item[attr] !== null;
    }
    const attrType = rest.match(
      /^attribute_type\(([^,]+),\s*(:[A-Za-z0-9_]+)\)/i
    );
    if (attrType) {
      i += attrType[0].length;
      const attr = resolveAttrName(attrType[1], names);
      const expected = values[attrType[2]];
      if (String(expected).toUpperCase() === "NULL") {
        return item[attr] === undefined || item[attr] === null;
      }
      return true;
    }
    const cmp = rest.match(/^([#A-Za-z0-9_]+)\s*(<>|=|<=|<|>=|>)\s*(:[A-Za-z0-9_]+)/);
    if (!cmp) {
      throw new Error(`unparsed condition: ${rest}`);
    }
    i += cmp[0].length;
    const left = item[resolveAttrName(cmp[1], names)];
    const right = values[cmp[3]];
    if (cmp[2] === "=") return left === right;
    if (cmp[2] === "<>") return left !== right;
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

function splitUpdateParts(value) {
  const parts = [];
  let buf = "";
  let depth = 0;
  for (const ch of String(value || "")) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function applyUpdateExpression(item, updateExpression, names, values) {
  const next = { ...item };
  const expr = String(updateExpression || "");
  const removeMatch = expr.match(/REMOVE\s+(.+?)(?=\s+SET\b|$)/i);
  const setMatch = expr.match(/SET\s+(.+?)(?=\s+REMOVE\b|$)/i);
  if (removeMatch) {
    for (const part of splitUpdateParts(removeMatch[1])) {
      delete next[resolveAttrName(part, names)];
    }
  }
  if (!setMatch) return next;
  for (const part of splitUpdateParts(setMatch[1])) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const rawLeft = part.slice(0, eq).trim();
    const rawRight = part.slice(eq + 1).trim();
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
      if (command instanceof TransactWriteCommand) {
        const ops = command.input.TransactItems || [];
        for (const op of ops) {
          if (op.ConditionCheck) {
            const { TableName, Key, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues } =
              op.ConditionCheck;
            const found = items.find(
              (row) =>
                row.TableName === TableName &&
                row.Item.PK === Key.PK &&
                row.Item.SK === Key.SK
            );
            if (
              !evalCondition(
                found ? found.Item : {},
                ConditionExpression,
                ExpressionAttributeNames || {},
                ExpressionAttributeValues || {}
              )
            ) {
              const err = new Error("Transaction cancelled");
              err.name = "TransactionCanceledException";
              err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
              throw err;
            }
          }
          if (op.Put && op.Put.ConditionExpression) {
            const found = items.find(
              (row) =>
                row.TableName === op.Put.TableName &&
                row.Item.PK === op.Put.Item.PK &&
                row.Item.SK === op.Put.Item.SK
            );
            if (
              !evalCondition(
                found ? found.Item : {},
                op.Put.ConditionExpression,
                op.Put.ExpressionAttributeNames || {},
                op.Put.ExpressionAttributeValues || {}
              )
            ) {
              const err = new Error("Transaction cancelled");
              err.name = "TransactionCanceledException";
              err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
              throw err;
            }
          }
        }
        for (const op of ops) {
          if (op.Put) this.seed(op.Put.TableName, op.Put.Item);
        }
        return {};
      }
      if (command instanceof ScanCommand) {
        const { TableName } = command.input;
        const found = items
          .filter((row) => row.TableName === TableName)
          .map((row) => ({ ...row.Item }));
        return { Items: found };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function s3NotFound() {
  const err = new Error("NoSuchKey");
  err.name = "NoSuchKey";
  err.$metadata = { httpStatusCode: 404 };
  throw err;
}

function decodeCopySourceKey(copySource, bucket) {
  const decoded = String(copySource || "")
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  if (decoded[0] === bucket) return decoded.slice(1).join("/");
  return decoded.join("/");
}

function createMemoryS3(objects = {}, { failCopyTo, failDelete } = {}) {
  const failTo = failCopyTo instanceof Set ? failCopyTo : new Set(failCopyTo ? [failCopyTo] : []);
  const failDeleteTo =
    failDelete instanceof Set ? failDelete : new Set(failDelete ? [failDelete] : []);
  return {
    objects,
    copies: [],
    deletes: [],
    async send(command) {
      if (command instanceof GetObjectCommand) {
        const key = command.input.Key;
        const body = objects[key];
        if (!body) s3NotFound();
        return { Body: body };
      }
      if (command instanceof HeadObjectCommand) {
        const key = command.input.Key;
        if (!objects[key]) s3NotFound();
        return { ContentLength: 1 };
      }
      if (command instanceof CopyObjectCommand) {
        const toKey = command.input.Key;
        const fromKey = decodeCopySourceKey(command.input.CopySource, command.input.Bucket);
        this.copies.push({ fromKey, toKey });
        if (
          failTo.has(toKey) ||
          [...failTo].some((prefix) => String(toKey).startsWith(prefix))
        ) {
          const err = new Error("Copy failed");
          err.name = "InternalError";
          throw err;
        }
        const body = objects[fromKey];
        if (!body) s3NotFound();
        objects[toKey] = body;
        return {};
      }
      if (command instanceof DeleteObjectCommand) {
        const key = command.input.Key;
        this.deletes.push(key);
        if (
          failDeleteTo.has(key) ||
          [...failDeleteTo].some((prefix) => String(key).startsWith(prefix))
        ) {
          const err = new Error("Delete failed");
          err.name = "InternalError";
          throw err;
        }
        delete objects[key];
        return {};
      }
      throw new Error(`unexpected s3 command ${command.constructor.name}`);
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
    { email: "oldsuper@mydgv.com", status: "BLOCKED", role: "SUPER_ADMIN" },
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

function readyEnv({ rows, extraProjects, metaOverrides, s3Options } = {}) {
  const ddb = createMemoryDdb();
  seedProjects(ddb, extraProjects);
  seedAccess(ddb);
  const sheetRows = rows || [TASK_IMPORT_COLUMNS, VALID_ROW];
  const meta = seedMeta(ddb, {
    totalRows: Math.max(0, sheetRows.length - 1),
    ...metaOverrides,
  });
  const s3 = createMemoryS3(
    {
      [meta.s3Key]: workbookBuffer({ rows: sheetRows }),
    },
    s3Options
  );
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

function attendanceEnv() {
  const ddb = createMemoryDdb();
  seedProjects(ddb);
  seedAccess(ddb);
  return { ddb };
}

function seedScheduledTask(ddb, extra = {}) {
  const start = extra.startDate || "2026-09-22T14:00:00+05:30";
  const due = extra.dueDate || "2026-09-22T14:30:00+05:30";
  const taskId = extra.taskId || `sched-att-${Math.random().toString(16).slice(2, 10)}`;
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
    taskId,
    projectId: PORTAL_ID,
    title: extra.title || "Attendance scheduled task",
    startDate: start,
    dueDate: due,
    scheduledAssignAt: extra.scheduledAssignAt || start,
    assignmentMode: "SCHEDULED",
    assignmentState: extra.assignmentState || ASSIGNMENT_PENDING,
    pendingAssignees: extra.pendingAssignees || ["priya@mydgv.com"],
    assignees: extra.assignees || [],
    assignments: extra.assignments || [],
    status: "TODO",
    createdBy: ADMIN.email,
    createdByName: "admin",
    ...extra,
  };
  item.SK = `TASK#${item.taskId}`;
  ddb.seed(WORK_TABLE, item);
  if (item.projectId) {
    ddb.seed(WORK_TABLE, {
      ...item,
      PK: `PROJECT#${item.projectId}`,
      SK: `TASK#${item.taskId}`,
    });
  }
  return item;
}

function seedAttendance(ddb, email, date, extra = {}) {
  ddb.seed(ATTENDANCE_TABLE, {
    PK: email,
    SK: date,
    email,
    date,
    ...extra,
  });
}

function trackAttendanceWrites(ddb) {
  let writes = 0;
  const orig = ddb.send.bind(ddb);
  ddb.send = async (command) => {
    if (
      command.input?.TableName === ATTENDANCE_TABLE &&
      !(command instanceof GetCommand)
    ) {
      writes += 1;
    }
    return orig(command);
  };
  return () => writes;
}

async function runAssign(ddb, nowMs) {
  return assignDueScheduledTasks({
    ddb,
    tableName: WORK_TABLE,
    accessTable: ACCESS_TABLE,
    attendanceTable: ATTENDANCE_TABLE,
    nowMs,
  });
}

function durationMs(task) {
  return Date.parse(task.dueDate) - Date.parse(task.startDate);
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
    assert.strictEqual(meta.status, "COMPLETED");
    assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const auditKey = buildAuditS3Key(ADMIN.email, BATCH_ID);
    assert.strictEqual(meta.s3Key, auditKey);
    assert.ok(env.s3.objects[auditKey], "mixed COMPLETED batch must retain the original in audit storage");
    assert.ok(
      env.s3.copies.some((item) => item.toKey === auditKey),
      "mixed COMPLETED batch must copy the original to the audit prefix"
    );
    assert.ok(!env.s3.objects[buildS3Key(ADMIN.email, BATCH_ID)]);
    assert.strictEqual(createdScheduled.assignmentState, ASSIGNMENT_PENDING);
    const summaries = summaryEmails();
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0].to, "super@mydgv.com");
    assert.ok(!summaries.some((call) => call.to === "admin@mydgv.com"));
    assert.ok(!summaries.some((call) => call.to === "oldsuper@mydgv.com"));
    assert.ok(!summaries.some((call) => call.to === "anita@mydgv.com"));
    assert.strictEqual(summaries[0].from, "noreply@mydgv.com");
    assert.ok(/Total tasks: 2/.test(summaries[0].text));
    assert.ok(/Immediate tasks: 1/.test(summaries[0].text));
    assert.ok(/Scheduled tasks: 1/.test(summaries[0].text));
    assert.ok(/Processing status: COMPLETED/.test(summaries[0].text));
    assert.ok(/bulk-tasks\.xlsx/.test(summaries[0].text));
    assert.ok(!/Homepage banner update/.test(summaries[0].text));
    assert.ok(!/Leave calendar/.test(summaries[0].text));
    assert.ok(!summaries[0].html.includes("<script"));
    assert.ok(summaries[0].html.includes("login.mydgv.com/admin/task-imports/"));
    assert.strictEqual(meta.summaryEmailStatus, "SENT");
    const assignedMail = assignmentEmails();
    assert.ok(assignedMail.some((call) => call.to === "rahul@mydgv.com"));
    assert.ok(assignedMail.some((call) => call.to === "super@mydgv.com"));
    assert.ok(!assignedMail.some((call) => /Scheduled task assigned/i.test(call.subject)));
    assert.ok(!assignedMail.some((call) => call.to === "priya@mydgv.com"));
  });

  await test("invalid batch cannot confirm", async () => {
    emailCalls.length = 0;
    const env = readyEnv();
    seedMeta(env.ddb, { status: "NEEDS_FIX", invalidRows: 1, validRows: 0 });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(result.body.status, "NEEDS_FIX");
    assert.strictEqual(entityTasks(env.ddb).length, 0);
    assert.strictEqual(summaryEmails().length, 0);
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
    emailCalls.length = 0;
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
    assert.strictEqual(summaryEmails().length, 1);
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
    assert.ok(
      notifyItems(env.ddb).some(
        (item) => item.email === "super@mydgv.com" && item.type === "TASK_ASSIGNED"
      )
    );
    assert.ok(
      !notifyItems(env.ddb).some((item) => item.email === "admin@mydgv.com")
    );
    assert.ok(
      !notifyItems(env.ddb).some((item) => item.email === "anita@mydgv.com")
    );
    assert.ok(
      !notifyItems(env.ddb).some((item) => item.email === "oldsuper@mydgv.com")
    );
    const assignedMail = assignmentEmails();
    assert.strictEqual(assignedMail.length, 2);
    assert.ok(assignedMail.some((call) => call.to === "rahul@mydgv.com"));
    assert.ok(assignedMail.some((call) => call.to === "super@mydgv.com"));
    assert.ok(assignedMail.every((call) => call.from === "noreply@mydgv.com"));
    assert.ok(!assignedMail.some((call) => call.to === "admin@mydgv.com"));
    const summaries = summaryEmails();
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0].to, "super@mydgv.com");
    assert.strictEqual(summaries[0].from, "noreply@mydgv.com");
    assert.ok(/Immediate tasks: 1/.test(summaries[0].text));
    assert.ok(/Scheduled tasks: 0/.test(summaries[0].text));
    assert.ok(!/Homepage banner update/.test(summaries[0].text));
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
    assert.strictEqual(assignmentEmails().length, 0);
    const early = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      accessTable: ACCESS_TABLE,
      nowMs: NOW_MS,
    });
    assert.strictEqual(early.processed, 0);
    assert.strictEqual(assignmentItems(env.ddb, taskId).length, 0);
    assert.strictEqual(assignmentEmails().length, 0);
    const late = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      accessTable: ACCESS_TABLE,
      nowMs: SCHEDULED_DUE_MS + 5 * 60 * 1000,
    });
    assert.strictEqual(late.processed, 1);
    assert.strictEqual(assignmentItems(env.ddb, taskId).length, 1);
    assert.strictEqual(assignmentItems(env.ddb, taskId)[0].assignedBy, ADMIN.email);
    const assigned = entityTasks(env.ddb)[0];
    assert.strictEqual(assigned.assignmentState, "ASSIGNED");
    assert.ok(!isPendingScheduledTask(assigned));
    assert.ok(
      notifyItems(env.ddb).some(
        (item) => item.email === "priya@mydgv.com" && item.type === "TASK_ASSIGNED"
      )
    );
    assert.ok(
      notifyItems(env.ddb).some(
        (item) => item.email === "super@mydgv.com" && item.type === "TASK_ASSIGNED"
      )
    );
    const assignedMail = assignmentEmails();
    assert.strictEqual(assignedMail.length, 2);
    assert.ok(assignedMail.some((call) => call.to === "priya@mydgv.com"));
    assert.ok(assignedMail.some((call) => call.to === "super@mydgv.com"));
    assert.ok(assignedMail.some((call) => /Scheduled task assigned/i.test(call.subject)));
    assert.ok(assignedMail.every((call) => call.from === "noreply@mydgv.com"));
    const summaries = summaryEmails();
    assert.strictEqual(summaries.length, 1);
    assert.ok(/Immediate tasks: 0/.test(summaries[0].text));
    assert.ok(/Scheduled tasks: 1/.test(summaries[0].text));
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
    assert.strictEqual(assignmentEmails().length, 2);
    assert.strictEqual(summaryEmails().length, 1);
  });

  await test("task persist conflict does not mark the row imported", async () => {
    emailCalls.length = 0;
    const env = readyEnv();
    const orig = env.ddb.send.bind(env.ddb);
    env.ddb.send = async (command) => {
      if (isEntityTaskWrite(command) && entityTaskWriteHasCondition(command)) {
        failConditional();
      }
      return orig(command);
    };
    const result = await confirm(env);
    assert.notStrictEqual(result.body.status, "COMPLETED");
    assert.ok(result.body.failureCount >= 1);
    assert.ok(
      String(result.body.failures?.[0]?.message || "").includes("could not be saved")
    );
    assert.strictEqual(entityTasks(env.ddb).length, 0);
    const row = rowItems(env.ddb).find((item) => item.rowNumber === 2);
    assert.notStrictEqual(row?.status, ROW_IMPORTED);
    assert.strictEqual(summaryEmails().length, 0);
  });

  await test("unexpected row creation failure records PARTIAL or FAILED", async () => {
    emailCalls.length = 0;
    const env = readyEnv({
      rows: [TASK_IMPORT_COLUMNS, VALID_ROW, SCHEDULED_ROW],
    });
    const orig = env.ddb.send.bind(env.ddb);
    let taskPuts = 0;
    env.ddb.send = async (command) => {
      if (isEntityTaskWrite(command)) {
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
    assert.strictEqual(summaryEmails().length, 0);
    assert.ok(!meta.summaryEmailStatus);
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
      if (isEntityTaskWrite(command)) {
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
    emailCalls.length = 0;
    const env = readyEnv();
    const orig = env.ddb.send.bind(env.ddb);
    env.ddb.send = async (command) => {
      if (isEntityTaskWrite(command)) {
        throw new Error("simulated dynamo failure");
      }
      return orig(command);
    };
    const first = await confirm(env);
    assert.strictEqual(first.body.status, "FAILED");
    assert.strictEqual(summaryEmails().length, 0);
    env.ddb.send = orig;
    const second = await confirm(env);
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(second.body.status, "COMPLETED");
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    assert.strictEqual(metaItem(env.ddb).processingStartedAt, undefined);
    assert.strictEqual(summaryEmails().length, 1);
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
      2
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
    assert.strictEqual(notifyCount, 2);
    const second = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(second.processed, 0);
    assert.strictEqual(
      notifyItems(env.ddb).filter((item) => item.type === "TASK_ASSIGNED").length,
      2
    );
    assert.strictEqual(assignmentItems(env.ddb, task.taskId).length, 1);
    assert.strictEqual(assignmentEmails().length, 2);
    assert.strictEqual(summaryEmails().length, 1);
  });

  await test("scheduled persist conflict remains recoverable", async () => {
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    const dueMs = SCHEDULED_DUE_MS + 5 * 60 * 1000;
    const orig = env.ddb.send.bind(env.ddb);
    env.ddb.send = async (command) => {
      if (
        command instanceof PutCommand &&
        command.input.Item?.PK &&
        String(command.input.Item.SK || "").startsWith("ASSIGNMENT#") &&
        command.input.ConditionExpression
      ) {
        failConditional();
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
    assert.strictEqual(assignmentItems(env.ddb, afterFail.taskId).length, 0);
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
    assert.strictEqual(assignmentItems(env.ddb, afterFail.taskId)[0].assignedBy, ADMIN.email);
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

  await test("immediate-only COMPLETED batch becomes ELIGIBLE with one audit copy", async () => {
    const env = readyEnv();
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "COMPLETED");
    assert.strictEqual(result.body.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const meta = metaItem(env.ddb);
    assert.strictEqual(meta.status, "COMPLETED");
    assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const auditKey = buildAuditS3Key(ADMIN.email, BATCH_ID);
    assert.strictEqual(meta.s3Key, auditKey);
    assert.ok(env.s3.objects[auditKey]);
    assert.strictEqual(
      env.s3.copies.filter((item) => item.toKey === auditKey).length,
      1
    );
    assert.ok(!env.s3.objects[buildS3Key(ADMIN.email, BATCH_ID)]);
  });

  await test("scheduled-only COMPLETED PENDING batch becomes ELIGIBLE immediately", async () => {
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    const result = await confirm(env);
    assert.strictEqual(result.body.status, "COMPLETED");
    assert.strictEqual(result.body.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const meta = metaItem(env.ddb);
    assert.strictEqual(meta.status, "COMPLETED");
    assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const auditKey = buildAuditS3Key(ADMIN.email, BATCH_ID);
    assert.strictEqual(meta.s3Key, auditKey);
    assert.ok(env.s3.objects[auditKey]);
    assert.ok(!env.s3.objects[buildHoldS3Key(ADMIN.email, BATCH_ID)]);
    const task = entityTasks(env.ddb)[0];
    assert.strictEqual(task.assignmentState, ASSIGNMENT_PENDING);
  });

  await test("duplicate promotion does not create a second audit copy", async () => {
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    const auditKey = buildAuditS3Key(ADMIN.email, BATCH_ID);
    assert.strictEqual(metaItem(env.ddb).auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const firstCopies = env.s3.copies.filter((item) => item.toKey === auditKey).length;
    const first = await promoteWaitingImportAudits({
      ddb: env.ddb,
      s3: env.s3,
      tableName: WORK_TABLE,
      bucket: BUCKET,
      now: NOW,
      nowMs: NOW_MS,
    });
    assert.strictEqual(first.processed, 0);
    const second = await promoteWaitingImportAudits({
      ddb: env.ddb,
      s3: env.s3,
      tableName: WORK_TABLE,
      bucket: BUCKET,
      now: NOW,
      nowMs: NOW_MS,
    });
    assert.strictEqual(second.processed, 0);
    assert.strictEqual(
      env.s3.copies.filter((item) => item.toKey === auditKey).length,
      firstCopies
    );
    assert.ok(env.s3.objects[auditKey]);
  });

  await test("COMPLETED confirmation returns 200 when audit promotion throws", async () => {
    const env = readyEnv();
    const orig = env.ddb.send.bind(env.ddb);
    env.ddb.send = async (command) => {
      if (
        command instanceof UpdateCommand &&
        command.input.ExpressionAttributeValues?.[":eligible"] ===
          AUDIT_ELIGIBILITY.ELIGIBLE
      ) {
        throw new Error("simulated audit eligibility update failure");
      }
      return orig(command);
    };
    const logs = [];
    const origError = console.error;
    console.error = (...args) => {
      logs.push(args.map((item) => String(item)).join(" "));
    };
    let result;
    try {
      result = await confirm(env);
    } finally {
      console.error = origError;
    }
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "COMPLETED");
    assert.notStrictEqual(result.body.status, "FAILED");
    assert.strictEqual(metaItem(env.ddb).status, "COMPLETED");
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    assert.ok(
      logs.some((line) => line.includes("TASK_IMPORT_AUDIT_PROMOTE_ERROR"))
    );
    assert.ok(
      logs.some((line) => line.includes("simulated audit eligibility update failure"))
    );
    assert.ok(
      env.ddb.of(WORK_TABLE).some((item) => item.PK === WAIT_PK),
      "audit failure must remain retryable via WAIT_PK"
    );
  });

  await test("temporary audit copy failure keeps COMPLETED and remains retryable", async () => {
    const env = readyEnv({
      s3Options: { failCopyTo: "task-imports/audit/" },
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "COMPLETED");
    const meta = metaItem(env.ddb);
    assert.strictEqual(meta.status, "COMPLETED");
    assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.WAITING_DISTRIBUTION);
    assert.ok(!env.s3.objects[buildAuditS3Key(ADMIN.email, BATCH_ID)]);
    const tmpKey = buildS3Key(ADMIN.email, BATCH_ID);
    const holdKey = buildHoldS3Key(ADMIN.email, BATCH_ID);
    assert.ok(env.s3.objects[meta.s3Key]);
    assert.ok(meta.s3Key === tmpKey || meta.s3Key === holdKey);
    assert.ok(env.ddb.of(WORK_TABLE).some((item) => item.PK === WAIT_PK));
  });

  await test("DeleteObject failure after verified audit copy does not fail confirmation", async () => {
    const tmpKey = buildS3Key(ADMIN.email, BATCH_ID);
    const env = readyEnv({
      s3Options: { failDelete: "task-imports/tmp/" },
    });
    const result = await confirm(env);
    const auditKey = buildAuditS3Key(ADMIN.email, BATCH_ID);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "COMPLETED");
    assert.strictEqual(result.body.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const meta = metaItem(env.ddb);
    assert.strictEqual(meta.status, "COMPLETED");
    assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    assert.ok(env.s3.objects[auditKey], "verified audit object must remain");
    assert.ok(env.s3.objects[tmpKey], "failed tmp cleanup must not delete the audit copy");
    assert.ok(!env.s3.deletes.includes(auditKey));
  });

  await test("scheduled assignment failure does not change COMPLETED audit eligibility", async () => {
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    assert.strictEqual(metaItem(env.ddb).auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
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
    await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(entityTasks(env.ddb)[0].assignmentState, ASSIGNMENT_ASSIGNING);
    assert.strictEqual(metaItem(env.ddb).status, "COMPLETED");
    assert.strictEqual(metaItem(env.ddb).auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    assert.ok(env.s3.objects[buildAuditS3Key(ADMIN.email, BATCH_ID)]);
  });

  await test("no active Super Admin does not roll back completed import", async () => {
    emailCalls.length = 0;
    const env = readyEnv();
    const result = await confirm(env, {
      listAccessRows: async () => [
        { email: "admin@mydgv.com", status: "ACTIVE", role: "ADMIN" },
        { email: "anita@mydgv.com", status: "ACTIVE", role: "MANAGER" },
        { email: "oldsuper@mydgv.com", status: "BLOCKED", role: "SUPER_ADMIN" },
      ],
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.status, "COMPLETED");
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    assert.strictEqual(metaItem(env.ddb).status, "COMPLETED");
    assert.strictEqual(metaItem(env.ddb).summaryEmailStatus, "SKIPPED");
    assert.strictEqual(summaryEmails().length, 0);
  });

  await test("summary email delivery failure does not change COMPLETED status", async () => {
    emailCalls.length = 0;
    const origMail = email.sendEmail;
    email.sendEmail = async (payload) => {
      emailCalls.push(payload);
      return { ok: false, error: "MessageRejected" };
    };
    try {
      const env = readyEnv();
      const result = await confirm(env);
      assert.strictEqual(result.statusCode, 200);
      assert.strictEqual(result.body.status, "COMPLETED");
      assert.strictEqual(metaItem(env.ddb).status, "COMPLETED");
      assert.strictEqual(metaItem(env.ddb).summaryEmailStatus, "FAILED");
      assert.strictEqual(entityTasks(env.ddb).length, 1);
      assert.strictEqual(summaryEmails().length, 1);
      assert.ok(
        notifyItems(env.ddb).some(
          (item) => item.email === "rahul@mydgv.com" && item.type === "TASK_ASSIGNED"
        )
      );
    } finally {
      email.sendEmail = origMail;
    }
  });

  await test("dynamic filename and uploader values are escaped in summary email", async () => {
    emailCalls.length = 0;
    const env = readyEnv({
      metaOverrides: {
        fileName: `<script>alert(1)</script> & tasks.xlsx`,
        uploadedByName: `Admin "Boss" <evil@x.com>`,
      },
    });
    const result = await confirm(env);
    assert.strictEqual(result.statusCode, 200);
    const mail = summaryEmails()[0];
    assert.ok(mail);
    assert.ok(!mail.subject.includes("<script>"));
    assert.ok(!mail.html.includes("<script>"));
    assert.ok(mail.html.includes("&lt;"));
    assert.ok(mail.html.includes("&quot;") || mail.html.includes("&amp;"));
    assert.ok(!mail.html.includes("<evil@x.com>"));
    assert.ok(/Processing status: COMPLETED/.test(mail.text));
  });

  await test("assignment email failure does not roll back immediate task", async () => {
    emailCalls.length = 0;
    const origMail = email.sendEmail;
    email.sendEmail = async (payload) => {
      emailCalls.push(payload);
      if (/Excel Task Import Completed/i.test(payload.subject)) {
        return { ok: true, messageId: "test-ses" };
      }
      return { ok: false, error: "MessageRejected" };
    };
    try {
      const env = readyEnv();
      const result = await confirm(env);
      assert.strictEqual(result.statusCode, 200);
      assert.strictEqual(result.body.status, "COMPLETED");
      assert.strictEqual(entityTasks(env.ddb).length, 1);
      assert.ok(
        notifyItems(env.ddb).some(
          (item) => item.email === "rahul@mydgv.com" && item.type === "TASK_ASSIGNED"
        )
      );
      assert.ok(assignmentEmails().length >= 1);
    } finally {
      email.sendEmail = origMail;
    }
  });

  await test("existing-task reuse does not duplicate assignment notifications", async () => {
    emailCalls.length = 0;
    const env = readyEnv();
    const taskId = importedTaskId(BATCH_ID, 2);
    env.ddb.seed(WORK_TABLE, {
      PK: "ENTITY#TASK",
      SK: `TASK#${taskId}`,
      taskId,
      title: "Homepage banner update",
      assignmentMode: "IMMEDIATE",
      assignmentState: "ASSIGNED",
      createdBy: ADMIN.email,
      createdByName: "admin",
      importBatchId: BATCH_ID,
    });
    seedMeta(env.ddb, {
      status: "FAILED",
      failureCount: 1,
      successCount: 0,
    });
    const first = await confirm(env);
    assert.strictEqual(first.statusCode, 200);
    const notifyCount = notifyItems(env.ddb).filter((item) => item.type === "TASK_ASSIGNED").length;
    const mailCount = assignmentEmails().length;
    assert.ok(notifyCount >= 2);
    assert.ok(mailCount >= 2);
    const second = await confirm(env);
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(entityTasks(env.ddb).length, 1);
    assert.strictEqual(first.body.tasks[0].taskId, second.body.tasks[0].taskId);
    assert.strictEqual(
      notifyItems(env.ddb).filter((item) => item.type === "TASK_ASSIGNED").length,
      notifyCount
    );
    assert.strictEqual(assignmentEmails().length, mailCount);
  });

  await test("inactive scheduled employee is skipped without reassignment", async () => {
    emailCalls.length = 0;
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    env.ddb.seed(ACCESS_TABLE, {
      PK: "priya@mydgv.com",
      SK: "priya@mydgv.com",
      email: "priya@mydgv.com",
      status: "BLOCKED",
      role: "EMPLOYEE",
    });
    emailCalls.length = 0;
    const dueMs = SCHEDULED_DUE_MS + 5 * 60 * 1000;
    const result = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      accessTable: ACCESS_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(result.processed, 1);
    const task = entityTasks(env.ddb)[0];
    assert.strictEqual(task.assignmentState, ASSIGNMENT_SKIPPED);
    assert.strictEqual(task.assignmentSkipReason, "EMPLOYEE_INACTIVE");
    assert.deepStrictEqual(task.assignmentSkippedEmails, ["priya@mydgv.com"]);
    assert.deepStrictEqual(task.pendingAssignees, ["priya@mydgv.com"]);
    assert.strictEqual(assignmentItems(env.ddb, task.taskId).length, 0);
    assert.ok(!task.assignees || task.assignees.length === 0);
    assert.strictEqual(notifyItems(env.ddb).length, 0);
    assert.strictEqual(assignmentEmails().length, 0);
    const again = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      accessTable: ACCESS_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(again.processed, 0);
    assert.strictEqual(entityTasks(env.ddb)[0].assignmentState, ASSIGNMENT_SKIPPED);
  });

  await test("missing UserAccess record skips scheduled assignment", async () => {
    emailCalls.length = 0;
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    await env.ddb.send(
      new DeleteCommand({
        TableName: ACCESS_TABLE,
        Key: { PK: "priya@mydgv.com", SK: "priya@mydgv.com" },
      })
    );
    emailCalls.length = 0;
    const dueMs = SCHEDULED_DUE_MS + 5 * 60 * 1000;
    const result = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      accessTable: ACCESS_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(result.processed, 1);
    const task = entityTasks(env.ddb)[0];
    assert.strictEqual(task.assignmentState, ASSIGNMENT_SKIPPED);
    assert.strictEqual(task.assignmentSkipReason, "EMPLOYEE_INACTIVE");
    assert.strictEqual(assignmentItems(env.ddb, task.taskId).length, 0);
    assert.strictEqual(assignmentEmails().length, 0);
    assert.strictEqual(notifyItems(env.ddb).length, 0);
  });

  await test("UserAccess lookup error leaves scheduled assignment recoverable", async () => {
    emailCalls.length = 0;
    const env = readyEnv({ rows: [TASK_IMPORT_COLUMNS, SCHEDULED_ROW] });
    await confirm(env);
    const dueMs = SCHEDULED_DUE_MS + 5 * 60 * 1000;
    const orig = env.ddb.send.bind(env.ddb);
    env.ddb.send = async (command) => {
      if (command instanceof GetCommand && command.input.TableName === ACCESS_TABLE) {
        const err = new Error("ProvisionedThroughputExceeded");
        err.name = "ProvisionedThroughputExceededException";
        throw err;
      }
      return orig(command);
    };
    const failed = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      accessTable: ACCESS_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(failed.processed, 0);
    const afterFail = entityTasks(env.ddb)[0];
    assert.strictEqual(afterFail.assignmentState, ASSIGNMENT_ASSIGNING);
    assert.notStrictEqual(afterFail.assignmentState, ASSIGNMENT_SKIPPED);
    assert.ok(!afterFail.assignmentSkipReason);
    assert.strictEqual(assignmentItems(env.ddb, afterFail.taskId).length, 0);
    assert.strictEqual(assignmentEmails().length, 0);
    env.ddb.send = orig;
    env.ddb.seed(WORK_TABLE, {
      ...afterFail,
      assigningStartedAt: new Date(dueMs - 5 * 60 * 1000).toISOString(),
    });
    const recovered = await assignDueScheduledTasks({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      accessTable: ACCESS_TABLE,
      nowMs: dueMs,
    });
    assert.strictEqual(recovered.processed, 1);
    assert.strictEqual(entityTasks(env.ddb)[0].assignmentState, ASSIGNMENT_ASSIGNED);
    assert.strictEqual(assignmentItems(env.ddb, afterFail.taskId).length, 1);
    assert.ok(assignmentEmails().length >= 1);
  });

  await test("missing attendance assigns scheduled task and does not write Attendance", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb);
    const writes = trackAttendanceWrites(env.ddb);
    const nowMs = Date.parse("2026-09-22T14:05:00+05:30");
    const result = await runAssign(env.ddb, nowMs);
    assert.strictEqual(result.processed, 1);
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.assignmentState, ASSIGNMENT_ASSIGNED);
    assert.strictEqual(assignmentItems(env.ddb, created.taskId).length, 1);
    assert.strictEqual(writes(), 0);
    assert.ok(assignmentEmails().some((call) => call.to === "priya@mydgv.com"));
    assert.strictEqual(postponeEmails().length, 0);
  });

  await test("Working Full Day inside window assigns", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb);
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", {
      status: "Working",
      dayType: "Full Day",
      shift: "Morning Shift",
    });
    await runAssign(env.ddb, Date.parse("2026-09-22T14:05:00+05:30"));
    assert.strictEqual(
      entityTasks(env.ddb).find((item) => item.taskId === created.taskId).assignmentState,
      ASSIGNMENT_ASSIGNED
    );
  });

  await test("Working Half Day inside window assigns", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb);
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", {
      status: "Working",
      dayType: "Half Day",
      shift: "Morning Shift",
    });
    await runAssign(env.ddb, Date.parse("2026-09-22T14:05:00+05:30"));
    assert.strictEqual(
      entityTasks(env.ddb).find((item) => item.taskId === created.taskId).assignmentState,
      ASSIGNMENT_ASSIGNED
    );
  });

  await test("Working task starting before shift postpones", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      startDate: "2026-09-22T10:30:00+05:30",
      dueDate: "2026-09-22T11:00:00+05:30",
      scheduledAssignAt: "2026-09-22T10:30:00+05:30",
    });
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", {
      status: "Working",
      dayType: "Half Day",
      shift: "Morning Shift",
    });
    await runAssign(env.ddb, Date.parse("2026-09-22T10:35:00+05:30"));
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.assignmentState, ASSIGNMENT_PENDING);
    assert.strictEqual(task.lastPostponementReason, "OUTSIDE_SHIFT");
    assert.strictEqual(assignmentItems(env.ddb, created.taskId).length, 0);
  });

  await test("Working task ending after shift postpones", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      startDate: "2026-09-22T15:00:00+05:30",
      dueDate: "2026-09-22T16:00:00+05:30",
      scheduledAssignAt: "2026-09-22T15:00:00+05:30",
    });
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", {
      status: "Working",
      dayType: "Half Day",
      shift: "Morning Shift",
    });
    await runAssign(env.ddb, Date.parse("2026-09-22T15:05:00+05:30"));
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.assignmentState, ASSIGNMENT_PENDING);
    assert.strictEqual(task.lastPostponementReason, "OUTSIDE_SHIFT");
  });

  await test("Working task starts inside but ends after shift postpones", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      startDate: "2026-09-22T15:15:00+05:30",
      dueDate: "2026-09-22T15:45:00+05:30",
      scheduledAssignAt: "2026-09-22T15:15:00+05:30",
    });
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", {
      status: "Working",
      dayType: "Half Day",
      shift: "Morning Shift",
    });
    await runAssign(env.ddb, Date.parse("2026-09-22T15:20:00+05:30"));
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.assignmentState, ASSIGNMENT_PENDING);
    assert.strictEqual(task.lastPostponementReason, "OUTSIDE_SHIFT");
  });

  await test("task starting at shift end with duration postpones", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      startDate: "2026-09-22T15:30:00+05:30",
      dueDate: "2026-09-22T16:00:00+05:30",
      scheduledAssignAt: "2026-09-22T15:30:00+05:30",
    });
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", {
      status: "Working",
      dayType: "Half Day",
      shift: "Morning Shift",
    });
    await runAssign(env.ddb, Date.parse("2026-09-22T15:31:00+05:30"));
    assert.strictEqual(
      entityTasks(env.ddb).find((item) => item.taskId === created.taskId)
        .assignmentState,
      ASSIGNMENT_PENDING
    );
  });

  await test("task finishing exactly at shift end assigns", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      startDate: "2026-09-22T14:00:00+05:30",
      dueDate: "2026-09-22T15:30:00+05:30",
      scheduledAssignAt: "2026-09-22T14:00:00+05:30",
    });
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", {
      status: "Working",
      dayType: "Half Day",
      shift: "Morning Shift",
    });
    await runAssign(env.ddb, Date.parse("2026-09-22T14:05:00+05:30"));
    assert.strictEqual(
      entityTasks(env.ddb).find((item) => item.taskId === created.taskId)
        .assignmentState,
      ASSIGNMENT_ASSIGNED
    );
  });

  for (const [status, reason] of [
    ["Leave", "LEAVE"],
    ["PlannedOff", "PLANNED_OFF"],
    ["Holiday", "HOLIDAY"],
    ["WeeklyOff", "WEEKLY_OFF"],
  ]) {
    await test(`${status} postpones scheduled assignment by 24h`, async () => {
      emailCalls.length = 0;
      const env = attendanceEnv();
      const created = seedScheduledTask(env.ddb);
      const originalDuration = durationMs(created);
      seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", { status });
      const nowMs = Date.parse("2026-09-22T14:05:00+05:30");
      await runAssign(env.ddb, nowMs);
      const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
      assert.strictEqual(task.assignmentState, ASSIGNMENT_PENDING);
      assert.strictEqual(assignmentItems(env.ddb, created.taskId).length, 0);
      assert.strictEqual(
        Date.parse(task.scheduledAssignAt) - Date.parse(created.scheduledAssignAt),
        24 * 60 * 60 * 1000
      );
      assert.strictEqual(
        Date.parse(task.startDate) - Date.parse(created.startDate),
        24 * 60 * 60 * 1000
      );
      assert.strictEqual(
        Date.parse(task.dueDate) - Date.parse(created.dueDate),
        24 * 60 * 60 * 1000
      );
      assert.strictEqual(durationMs(task), originalDuration);
      assert.strictEqual(task.originalStartDate, created.startDate);
      assert.strictEqual(task.originalDueDate, created.dueDate);
      assert.strictEqual(task.originalScheduledAssignAt, created.scheduledAssignAt);
      assert.strictEqual(task.postponementCount, 1);
      assert.strictEqual(task.lastPostponementReason, reason);
      assert.ok(isPendingScheduledTask(task));
      assert.strictEqual(postponeEmails().length, 1);
      assert.ok(postponeEmails().every((call) => call.to === "super@mydgv.com"));
      assert.ok(postponeEmails().every((call) => call.from === "noreply@mydgv.com"));
      assert.ok(!postponeEmails().some((call) => call.to === "priya@mydgv.com"));
      assert.ok(!postponeEmails().some((call) => call.to === "admin@mydgv.com"));
    });
  }

  await test("consecutive Leave postpones one day per cycle", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb);
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", { status: "Leave" });
    await runAssign(env.ddb, Date.parse("2026-09-22T14:05:00+05:30"));
    let task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.postponementCount, 1);
    const afterFirst = task.scheduledAssignAt;
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-23", { status: "Leave" });
    await runAssign(env.ddb, Date.parse("2026-09-23T14:05:00+05:30"));
    task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.postponementCount, 2);
    assert.strictEqual(
      Date.parse(task.scheduledAssignAt) - Date.parse(afterFirst),
      24 * 60 * 60 * 1000
    );
    assert.strictEqual(task.originalStartDate, created.startDate);
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-24", {
      status: "Working",
      dayType: "Half Day",
      shift: "Morning Shift",
    });
    await runAssign(env.ddb, Date.parse("2026-09-24T14:05:00+05:30"));
    task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.assignmentState, ASSIGNMENT_ASSIGNED);
    assert.strictEqual(assignmentItems(env.ddb, created.taskId).length, 1);
  });

  await test("late Leave after assignment does not change the task", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb);
    const nowMs = Date.parse("2026-09-22T14:05:00+05:30");
    await runAssign(env.ddb, nowMs);
    const assigned = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(assigned.assignmentState, ASSIGNMENT_ASSIGNED);
    const snapshot = { ...assigned };
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", { status: "Leave" });
    emailCalls.length = 0;
    await runAssign(env.ddb, Date.parse("2026-09-22T12:00:00.000Z"));
    const later = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(later.assignmentState, ASSIGNMENT_ASSIGNED);
    assert.strictEqual(later.startDate, snapshot.startDate);
    assert.strictEqual(later.dueDate, snapshot.dueDate);
    assert.strictEqual(later.scheduledAssignAt, snapshot.scheduledAssignAt);
    assert.strictEqual(assignmentItems(env.ddb, created.taskId).length, 1);
    assert.strictEqual(postponeEmails().length, 0);
  });

  await test("concurrent postponement updates only once", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb);
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", { status: "Leave" });
    const nowIso = new Date().toISOString();
    const nowMs = Date.parse("2026-09-22T14:05:00+05:30");
    const first = await postponeScheduledTask({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      task: created,
      nowIso,
      nowMs,
      postponedEmails: ["priya@mydgv.com"],
      reasons: ["LEAVE"],
      attendanceStatusByEmail: { "priya@mydgv.com": "Leave" },
      moveTaskDates: true,
    });
    const second = await postponeScheduledTask({
      ddb: env.ddb,
      tableName: WORK_TABLE,
      task: created,
      nowIso,
      nowMs,
      postponedEmails: ["priya@mydgv.com"],
      reasons: ["LEAVE"],
      attendanceStatusByEmail: { "priya@mydgv.com": "Leave" },
      moveTaskDates: true,
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.postponementCount, 1);
    assert.strictEqual(
      Date.parse(task.scheduledAssignAt) - Date.parse(created.scheduledAssignAt),
      24 * 60 * 60 * 1000
    );
  });

  await test("duplicate postponement email is prevented", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    seedScheduledTask(env.ddb);
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", { status: "Leave" });
    const nowMs = Date.parse("2026-09-22T14:05:00+05:30");
    await runAssign(env.ddb, nowMs);
    assert.strictEqual(postponeEmails().length, 1);
    await runAssign(env.ddb, nowMs);
    assert.strictEqual(postponeEmails().length, 1);
  });

  await test("multi-assignee assigns all when available", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      pendingAssignees: ["rahul@mydgv.com", "priya@mydgv.com"],
    });
    await runAssign(env.ddb, Date.parse("2026-09-22T14:05:00+05:30"));
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.assignmentState, ASSIGNMENT_ASSIGNED);
    assert.strictEqual(assignmentItems(env.ddb, created.taskId).length, 2);
  });

  await test("multi-assignee assigns available and keeps Leave employee pending", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      pendingAssignees: ["rahul@mydgv.com", "priya@mydgv.com"],
    });
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", { status: "Leave" });
    await runAssign(env.ddb, Date.parse("2026-09-22T14:05:00+05:30"));
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.assignmentState, ASSIGNMENT_ASSIGNED);
    const assigned = assignmentItems(env.ddb, created.taskId).map((item) => item.email).sort();
    assert.deepStrictEqual(assigned, ["rahul@mydgv.com"]);
    assert.deepStrictEqual(task.pendingAssignees, ["priya@mydgv.com"]);
    assert.strictEqual(
      Date.parse(task.startDate),
      Date.parse(created.startDate)
    );
    assert.ok(Date.parse(task.scheduledAssignAt) > Date.parse(created.scheduledAssignAt));
    assert.ok(assignmentEmails().some((call) => call.to === "rahul@mydgv.com"));
    assert.ok(postponeEmails().length >= 1);
  });

  await test("multi-assignee both Leave postpones nobody assigned", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      pendingAssignees: ["rahul@mydgv.com", "priya@mydgv.com"],
    });
    seedAttendance(env.ddb, "rahul@mydgv.com", "2026-09-22", { status: "Leave" });
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", { status: "Leave" });
    await runAssign(env.ddb, Date.parse("2026-09-22T14:05:00+05:30"));
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.assignmentState, ASSIGNMENT_PENDING);
    assert.strictEqual(assignmentItems(env.ddb, created.taskId).length, 0);
    assert.strictEqual(
      Date.parse(task.dueDate) - Date.parse(created.dueDate),
      24 * 60 * 60 * 1000
    );
  });

  await test("multi-assignee one outside shift remains pending", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      pendingAssignees: ["rahul@mydgv.com", "priya@mydgv.com"],
    });
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", {
      status: "Working",
      dayType: "Half Day",
      shift: "Morning Shift",
    });
    seedScheduledTask(env.ddb, {
      ...created,
      startDate: "2026-09-22T15:15:00+05:30",
      dueDate: "2026-09-22T15:45:00+05:30",
      scheduledAssignAt: "2026-09-22T15:15:00+05:30",
    });
    await runAssign(env.ddb, Date.parse("2026-09-22T15:20:00+05:30"));
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.assignmentState, ASSIGNMENT_ASSIGNED);
    assert.deepStrictEqual(
      assignmentItems(env.ddb, created.taskId).map((item) => item.email),
      ["rahul@mydgv.com"]
    );
    assert.deepStrictEqual(task.pendingAssignees, ["priya@mydgv.com"]);
  });

  await test("already assigned employee is never postponed", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      pendingAssignees: ["rahul@mydgv.com", "priya@mydgv.com"],
    });
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", { status: "Leave" });
    await runAssign(env.ddb, Date.parse("2026-09-22T14:05:00+05:30"));
    const assigned = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    const rahulStart = assigned.startDate;
    seedAttendance(env.ddb, "rahul@mydgv.com", "2026-09-22", { status: "Leave" });
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-23", { status: "Leave" });
    await runAssign(env.ddb, Date.parse("2026-09-23T14:05:00+05:30"));
    const later = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.ok(
      assignmentItems(env.ddb, created.taskId).some(
        (item) => item.email === "rahul@mydgv.com"
      )
    );
    assert.strictEqual(later.startDate, rahulStart);
    assert.ok(!later.pendingAssignees.includes("rahul@mydgv.com"));
  });

  await test("postponed PENDING task stays excluded from Orange/Red on the old deadline", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb);
    seedAttendance(env.ddb, "priya@mydgv.com", "2026-09-22", { status: "Leave" });
    await runAssign(env.ddb, Date.parse("2026-09-22T14:05:00+05:30"));
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    const laterMs = Date.parse("2026-09-23T14:00:00+05:30");
    const oldZone = escalation.zoneAt(Date.parse(created.dueDate), laterMs);
    const newZone = escalation.zoneAt(Date.parse(task.dueDate), laterMs);
    assert.ok(isPendingScheduledTask(task));
    assert.notStrictEqual(oldZone, "GREEN");
    assert.strictEqual(newZone, "GREEN");
    assert.notStrictEqual(task.dueDate, created.dueDate);
  });

  await test("after assignment current dueDate controls zones", async () => {
    emailCalls.length = 0;
    const env = attendanceEnv();
    const created = seedScheduledTask(env.ddb, {
      startDate: "2026-09-22T14:00:00+05:30",
      dueDate: "2026-09-22T14:30:00+05:30",
      scheduledAssignAt: "2026-09-22T14:00:00+05:30",
    });
    await runAssign(env.ddb, Date.parse("2026-09-22T14:05:00+05:30"));
    const task = entityTasks(env.ddb).find((item) => item.taskId === created.taskId);
    assert.strictEqual(task.assignmentState, ASSIGNMENT_ASSIGNED);
    assert.strictEqual(isPendingScheduledTask(task), false);
    const beforeDue = escalation.zoneAt(
      Date.parse(task.dueDate),
      Date.parse("2026-09-22T14:00:00+05:30")
    );
    const afterDue = escalation.zoneAt(
      Date.parse(task.dueDate),
      Date.parse("2026-09-22T14:31:00+05:30")
    );
    assert.strictEqual(beforeDue, "GREEN");
    assert.notStrictEqual(afterDue, "GREEN");
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

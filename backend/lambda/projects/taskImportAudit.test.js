const assert = require("assert");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  AUDIT_ELIGIBILITY,
  IMPORT_STATUSES,
  META_SK,
  WAIT_PK,
  buildAuditS3Key,
  buildHoldS3Key,
  buildImportMeta,
  buildS3Key,
  importPk,
  isTrustedImportKey,
  isManagedDeletableImportKey,
  parseImportS3Key,
} = require("./taskImport");
const {
  canDownloadAuditOriginal,
  evaluateBatchDistribution,
  promoteImportAudit,
  promoteWaitingImportAudits,
} = require("./taskImportAudit");
const {
  handleGetTaskImport,
  handleGetTaskImportDownloadUrl,
} = require("./taskImportHistory");

process.env.TASK_IMPORT_HOLD_RETENTION_DAYS = "90";

const TABLE = "work-table";
const ACCESS = "access-table";
const BUCKET = "docs-bucket";
process.env.USER_ACCESS_TABLE = ACCESS;
const NOW = "2026-09-15T09:40:00.000Z";
const NOW_MS = Date.parse(NOW);
const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };
const EMPLOYEE = { email: "rahul@mydgv.com", groups: ["Employee"], isAdmin: false };
const FILE = Buffer.from("xlsx-bytes");

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
    const cmp = rest.match(/^([#A-Za-z0-9_]+)\s*(<>|=|<=|<|>=|>)\s*(:[A-Za-z0-9_]+)/);
    if (!cmp) throw new Error(`unparsed condition: ${rest}`);
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
  const ddb = {
    items,
    queries: [],
    seed(tableName, item) {
      const idx = items.findIndex(
        (row) => keyOf(row.TableName, row.Item) === keyOf(tableName, item)
      );
      const entry = { TableName: tableName, Item: { ...item } };
      if (idx >= 0) items[idx] = entry;
      else items.push(entry);
    },
    of(tableName) {
      return items.filter((row) => row.TableName === tableName).map((row) => ({ ...row.Item }));
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
        if (
          ConditionExpression &&
          !evalCondition(
            found ? found.Item : {},
            ConditionExpression,
            ExpressionAttributeNames || {},
            ExpressionAttributeValues || {}
          )
        ) {
          failConditional();
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
        this.queries.push(pk);
        const found = items
          .filter((row) => row.TableName === TableName && row.Item.PK === pk)
          .filter((row) => (skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true))
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
        found.Item = applyUpdateExpression(
          found.Item,
          UpdateExpression,
          ExpressionAttributeNames,
          ExpressionAttributeValues
        );
        return { Attributes: { ...found.Item } };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
  ddb.seed(ACCESS, {
    PK: ADMIN.email,
    SK: ADMIN.email,
    email: ADMIN.email,
    role: "ADMIN",
    status: "ACTIVE",
  });
  return ddb;
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
    heads: [],
    deletes: [],
    async send(command) {
      if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) {
        const key = command.input.Key;
        if (command instanceof HeadObjectCommand) this.heads.push(key);
        if (!objects[key]) s3NotFound();
        return { Body: objects[key], ContentLength: 1 };
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
        if (!objects[fromKey]) s3NotFound();
        objects[toKey] = objects[fromKey];
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

function seedMeta(ddb, { batchId, status, extra = {} }) {
  const meta = {
    ...buildImportMeta({
      batchId,
      uploadedBy: ADMIN.email,
      uploadedByName: "admin",
      uploadedAt: "2026-09-15T07:00:00.000Z",
      fileName: `${batchId}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSize: 1024,
      s3Key: extra.s3Key || buildS3Key(ADMIN.email, batchId),
    }),
    status,
    totalRows: extra.totalRows ?? 1,
    validRows: extra.validRows ?? 1,
    invalidRows: extra.invalidRows ?? 0,
    successCount: extra.successCount ?? 1,
    failureCount: extra.failureCount ?? 0,
    confirmedAt: NOW,
    completedAt: status === IMPORT_STATUSES.COMPLETED ? NOW : null,
    ...extra,
  };
  ddb.seed(TABLE, meta);
  return meta;
}

function seedRow(ddb, batchId, row) {
  ddb.seed(TABLE, {
    PK: importPk(batchId),
    SK: `ROW#${String(row.rowNumber).padStart(6, "0")}`,
    type: "TASK_IMPORT_ROW",
    batchId,
    status: "IMPORTED",
    ...row,
  });
}

function seedTask(ddb, task) {
  ddb.seed(TABLE, {
    PK: "ENTITY#TASK",
    SK: `TASK#${task.taskId}`,
    ...task,
  });
}

function seedAssignment(ddb, taskId, email) {
  ddb.seed(TABLE, {
    PK: `TASK#${taskId}`,
    SK: `ASSIGNMENT#${email}`,
    email,
    removed: false,
  });
}

function seedImmediateAssigned(ddb, batchId, { taskId = "task-imm", email = "rahul@mydgv.com", rowNumber = 2 } = {}) {
  seedRow(ddb, batchId, {
    rowNumber,
    taskId,
    assignmentMode: "IMMEDIATE",
    resolvedAssignees: [{ email }],
    values: { assignees: [email], assignmentMode: "IMMEDIATE" },
  });
  seedTask(ddb, {
    taskId,
    assignmentMode: "IMMEDIATE",
    assignmentState: "ASSIGNED",
    assignees: [email],
  });
  seedAssignment(ddb, taskId, email);
}

function seedScheduled(ddb, batchId, { taskId = "task-sched", email = "priya@mydgv.com", rowNumber = 3, state = "PENDING" } = {}) {
  seedRow(ddb, batchId, {
    rowNumber,
    taskId,
    assignmentMode: "SCHEDULED",
    resolvedAssignees: [{ email }],
    values: { assignees: [email], assignmentMode: "SCHEDULED" },
  });
  seedTask(ddb, {
    taskId,
    assignmentMode: "SCHEDULED",
    assignmentState: state,
    pendingAssignees: [email],
    assignees: state === "ASSIGNED" ? [email] : [],
  });
  if (state === "ASSIGNED") seedAssignment(ddb, taskId, email);
}

async function promote(env, extras = {}) {
  return promoteImportAudit({
    ddb: env.ddb,
    s3: env.s3,
    tableName: TABLE,
    bucket: BUCKET,
    batchId: env.batchId,
    now: NOW,
    nowMs: NOW_MS,
    ...extras,
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
  await test("immediate-only COMPLETED batch becomes ELIGIBLE with one audit copy", async () => {
    const batchId = "batch-imm";
    const ddb = createMemoryDdb();
    const tmpKey = buildS3Key(ADMIN.email, batchId);
    seedMeta(ddb, { batchId, status: IMPORT_STATUSES.COMPLETED });
    seedImmediateAssigned(ddb, batchId);
    const s3 = createMemoryS3({ [tmpKey]: FILE });
    const result = await promote({ ddb, s3, batchId });
    assert.strictEqual(result.eligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const meta = ddb.of(TABLE).find((item) => item.SK === META_SK);
    assert.strictEqual(meta.status, IMPORT_STATUSES.COMPLETED);
    assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const auditKey = buildAuditS3Key(ADMIN.email, batchId);
    assert.strictEqual(meta.s3Key, auditKey);
    assert.ok(s3.objects[auditKey]);
    assert.strictEqual(s3.copies.filter((item) => item.toKey === auditKey).length, 1);
    assert.ok(s3.heads.includes(auditKey), "audit copy must be verified with HeadObject");
    assert.ok(!s3.objects[tmpKey]);
    assert.ok(s3.deletes.includes(tmpKey));
  });

  await test("scheduled-only COMPLETED PENDING batch becomes ELIGIBLE immediately", async () => {
    const batchId = "batch-sched";
    const ddb = createMemoryDdb();
    seedMeta(ddb, { batchId, status: IMPORT_STATUSES.COMPLETED });
    seedScheduled(ddb, batchId, { state: "PENDING" });
    const s3 = createMemoryS3({ [buildS3Key(ADMIN.email, batchId)]: FILE });
    const result = await promote({ ddb, s3, batchId });
    assert.strictEqual(result.eligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const meta = ddb.of(TABLE).find((item) => item.SK === META_SK);
    assert.strictEqual(meta.status, IMPORT_STATUSES.COMPLETED);
    assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    assert.strictEqual(meta.s3Key, buildAuditS3Key(ADMIN.email, batchId));
    assert.ok(s3.objects[meta.s3Key]);
    assert.ok(!s3.objects[buildHoldS3Key(ADMIN.email, batchId)]);
  });

  await test("mixed COMPLETED batch becomes ELIGIBLE while scheduled work is PENDING", async () => {
    const batchId = "batch-mixed";
    const ddb = createMemoryDdb();
    seedMeta(ddb, {
      batchId,
      status: IMPORT_STATUSES.COMPLETED,
      extra: { totalRows: 2, validRows: 2, successCount: 2 },
    });
    seedImmediateAssigned(ddb, batchId);
    seedScheduled(ddb, batchId, { state: "PENDING" });
    const s3 = createMemoryS3({ [buildS3Key(ADMIN.email, batchId)]: FILE });
    const result = await promote({ ddb, s3, batchId });
    assert.strictEqual(result.eligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    assert.ok(s3.objects[buildAuditS3Key(ADMIN.email, batchId)]);
    const dist = evaluateBatchDistribution(
      ddb,
      TABLE,
      ddb.of(TABLE).find((item) => item.SK === META_SK)
    );
    assert.strictEqual(dist.eligible, true);
    assert.strictEqual(dist.waiting, false);
  });

  await test("ASSIGNING scheduled task does not block ELIGIBLE", async () => {
    const batchId = "batch-assigning";
    const ddb = createMemoryDdb();
    seedMeta(ddb, { batchId, status: IMPORT_STATUSES.COMPLETED });
    seedScheduled(ddb, batchId, { state: "ASSIGNING" });
    const s3 = createMemoryS3({ [buildS3Key(ADMIN.email, batchId)]: FILE });
    const result = await promote({ ddb, s3, batchId });
    assert.strictEqual(result.eligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    assert.ok(s3.objects[buildAuditS3Key(ADMIN.email, batchId)]);
  });

  await test("legacy four-part S3 keys are never deleted", async () => {
    const batchId = "batch-legacy";
    const ddb = createMemoryDdb();
    const legacyKey = `task-imports/${ADMIN.email}/${batchId}/original.xlsx`;
    seedMeta(ddb, {
      batchId,
      status: IMPORT_STATUSES.COMPLETED,
      extra: { s3Key: legacyKey },
    });
    const s3 = createMemoryS3({ [legacyKey]: FILE });
    const result = await promote({ ddb, s3, batchId });
    assert.strictEqual(result.eligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    assert.ok(s3.objects[legacyKey], "legacy source must remain");
    assert.ok(s3.objects[buildAuditS3Key(ADMIN.email, batchId)]);
    assert.ok(!s3.deletes.includes(legacyKey));
    assert.strictEqual(isManagedDeletableImportKey(legacyKey, batchId), false);
  });

  await test("non-COMPLETED statuses never receive an audit copy", async () => {
    for (const status of [
      IMPORT_STATUSES.NEEDS_FIX,
      IMPORT_STATUSES.READY,
      IMPORT_STATUSES.UPLOADED,
      IMPORT_STATUSES.PARTIAL,
      IMPORT_STATUSES.FAILED,
    ]) {
      const batchId = `batch-${status.toLowerCase()}`;
      const ddb = createMemoryDdb();
      const tmpKey = buildS3Key(ADMIN.email, batchId);
      seedMeta(ddb, {
        batchId,
        status,
        extra: {
          failureCount: status === IMPORT_STATUSES.PARTIAL || status === IMPORT_STATUSES.FAILED ? 1 : 0,
          successCount: status === IMPORT_STATUSES.PARTIAL ? 1 : 0,
        },
      });
      const s3 = createMemoryS3({ [tmpKey]: FILE });
      await promote({ ddb, s3, batchId });
      assert.ok(!s3.objects[buildAuditS3Key(ADMIN.email, batchId)], status);
      assert.ok(s3.objects[tmpKey], `${status} must keep the active original`);
      const meta = ddb.of(TABLE).find((item) => item.SK === META_SK);
      assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.INELIGIBLE);
      assert.strictEqual(meta.status, status);
    }
  });

  await test("completed hold original is promoted to audit without deleting metadata", async () => {
    const batchId = "batch-hold-promote";
    const ddb = createMemoryDdb();
    const holdKey = buildHoldS3Key(ADMIN.email, batchId);
    seedMeta(ddb, {
      batchId,
      status: IMPORT_STATUSES.COMPLETED,
      extra: {
        s3Key: holdKey,
        auditEligibility: AUDIT_ELIGIBILITY.WAITING_DISTRIBUTION,
      },
    });
    seedScheduled(ddb, batchId, { state: "PENDING" });
    ddb.seed(TABLE, { PK: WAIT_PK, SK: `BATCH#${batchId}`, batchId });
    const s3 = createMemoryS3({ [holdKey]: FILE });
    const result = await promote({ ddb, s3, batchId, nowMs: NOW_MS });
    assert.strictEqual(result.eligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const meta = ddb.of(TABLE).find((item) => item.PK === importPk(batchId) && item.SK === META_SK);
    assert.ok(meta);
    assert.strictEqual(meta.status, IMPORT_STATUSES.COMPLETED);
    assert.ok(s3.objects[buildAuditS3Key(ADMIN.email, batchId)]);
    assert.ok(ddb.of(TABLE).some((item) => item.taskId === "task-sched"));
  });

  await test("download URL is denied unless ELIGIBLE and the audit object exists", async () => {
    const ddb = createMemoryDdb();
    const waitingId = "batch-wait-dl";
    seedMeta(ddb, {
      batchId: waitingId,
      status: IMPORT_STATUSES.COMPLETED,
      extra: {
        auditEligibility: AUDIT_ELIGIBILITY.WAITING_DISTRIBUTION,
        s3Key: buildHoldS3Key(ADMIN.email, waitingId),
      },
    });
    const waiting = await handleGetTaskImportDownloadUrl({
      user: ADMIN,
      batchId: waitingId,
      ddb,
      tableName: TABLE,
      bucket: BUCKET,
      s3: createMemoryS3({ [buildHoldS3Key(ADMIN.email, waitingId)]: FILE }),
    });
    assert.strictEqual(waiting.statusCode, 404);

    const eligibleId = "batch-ok-dl";
    const auditKey = buildAuditS3Key(ADMIN.email, eligibleId);
    seedMeta(ddb, {
      batchId: eligibleId,
      status: IMPORT_STATUSES.COMPLETED,
      extra: { auditEligibility: AUDIT_ELIGIBILITY.ELIGIBLE, s3Key: auditKey },
    });
    const missingObject = await handleGetTaskImportDownloadUrl({
      user: ADMIN,
      batchId: eligibleId,
      ddb,
      tableName: TABLE,
      bucket: BUCKET,
      s3: createMemoryS3(),
    });
    assert.strictEqual(missingObject.statusCode, 404);

    const ok = await handleGetTaskImportDownloadUrl({
      user: ADMIN,
      batchId: eligibleId,
      ddb,
      tableName: TABLE,
      bucket: BUCKET,
      s3: createMemoryS3({ [auditKey]: FILE }),
      getSignedUrlFn: async () => "https://s3.test/audit",
    });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.body.downloadUrl, "https://s3.test/audit");
  });

  await test("employee access remains forbidden", async () => {
    const denied = await handleGetTaskImport({
      user: EMPLOYEE,
      batchId: "batch-x",
      ddb: createMemoryDdb(),
      tableName: TABLE,
    });
    assert.strictEqual(denied.statusCode, 403);
    const download = await handleGetTaskImportDownloadUrl({
      user: EMPLOYEE,
      batchId: "batch-x",
      ddb: createMemoryDdb(),
      tableName: TABLE,
      bucket: BUCKET,
      s3: createMemoryS3(),
    });
    assert.strictEqual(download.statusCode, 403);
  });

  await test("S3 copy failure leaves the source available for retry", async () => {
    const batchId = "batch-copy-fail";
    const ddb = createMemoryDdb();
    const tmpKey = buildS3Key(ADMIN.email, batchId);
    seedMeta(ddb, { batchId, status: IMPORT_STATUSES.COMPLETED });
    seedImmediateAssigned(ddb, batchId);
    const s3 = createMemoryS3(
      { [tmpKey]: FILE },
      { failCopyTo: "task-imports/audit/" }
    );
    const result = await promote({ ddb, s3, batchId });
    assert.strictEqual(result.reason, "copy-failed");
    assert.strictEqual(result.eligibility, AUDIT_ELIGIBILITY.WAITING_DISTRIBUTION);
    assert.ok(!s3.objects[buildAuditS3Key(ADMIN.email, batchId)]);
    const meta = ddb.of(TABLE).find((item) => item.SK === META_SK);
    assert.ok(s3.objects[meta.s3Key]);
    assert.ok(
      meta.s3Key === tmpKey || meta.s3Key === buildHoldS3Key(ADMIN.email, batchId)
    );
  });

  await test("retry after copy failure promotes once HeadObject verifies the audit copy", async () => {
    const batchId = "batch-retry";
    const ddb = createMemoryDdb();
    const tmpKey = buildS3Key(ADMIN.email, batchId);
    const holdKey = buildHoldS3Key(ADMIN.email, batchId);
    const auditKey = buildAuditS3Key(ADMIN.email, batchId);
    seedMeta(ddb, { batchId, status: IMPORT_STATUSES.COMPLETED });
    seedImmediateAssigned(ddb, batchId);
    const failTo = new Set(["task-imports/audit/"]);
    const s3 = createMemoryS3({ [tmpKey]: FILE }, { failCopyTo: failTo });
    const first = await promote({ ddb, s3, batchId });
    assert.strictEqual(first.reason, "copy-failed");
    assert.strictEqual(first.eligibility, AUDIT_ELIGIBILITY.WAITING_DISTRIBUTION);
    assert.ok(!s3.objects[auditKey]);
    assert.ok(s3.objects[tmpKey] || s3.objects[holdKey]);
    assert.ok(!s3.deletes.includes(auditKey));
    failTo.clear();
    const second = await promote({ ddb, s3, batchId });
    assert.strictEqual(second.eligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    assert.ok(s3.objects[auditKey]);
    assert.ok(Buffer.compare(s3.objects[auditKey], FILE) === 0);
    assert.ok(s3.heads.includes(auditKey), "retry must verify the audit copy with HeadObject");
    const meta = ddb.of(TABLE).find((item) => item.SK === META_SK);
    assert.strictEqual(meta.s3Key, auditKey);
    assert.ok(!s3.objects[tmpKey]);
    assert.ok(!s3.objects[holdKey]);
    assert.ok(s3.deletes.includes(tmpKey) || s3.deletes.includes(holdKey));
    assert.ok(!s3.deletes.includes(auditKey));
  });

  await test("DeleteObject failure after verified HeadObject keeps the audit object", async () => {
    const batchId = "batch-cleanup-fail";
    const ddb = createMemoryDdb();
    const tmpKey = buildS3Key(ADMIN.email, batchId);
    const auditKey = buildAuditS3Key(ADMIN.email, batchId);
    seedMeta(ddb, { batchId, status: IMPORT_STATUSES.COMPLETED });
    seedImmediateAssigned(ddb, batchId);
    const s3 = createMemoryS3(
      { [tmpKey]: FILE },
      { failDelete: "task-imports/tmp/" }
    );
    const result = await promote({ ddb, s3, batchId });
    assert.strictEqual(result.eligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    const meta = ddb.of(TABLE).find((item) => item.SK === META_SK);
    assert.strictEqual(meta.status, IMPORT_STATUSES.COMPLETED);
    assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
    assert.ok(s3.objects[auditKey]);
    assert.ok(Buffer.compare(s3.objects[auditKey], FILE) === 0);
    assert.ok(s3.heads.includes(auditKey));
    assert.ok(s3.objects[tmpKey], "tmp source remains if cleanup delete fails");
    assert.ok(!s3.deletes.includes(auditKey));
  });

  await test("duplicate sweep does not create duplicate audit objects", async () => {
    const batchId = "batch-dup";
    const ddb = createMemoryDdb();
    seedMeta(ddb, { batchId, status: IMPORT_STATUSES.COMPLETED });
    seedImmediateAssigned(ddb, batchId);
    const s3 = createMemoryS3({ [buildS3Key(ADMIN.email, batchId)]: FILE });
    await promote({ ddb, s3, batchId });
    await promote({ ddb, s3, batchId });
    const auditKey = buildAuditS3Key(ADMIN.email, batchId);
    assert.strictEqual(s3.copies.filter((item) => item.toKey === auditKey).length, 1);
    assert.ok(s3.objects[auditKey]);
  });

  await test("waiting promotion queries WAIT_PK instead of scanning ENTITY#TASK", async () => {
    const ddb = createMemoryDdb();
    ddb.seed(TABLE, { PK: WAIT_PK, SK: "BATCH#batch-wait", batchId: "batch-wait" });
    seedMeta(ddb, { batchId: "batch-wait", status: IMPORT_STATUSES.COMPLETED });
    seedScheduled(ddb, "batch-wait", { state: "PENDING" });
    await promoteWaitingImportAudits({
      ddb,
      s3: createMemoryS3({ [buildS3Key(ADMIN.email, "batch-wait")]: FILE }),
      tableName: TABLE,
      bucket: BUCKET,
      now: NOW,
      nowMs: NOW_MS,
    });
    assert.ok(ddb.queries.includes(WAIT_PK));
    assert.ok(!ddb.queries.includes("ENTITY#TASK"));
  });

  await test("S3 key traversal and untrusted prefixes are rejected", () => {
    assert.strictEqual(isTrustedImportKey("task-imports/../secret.xlsx", "id"), false);
    assert.strictEqual(
      isTrustedImportKey("task-imports/tmp/../audit/admin@mydgv.com/id/original.xlsx", "id"),
      false
    );
    assert.strictEqual(isTrustedImportKey("profiles/admin@mydgv.com/id/original.xlsx", "id"), false);
    assert.strictEqual(
      parseImportS3Key("task-imports/audit/admin@mydgv.com/other/original.xlsx", "id"),
      null
    );
    assert.ok(isTrustedImportKey(buildS3Key(ADMIN.email, "id"), "id"));
    assert.ok(isTrustedImportKey(buildHoldS3Key(ADMIN.email, "id"), "id"));
    assert.ok(isTrustedImportKey(buildAuditS3Key(ADMIN.email, "id"), "id"));
    assert.ok(isTrustedImportKey("task-imports/admin@mydgv.com/id/original.xlsx", "id"));
    assert.strictEqual(canDownloadAuditOriginal({
      status: IMPORT_STATUSES.COMPLETED,
      auditEligibility: AUDIT_ELIGIBILITY.ELIGIBLE,
      s3Key: buildHoldS3Key(ADMIN.email, "id"),
      batchId: "id",
    }), false);
  });

  await test("COMPLETED meaning is unchanged when scheduled work is still PENDING", async () => {
    const batchId = "batch-status";
    const ddb = createMemoryDdb();
    seedMeta(ddb, { batchId, status: IMPORT_STATUSES.COMPLETED });
    seedScheduled(ddb, batchId, { state: "PENDING" });
    const dist = await evaluateBatchDistribution(
      ddb,
      TABLE,
      ddb.of(TABLE).find((item) => item.SK === META_SK)
    );
    assert.strictEqual(dist.eligible, true);
    assert.strictEqual(dist.waiting, false);
    const s3 = createMemoryS3({ [buildS3Key(ADMIN.email, batchId)]: FILE });
    await promote({ ddb, s3, batchId });
    const meta = ddb.of(TABLE).find((item) => item.SK === META_SK);
    assert.strictEqual(meta.status, IMPORT_STATUSES.COMPLETED);
    assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.ELIGIBLE);
  });

  console.log(`${passed} task import audit tests passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

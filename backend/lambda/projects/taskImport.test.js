const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  TYPE_TASK_IMPORT,
  META_SK,
  HISTORY_PK,
  XLSX_CONTENT_TYPE,
  XLSX_LEGACY_CONTENT_TYPE,
  OCTET_STREAM_CONTENT_TYPE,
  TASK_IMPORT_MAX_BYTES,
  IMPORT_STATUSES,
  importMaxRows,
  importMaxBytes,
  isUploadUrlPath,
  importPk,
  rowSk,
  historySk,
  buildS3Key,
  buildTmpS3Key,
  AUDIT_ELIGIBILITY,
  parseImportS3Key,
  isTrustedImportKey,
  isManagedDeletableImportKey,
  isAuditImportKey,
  buildHoldS3Key,
  buildAuditS3Key,
  importHoldRetentionDays,
  handleUploadUrlRequest,
} = require("./taskImport");
const {
  collectBlockedNewAssignees,
  newAssignmentEmails,
  isBlockedAccessStatus,
} = require("./handler");

const XLSX_BODY = {
  fileName: "bulk-tasks.xlsx",
  contentType: XLSX_CONTENT_TYPE,
  fileSize: 1024,
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
      assert.ok(command instanceof PutCommand, "expected PutCommand");
      items.push({
        TableName: command.input.TableName,
        Item: { ...command.input.Item },
      });
      return {};
    },
  };
}

async function fakeSign(_client, command) {
  assert.ok(command instanceof PutObjectCommand);
  return `https://s3.test/${command.input.Bucket}/${command.input.Key}?signed=1`;
}

async function requestUpload({ user, body, ddb, extras = {} }) {
  const { skipAccess, access, ...rest } = extras;
  if (!skipAccess && ddb && typeof ddb.seed === "function") {
    const e = String(access?.email || user?.email || "admin@mydgv.com")
      .trim()
      .toLowerCase();
    ddb.seed("access-table", {
      PK: e,
      SK: e,
      email: e,
      role: access?.role || "ADMIN",
      status: access?.status || "ACTIVE",
    });
  }
  return handleUploadUrlRequest({
    user,
    body,
    ddb,
    s3: {},
    getSignedUrlFn: fakeSign,
    tableName: "work-table",
    bucket: "docs-bucket",
    accessTable: "access-table",
    now: "2026-09-15T07:00:00.000Z",
    batchId: "batch-11111111-2222-3333-4444-555555555555",
    ...rest,
  });
}

process.env.TASK_IMPORT_MAX_ROWS = "200";
delete process.env.TASK_IMPORT_MAX_BYTES;

assert.strictEqual(isUploadUrlPath("/task-imports/upload-url"), true);
assert.strictEqual(isUploadUrlPath("/prod/task-imports/upload-url"), true);
assert.strictEqual(isUploadUrlPath("/tasks"), false);
assert.strictEqual(isUploadUrlPath("/tasks/upload-url"), false);

assert.strictEqual(rowSk(7), "ROW#000007");
assert.strictEqual(rowSk(0), "ROW#000000");
assert.strictEqual(rowSk(200), "ROW#000200");

assert.strictEqual(importMaxRows(), 200);
process.env.TASK_IMPORT_MAX_ROWS = "50";
assert.strictEqual(importMaxRows(), 50);
process.env.TASK_IMPORT_MAX_ROWS = "200";
assert.strictEqual(importMaxRows(), 200);
assert.strictEqual(importMaxBytes(), TASK_IMPORT_MAX_BYTES);
assert.strictEqual(TASK_IMPORT_MAX_BYTES, 5 * 1024 * 1024);

const template = fs.readFileSync(
  path.join(__dirname, "../../template.yaml"),
  "utf8"
);
assert.ok(
  template.includes('TASK_IMPORT_MAX_ROWS: "200"'),
  "TASK_IMPORT_MAX_ROWS must be configured in template.yaml"
);
assert.ok(
  template.includes('TASK_IMPORT_PROCESSING_LEASE_MS: "180000"'),
  "TASK_IMPORT_PROCESSING_LEASE_MS must exceed the 120s Lambda timeout"
);
assert.ok(
  template.includes('TASK_SCHEDULED_ASSIGN_LEASE_MS: "180000"'),
  "TASK_SCHEDULED_ASSIGN_LEASE_MS must exceed the 120s Lambda timeout"
);
assert.ok(
  /Timeout:\s*120/.test(template),
  "ProjectsFunction Timeout must remain 120 seconds"
);
assert.ok(
  template.includes("Prefix: task-imports/"),
  "DocumentsBucket lifecycle must use rule-level Prefix task-imports/"
);
assert.ok(
  /ExpireTaskImports[\s\S]*Status:\s*Disabled/.test(template),
  "task-imports/ originals must not auto-expire as a whole prefix"
);
assert.ok(
  /ExpireTaskImportTmp[\s\S]*Status:\s*Enabled[\s\S]*Prefix:\s*task-imports\/tmp\//.test(
    template
  ),
  "tmp import uploads must expire with a dedicated lifecycle rule"
);
assert.ok(
  /ExpireTaskImportHold[\s\S]*Status:\s*Enabled[\s\S]*Prefix:\s*task-imports\/hold\//.test(
    template
  ),
  "hold originals must use a dedicated enabled lifecycle prefix"
);
assert.ok(
  template.includes("TASK_IMPORT_HOLD_RETENTION_DAYS"),
  "hold retention days must be passed to ProjectsFunction"
);
assert.strictEqual(importHoldRetentionDays(), 90);
assert.ok(
  template.includes("Path: /task-imports"),
  "API Gateway route for import history must exist"
);
assert.ok(
  template.includes("Path: /task-imports/{batchId}/download-url"),
  "API Gateway route for import download-url must exist"
);
assert.ok(
  template.includes("Path: /task-imports/upload-url"),
  "API Gateway route for upload-url must exist"
);
assert.ok(
  template.includes("Path: /task-imports/{batchId}/confirm"),
  "API Gateway route for confirm must exist"
);

function importMeta(ddb) {
  return ddb.items.find((row) => row.Item && row.Item.SK === META_SK && row.Item.type === TYPE_TASK_IMPORT)
    ?.Item;
}

const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };

async function expectStatus(body, statusCode, errorPattern) {
  const ddb = createMemoryDdb();
  const result = await requestUpload({ user: ADMIN, body, ddb });
  assert.strictEqual(result.statusCode, statusCode);
  if (errorPattern) assert.match(result.body.error, errorPattern);
  if (statusCode !== 200) {
    assert.ok(ddb.items.every((row) => row.TableName === "access-table"));
  }
  return { result, ddb };
}

(async () => {
{
  const ddb = createMemoryDdb();
  const result = await requestUpload({
    user: {
      email: "employee@mydgv.com",
      groups: ["Employee"],
      isAdmin: false,
    },
    body: XLSX_BODY,
    ddb,
    extras: { skipAccess: true },
  });
  assert.strictEqual(result.statusCode, 403);
  assert.strictEqual(result.body.error, "Admin required");
  assert.strictEqual(ddb.items.length, 0);
}

{
  await expectStatus({ ...XLSX_BODY, fileName: "tasks.xls" }, 400, /xlsx/i);
  await expectStatus({ ...XLSX_BODY, fileName: "tasks.csv" }, 400, /xlsx/i);
  await expectStatus({ ...XLSX_BODY, contentType: "text/csv" }, 400, /content type/i);
  await expectStatus(
    { ...XLSX_BODY, contentType: "application/pdf" },
    400,
    /content type/i
  );
  await expectStatus({ ...XLSX_BODY, contentType: "text/html" }, 400, /content type/i);
  await expectStatus(
    { ...XLSX_BODY, contentType: "image/png" },
    400,
    /content type/i
  );
  await expectStatus(
    { ...XLSX_BODY, contentType: "application/zip" },
    400,
    /content type/i
  );
  await expectStatus(
    { ...XLSX_BODY, fileSize: TASK_IMPORT_MAX_BYTES + 1 },
    400,
    /size/i
  );

  const octet = await expectStatus(
    { ...XLSX_BODY, contentType: OCTET_STREAM_CONTENT_TYPE },
    200
  );
  assert.strictEqual(importMeta(octet.ddb).contentType, OCTET_STREAM_CONTENT_TYPE);

  const missing = await expectStatus(
    { fileName: "bulk-tasks.xlsx", fileSize: 1024 },
    200
  );
  assert.strictEqual(importMeta(missing.ddb).contentType, "");

  const empty = await expectStatus({ ...XLSX_BODY, contentType: "" }, 200);
  assert.strictEqual(importMeta(empty.ddb).contentType, "");

  const legacy = await expectStatus(
    { ...XLSX_BODY, contentType: XLSX_LEGACY_CONTENT_TYPE },
    200
  );
  assert.strictEqual(importMeta(legacy.ddb).contentType, XLSX_LEGACY_CONTENT_TYPE);

  const mixed = await expectStatus(
    { ...XLSX_BODY, fileName: "BULK-TASKS.XLSX" },
    200
  );
  assert.strictEqual(importMeta(mixed.ddb).fileName, "BULK-TASKS.XLSX");

  const charset = await expectStatus(
    { ...XLSX_BODY, contentType: `${XLSX_CONTENT_TYPE}; charset=utf-8` },
    200
  );
  assert.strictEqual(importMeta(charset.ddb).contentType, XLSX_CONTENT_TYPE);
}

{
  const ddb = createMemoryDdb();
  const batchId = "batch-11111111-2222-3333-4444-555555555555";
  const uploadedAt = "2026-09-15T07:00:00.000Z";
  const result = await requestUpload({
    user: { email: "Admin@mydgv.com", groups: ["Admin"], isAdmin: true },
    body: XLSX_BODY,
    ddb,
  });
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.batchId, batchId);
  assert.ok(result.body.uploadUrl);
  assert.strictEqual(
    result.body.s3Key,
    `task-imports/tmp/admin@mydgv.com/${batchId}/original.xlsx`
  );
  assert.strictEqual(buildTmpS3Key("admin@mydgv.com", batchId), result.body.s3Key);
  assert.strictEqual(buildS3Key("admin@mydgv.com", batchId), result.body.s3Key);
  const workItems = ddb.items.filter((row) => row.TableName === "work-table");
  assert.strictEqual(workItems.length, 2);
  assert.ok(workItems.every((entry) => entry.TableName === "work-table"));

  const meta = importMeta(ddb);
  assert.strictEqual(meta.PK, importPk(batchId));
  assert.strictEqual(meta.SK, META_SK);
  assert.strictEqual(meta.batchId, batchId);
  assert.strictEqual(meta.type, TYPE_TASK_IMPORT);
  assert.strictEqual(meta.uploadedBy, "admin@mydgv.com");
  assert.strictEqual(meta.uploadedByName, "admin");
  assert.strictEqual(meta.uploadedAt, uploadedAt);
  assert.strictEqual(meta.updatedAt, uploadedAt);
  assert.strictEqual(meta.fileName, "bulk-tasks.xlsx");
  assert.strictEqual(meta.s3Key, result.body.s3Key);
  assert.strictEqual(meta.contentType, XLSX_CONTENT_TYPE);
  assert.strictEqual(meta.fileSize, 1024);
  assert.strictEqual(meta.status, IMPORT_STATUSES.UPLOADED);
  assert.strictEqual(meta.auditEligibility, AUDIT_ELIGIBILITY.INELIGIBLE);
  assert.strictEqual(meta.totalRows, 0);
  assert.strictEqual(meta.validRows, 0);
  assert.strictEqual(meta.invalidRows, 0);
  assert.strictEqual(meta.warningCount, 0);
  assert.strictEqual(meta.confirmedAt, null);
  assert.strictEqual(meta.confirmedBy, null);
  assert.strictEqual(meta.processedRows, 0);
  assert.strictEqual(meta.successCount, 0);
  assert.strictEqual(meta.failureCount, 0);
  assert.strictEqual(meta.completedAt, null);

  const history = ddb.items.find((row) => row.Item && row.Item.PK === HISTORY_PK)?.Item;
  assert.strictEqual(history.PK, HISTORY_PK);
  assert.strictEqual(history.SK, historySk(uploadedAt, batchId));
  assert.strictEqual(history.batchId, batchId);
  assert.strictEqual(history.type, TYPE_TASK_IMPORT);
  assert.strictEqual(history.status, IMPORT_STATUSES.UPLOADED);
  assert.strictEqual(history.s3Key, result.body.s3Key);
}

assert.strictEqual(isTrustedImportKey("task-imports/../x/original.xlsx", "id"), false);
assert.strictEqual(
  isTrustedImportKey("task-imports/tmp/admin@mydgv.com/id/../original.xlsx", "id"),
  false
);
assert.strictEqual(isTrustedImportKey("profiles/secret.xlsx", "id"), false);
assert.ok(isTrustedImportKey(buildTmpS3Key("admin@mydgv.com", "id"), "id"));
assert.ok(isTrustedImportKey(buildHoldS3Key("admin@mydgv.com", "id"), "id"));
assert.ok(isAuditImportKey(buildAuditS3Key("admin@mydgv.com", "id"), "id"));
assert.ok(isManagedDeletableImportKey(buildTmpS3Key("admin@mydgv.com", "id"), "id"));
assert.ok(!isManagedDeletableImportKey(buildAuditS3Key("admin@mydgv.com", "id"), "id"));
assert.ok(parseImportS3Key("task-imports/admin@mydgv.com/id/original.xlsx", "id"));
assert.strictEqual(
  parseImportS3Key("task-imports/audit/admin@mydgv.com/other/original.xlsx", "id"),
  null
);

assert.strictEqual(typeof collectBlockedNewAssignees, "function");
assert.strictEqual(typeof newAssignmentEmails, "function");
assert.strictEqual(isBlockedAccessStatus("BLOCKED"), true);
assert.strictEqual(isBlockedAccessStatus("ACTIVE"), false);

console.log("task import foundation tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

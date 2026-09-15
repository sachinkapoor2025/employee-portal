const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");
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
  return {
    items,
    async send(command) {
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
  return handleUploadUrlRequest({
    user,
    body,
    ddb,
    s3: {},
    getSignedUrlFn: fakeSign,
    tableName: "work-table",
    bucket: "docs-bucket",
    now: "2026-09-15T07:00:00.000Z",
    batchId: "batch-11111111-2222-3333-4444-555555555555",
    ...extras,
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
  template.includes("Path: /task-imports/upload-url"),
  "API Gateway route for upload-url must exist"
);
assert.ok(
  template.includes("Path: /task-imports/{batchId}/confirm"),
  "API Gateway route for confirm must exist"
);

const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };

async function expectStatus(body, statusCode, errorPattern) {
  const ddb = createMemoryDdb();
  const result = await requestUpload({ user: ADMIN, body, ddb });
  assert.strictEqual(result.statusCode, statusCode);
  if (errorPattern) assert.match(result.body.error, errorPattern);
  if (statusCode !== 200) assert.strictEqual(ddb.items.length, 0);
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
  assert.strictEqual(
    octet.ddb.items[0].Item.contentType,
    OCTET_STREAM_CONTENT_TYPE
  );

  const missing = await expectStatus(
    { fileName: "bulk-tasks.xlsx", fileSize: 1024 },
    200
  );
  assert.strictEqual(missing.ddb.items[0].Item.contentType, "");

  const empty = await expectStatus({ ...XLSX_BODY, contentType: "" }, 200);
  assert.strictEqual(empty.ddb.items[0].Item.contentType, "");

  const legacy = await expectStatus(
    { ...XLSX_BODY, contentType: XLSX_LEGACY_CONTENT_TYPE },
    200
  );
  assert.strictEqual(
    legacy.ddb.items[0].Item.contentType,
    XLSX_LEGACY_CONTENT_TYPE
  );

  const mixed = await expectStatus(
    { ...XLSX_BODY, fileName: "BULK-TASKS.XLSX" },
    200
  );
  assert.strictEqual(mixed.ddb.items[0].Item.fileName, "BULK-TASKS.XLSX");

  const charset = await expectStatus(
    { ...XLSX_BODY, contentType: `${XLSX_CONTENT_TYPE}; charset=utf-8` },
    200
  );
  assert.strictEqual(charset.ddb.items[0].Item.contentType, XLSX_CONTENT_TYPE);
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
    `task-imports/admin@mydgv.com/${batchId}/original.xlsx`
  );
  assert.strictEqual(
    buildS3Key("admin@mydgv.com", batchId),
    result.body.s3Key
  );
  assert.strictEqual(ddb.items.length, 2);
  assert.ok(ddb.items.every((entry) => entry.TableName === "work-table"));

  const meta = ddb.items[0].Item;
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

  const history = ddb.items[1].Item;
  assert.strictEqual(history.PK, HISTORY_PK);
  assert.strictEqual(history.SK, historySk(uploadedAt, batchId));
  assert.strictEqual(history.batchId, batchId);
  assert.strictEqual(history.type, TYPE_TASK_IMPORT);
  assert.strictEqual(history.status, IMPORT_STATUSES.UPLOADED);
  assert.strictEqual(history.s3Key, result.body.s3Key);
}

assert.strictEqual(typeof collectBlockedNewAssignees, "function");
assert.strictEqual(typeof newAssignmentEmails, "function");
assert.strictEqual(isBlockedAccessStatus("BLOCKED"), true);
assert.strictEqual(isBlockedAccessStatus("ACTIVE"), false);

console.log("task import foundation tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

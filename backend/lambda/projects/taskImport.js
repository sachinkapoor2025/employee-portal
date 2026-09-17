const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { randomUUID } = require("crypto");
const taskImportParse = require("./taskImportParse");

const TYPE_TASK_IMPORT = "TASK_IMPORT";
const META_SK = "META";
const HISTORY_PK = "ENTITY#TASK_IMPORT";
const XLSX_EXTENSION = ".xlsx";
const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLSX_LEGACY_CONTENT_TYPE = "application/vnd.ms-excel";
const OCTET_STREAM_CONTENT_TYPE = "application/octet-stream";
const ALLOWED_XLSX_CONTENT_TYPES = new Set([
  XLSX_CONTENT_TYPE,
  OCTET_STREAM_CONTENT_TYPE,
  XLSX_LEGACY_CONTENT_TYPE,
]);
const TASK_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const SIGNED_TTL_SECONDS = 300;
const S3_OBJECT_NAME = "original.xlsx";
const S3_PREFIX_TMP = "tmp";
const S3_PREFIX_HOLD = "hold";
const S3_PREFIX_AUDIT = "audit";
const MANAGED_S3_PREFIXES = new Set([S3_PREFIX_TMP, S3_PREFIX_HOLD, S3_PREFIX_AUDIT]);
const DEFAULT_HOLD_RETENTION_DAYS = 90;

const AUDIT_ELIGIBILITY = Object.freeze({
  INELIGIBLE: "INELIGIBLE",
  WAITING_DISTRIBUTION: "WAITING_DISTRIBUTION",
  ELIGIBLE: "ELIGIBLE",
});
const WAIT_PK = "ENTITY#TASK_IMPORT_WAIT";
const TYPE_TASK_IMPORT_AUDIT_WAIT = "TASK_IMPORT_AUDIT_WAIT";

const IMPORT_STATUSES = Object.freeze({
  UPLOADED: "UPLOADED",
  VALIDATING: "VALIDATING",
  READY: "READY",
  NEEDS_FIX: "NEEDS_FIX",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
});

function importMaxRows() {
  const n = Number(process.env.TASK_IMPORT_MAX_ROWS);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("TASK_IMPORT_MAX_ROWS is not configured");
  }
  return n;
}

function importMaxBytes() {
  const n = Number(process.env.TASK_IMPORT_MAX_BYTES);
  if (Number.isFinite(n) && n > 0) return n;
  return TASK_IMPORT_MAX_BYTES;
}

function isUploadUrlPath(path) {
  return String(path || "")
    .replace(/\/+$/, "")
    .endsWith("/task-imports/upload-url");
}

function extOf(fileName) {
  const i = String(fileName || "").lastIndexOf(".");
  return i >= 0 ? String(fileName).slice(i).toLowerCase() : "";
}

function normalizeContentType(contentType) {
  return String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function sanitizeUploaderEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.@_+-]/g, "_");
}

function uploadedByNameFromEmail(email) {
  const local = String(email || "").split("@")[0].trim();
  return local || String(email || "").trim() || "Unknown";
}

function importPk(batchId) {
  return `IMPORT#${batchId}`;
}

function rowSk(rowNumber) {
  const n = Number(rowNumber);
  if (!Number.isInteger(n) || n < 0 || n > 999999) {
    throw new Error("Invalid import row number");
  }
  return `ROW#${String(n).padStart(6, "0")}`;
}

function historySk(uploadedAt, batchId) {
  return `IMPORT#${uploadedAt}#${batchId}`;
}

function buildLegacyS3Key(uploaderEmail, batchId) {
  return `task-imports/${sanitizeUploaderEmail(uploaderEmail)}/${batchId}/${S3_OBJECT_NAME}`;
}

function buildPrefixedS3Key(kind, uploaderEmail, batchId) {
  return `task-imports/${kind}/${sanitizeUploaderEmail(uploaderEmail)}/${batchId}/${S3_OBJECT_NAME}`;
}

function buildTmpS3Key(uploaderEmail, batchId) {
  return buildPrefixedS3Key(S3_PREFIX_TMP, uploaderEmail, batchId);
}

function buildHoldS3Key(uploaderEmail, batchId) {
  return buildPrefixedS3Key(S3_PREFIX_HOLD, uploaderEmail, batchId);
}

function buildAuditS3Key(uploaderEmail, batchId) {
  return buildPrefixedS3Key(S3_PREFIX_AUDIT, uploaderEmail, batchId);
}

function buildS3Key(uploaderEmail, batchId) {
  return buildTmpS3Key(uploaderEmail, batchId);
}

function auditWaitSk(batchId) {
  return `BATCH#${batchId}`;
}

function importHoldRetentionDays() {
  const n = Number(process.env.TASK_IMPORT_HOLD_RETENTION_DAYS);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 3650);
  return DEFAULT_HOLD_RETENTION_DAYS;
}

function parseImportS3Key(s3Key, batchId) {
  const key = String(s3Key || "").replace(/^\/+/, "");
  if (!key) return null;
  if (key.includes("..") || key.includes("\\") || key.includes("\0")) return null;
  if (key.includes("//")) return null;
  if (!key.startsWith("task-imports/")) return null;
  const parts = key.split("/");
  if (parts[0] !== "task-imports") return null;
  if (parts[parts.length - 1] !== S3_OBJECT_NAME) return null;
  if (parts.length === 4) {
    const email = parts[1];
    const id = parts[2];
    if (!email || !id) return null;
    if (MANAGED_S3_PREFIXES.has(email)) return null;
    if (batchId && id !== String(batchId)) return null;
    return { kind: "legacy", email, batchId: id, key };
  }
  if (parts.length === 5) {
    const kind = parts[1];
    const email = parts[2];
    const id = parts[3];
    if (!MANAGED_S3_PREFIXES.has(kind) || !email || !id) return null;
    if (batchId && id !== String(batchId)) return null;
    return { kind, email, batchId: id, key };
  }
  return null;
}

function isTrustedImportKey(s3Key, batchId) {
  return Boolean(parseImportS3Key(s3Key, batchId));
}

function isManagedDeletableImportKey(s3Key, batchId) {
  const parsed = parseImportS3Key(s3Key, batchId);
  return Boolean(parsed && (parsed.kind === S3_PREFIX_TMP || parsed.kind === S3_PREFIX_HOLD));
}

function isAuditImportKey(s3Key, batchId) {
  const parsed = parseImportS3Key(s3Key, batchId);
  return Boolean(parsed && parsed.kind === S3_PREFIX_AUDIT);
}

function isAllowedXlsxContentType(contentType) {
  const ct = normalizeContentType(contentType);
  if (!ct) return true;
  return ALLOWED_XLSX_CONTENT_TYPES.has(ct);
}

function validateUploadMeta({ fileName, contentType, fileSize } = {}) {
  if (!fileName || extOf(fileName) !== XLSX_EXTENSION) {
    return { error: "Only .xlsx files are allowed." };
  }
  if (!isAllowedXlsxContentType(contentType)) {
    return { error: "Invalid content type. Expected Excel .xlsx." };
  }
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    return { error: "Invalid file size." };
  }
  if (size > importMaxBytes()) {
    return { error: "File size exceeds the allowed limit." };
  }
  return null;
}

function buildImportMeta({
  batchId,
  uploadedBy,
  uploadedByName,
  uploadedAt,
  fileName,
  contentType,
  fileSize,
  s3Key,
}) {
  return {
    PK: importPk(batchId),
    SK: META_SK,
    batchId,
    type: TYPE_TASK_IMPORT,
    uploadedBy,
    uploadedByName,
    uploadedAt,
    updatedAt: uploadedAt,
    fileName,
    s3Key,
    contentType: normalizeContentType(contentType),
    fileSize: Number(fileSize),
    status: IMPORT_STATUSES.UPLOADED,
    auditEligibility: AUDIT_ELIGIBILITY.INELIGIBLE,
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    warningCount: 0,
    confirmedAt: null,
    confirmedBy: null,
    processedRows: 0,
    successCount: 0,
    failureCount: 0,
    completedAt: null,
  };
}

function buildHistoryCopy(meta) {
  return {
    ...meta,
    PK: HISTORY_PK,
    SK: historySk(meta.uploadedAt, meta.batchId),
  };
}

async function syncImportHistory(ddb, tableName, meta) {
  if (!ddb || !tableName || !meta?.batchId || !meta?.uploadedAt) return;
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: buildHistoryCopy(meta),
    })
  );
}

async function handleUploadUrlRequest({
  user,
  body = {},
  ddb,
  s3,
  now,
  batchId,
  getSignedUrlFn = getSignedUrl,
  tableName = process.env.WORK_TABLE,
  bucket = process.env.DOCUMENTS_BUCKET,
  signedTtl = Number(process.env.TASK_IMPORT_URL_TTL_SECONDS || SIGNED_TTL_SECONDS),
} = {}) {
  if (!user?.isAdmin) {
    return { statusCode: 403, body: { error: "Admin required" } };
  }

  const validation = validateUploadMeta(body);
  if (validation) {
    return { statusCode: 400, body: { error: validation.error } };
  }
  if (!tableName) {
    return { statusCode: 500, body: { error: "Work table not configured" } };
  }
  if (!bucket) {
    return { statusCode: 500, body: { error: "Documents bucket not configured" } };
  }

  const id = batchId || randomUUID();
  const uploadedAt = now || new Date().toISOString();
  const uploadedBy = String(user.email || "").toLowerCase();
  const s3Key = buildS3Key(uploadedBy, id);
  const contentType = normalizeContentType(body.contentType);
  const meta = buildImportMeta({
    batchId: id,
    uploadedBy,
    uploadedByName:
      user.uploadedByName || uploadedByNameFromEmail(uploadedBy),
    uploadedAt,
    fileName: String(body.fileName),
    contentType,
    fileSize: body.fileSize,
    s3Key,
  });
  const history = buildHistoryCopy(meta);

  await ddb.send(new PutCommand({ TableName: tableName, Item: meta }));
  await ddb.send(new PutCommand({ TableName: tableName, Item: history }));

  const putObject = {
    Bucket: bucket,
    Key: s3Key,
  };
  if (contentType) putObject.ContentType = contentType;
  const uploadUrl = await getSignedUrlFn(
    s3,
    new PutObjectCommand(putObject),
    { expiresIn: Number.isFinite(signedTtl) && signedTtl > 0 ? signedTtl : SIGNED_TTL_SECONDS }
  );

  return {
    statusCode: 200,
    body: {
      batchId: id,
      uploadUrl,
      s3Key,
    },
  };
}

module.exports = {
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
  S3_OBJECT_NAME: "original.xlsx",
  S3_PREFIX_TMP,
  S3_PREFIX_HOLD,
  S3_PREFIX_AUDIT,
  AUDIT_ELIGIBILITY,
  WAIT_PK,
  TYPE_TASK_IMPORT_AUDIT_WAIT,
  importPk,
  rowSk,
  historySk,
  auditWaitSk,
  importHoldRetentionDays,
  parseImportS3Key,
  isTrustedImportKey,
  isManagedDeletableImportKey,
  isAuditImportKey,
  buildLegacyS3Key,
  buildTmpS3Key,
  buildHoldS3Key,
  buildAuditS3Key,
  buildS3Key,
  validateUploadMeta,
  buildImportMeta,
  buildHistoryCopy,
  syncImportHistory,
  handleUploadUrlRequest,
  TASKS_SHEET_NAME: taskImportParse.TASKS_SHEET_NAME,
  TASK_IMPORT_COLUMNS: taskImportParse.TASK_IMPORT_COLUMNS,
  ASSIGNMENT_MODES: taskImportParse.ASSIGNMENT_MODES,
  IMPORT_PRIORITIES: taskImportParse.IMPORT_PRIORITIES,
  ROW_STATUS: taskImportParse.ROW_STATUS,
  parseTaskImportWorkbook: taskImportParse.parseTaskImportWorkbook,
};

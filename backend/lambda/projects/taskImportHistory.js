const { HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const {
  HISTORY_PK,
  IMPORT_STATUSES,
  META_SK,
  TYPE_TASK_IMPORT,
  importPk,
  isTrustedImportKey,
} = require("./taskImport");
const { canDownloadAuditOriginal, objectExists } = require("./taskImportAudit");
const { BATCH_ID_RE, queryAll } = require("./taskImportPreview");
const { normalizeEmail } = require("./escalation");
const {
  authorizeImportOperator,
  authorizeImportBatchView,
} = require("./workflowAccess");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 20;
const DOWNLOAD_TTL_SECONDS = 300;
const TASK_LOOKUP_CONCURRENCY = 8;
const ASSIGNMENT_PENDING = "PENDING";
const ASSIGNMENT_ASSIGNING = "ASSIGNING";
const DOWNLOAD_FALLBACK_FILENAME = "original.xlsx";
const DOWNLOAD_FILENAME_MAX = 120;

function sanitizeDownloadFileName(fileName) {
  const stripped = String(fileName || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\\/g, "/");
  const base = (stripped.split("/").filter(Boolean).pop() || "").trim();
  if (!base) return DOWNLOAD_FALLBACK_FILENAME;
  const cleaned = base
    .replace(/[^\w.\- ()]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, DOWNLOAD_FILENAME_MAX)
    .trim();
  if (!cleaned.toLowerCase().endsWith(".xlsx")) return DOWNLOAD_FALLBACK_FILENAME;
  const namePart = cleaned.slice(0, -5).replace(/\.+$/, "").trim();
  if (!namePart) return DOWNLOAD_FALLBACK_FILENAME;
  return `${namePart}.xlsx`;
}

function downloadContentDisposition(fileName) {
  return `attachment; filename="${sanitizeDownloadFileName(fileName)}"`;
}

function listPathMatch(path) {
  return String(path || "")
    .replace(/\/+$/, "")
    .endsWith("/task-imports");
}

function downloadPathMatch(path, pathParameters) {
  const normalized = String(path || "").replace(/\/+$/, "");
  const fromParams = pathParameters?.batchId
    ? String(pathParameters.batchId)
    : "";
  if (fromParams && /\/task-imports\/[^/]+\/download-url$/.test(normalized)) {
    return decodeURIComponent(fromParams);
  }
  const match = normalized.match(/\/task-imports\/([^/]+)\/download-url$/);
  if (!match) return null;
  const batchId = decodeURIComponent(match[1]);
  if (batchId === "upload-url") return null;
  return batchId;
}

function detailPathMatch(path, pathParameters) {
  const normalized = String(path || "").replace(/\/+$/, "");
  if (/\/task-imports\/[^/]+\/(preview|confirm|download-url)$/.test(normalized)) {
    return null;
  }
  const fromParams = pathParameters?.batchId
    ? String(pathParameters.batchId)
    : "";
  if (fromParams && /\/task-imports\/[^/]+$/.test(normalized)) {
    const id = decodeURIComponent(fromParams);
    if (id === "upload-url") return null;
    return id;
  }
  const match = normalized.match(/\/task-imports\/([^/]+)$/);
  if (!match) return null;
  const batchId = decodeURIComponent(match[1]);
  if (batchId === "upload-url") return null;
  return batchId;
}

function encodeToken(key) {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

function decodeToken(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(String(raw), "base64url").toString("utf8")
    );
    if (!parsed || typeof parsed !== "object" || !parsed.PK || !parsed.SK) {
      return { error: "Invalid nextToken" };
    }
    return { key: parsed };
  } catch {
    return { error: "Invalid nextToken" };
  }
}

function publicSummary(meta) {
  return {
    batchId: meta.batchId || "",
    fileName: meta.fileName || "",
    uploadedBy: meta.uploadedBy || "",
    uploadedByName: meta.uploadedByName || "",
    uploadedAt: meta.uploadedAt || "",
    updatedAt: meta.updatedAt || meta.uploadedAt || "",
    status: meta.status || "",
    totalRows: Number(meta.totalRows || 0),
    validRows: Number(meta.validRows || 0),
    invalidRows: Number(meta.invalidRows || 0),
    successCount: Number(meta.successCount || 0),
    failureCount: Number(meta.failureCount || 0),
    confirmedAt: meta.confirmedAt || null,
    completedAt: meta.completedAt || null,
    auditEligibility: String(meta.auditEligibility || "INELIGIBLE").toUpperCase(),
  };
}

async function getMeta(ddb, tableName, batchId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: importPk(batchId), SK: META_SK },
    })
  );
  return res.Item || null;
}

async function hydrateHistoryItem(ddb, tableName, historyItem) {
  const batchId = historyItem?.batchId;
  if (!batchId) return historyItem;
  const meta = await getMeta(ddb, tableName, batchId);
  return meta && meta.type === TYPE_TASK_IMPORT ? meta : historyItem;
}

async function mapLimited(items, limit, mapper) {
  const list = items || [];
  const out = new Array(list.length);
  let index = 0;
  const workers = Math.min(Math.max(1, limit), list.length || 1);
  async function worker() {
    while (index < list.length) {
      const current = index;
      index += 1;
      out[current] = await mapper(list[current], current);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

function isCompletedStatus(status) {
  return String(status || "").toUpperCase() === IMPORT_STATUSES.COMPLETED;
}

/**
 * Exact count of completed history items that pass the same view gate as
 * listed rows, observed while paging DynamoDB. Not a cheap consistent snapshot.
 */
async function countVisibleCompletedImportHistory({
  user,
  ddb,
  tableName,
  accessTable,
}) {
  let count = 0;
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        FilterExpression: "#status = :completed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":pk": HISTORY_PK,
          ":completed": IMPORT_STATUSES.COMPLETED,
        },
        ExclusiveStartKey: lastKey,
      })
    );
    const historyItems = res.Items || [];
    const hydrated = await mapLimited(historyItems, TASK_LOOKUP_CONCURRENCY, (item) =>
      hydrateHistoryItem(ddb, tableName, item)
    );
    for (let i = 0; i < historyItems.length; i += 1) {
      const item = hydrated[i];
      if (!isCompletedStatus(item?.status)) continue;
      const view = await gateImportBatch({
        user,
        ddb,
        tableName,
        accessTable,
        batchId: item.batchId,
      });
      if (!view.ok) {
        return { ok: false, statusCode: 500, body: { error: "Internal server error" } };
      }
      if (view.allowed) count += 1;
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return { ok: true, count };
}

async function loadImportRows(ddb, tableName, batchId) {
  return queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": importPk(batchId),
      ":sk": "ROW#",
    },
  });
}

async function gateImportBatch({ user, ddb, tableName, accessTable, batchId }) {
  const [rows, meta] = await Promise.all([
    loadImportRows(ddb, tableName, batchId),
    getMeta(ddb, tableName, batchId),
  ]);
  return authorizeImportBatchView({
    user,
    ddb,
    tableName,
    accessTable,
    rows,
    meta,
  });
}

async function handleListTaskImports({
  user,
  ddb,
  tableName = process.env.WORK_TABLE,
  accessTable = process.env.USER_ACCESS_TABLE,
  limit,
  nextToken,
} = {}) {
  const auth = await authorizeImportOperator({ user, ddb, accessTable });
  if (!auth.ok) {
    return { statusCode: auth.statusCode, body: auth.body };
  }
  if (!tableName) {
    return { statusCode: 500, body: { error: "Work table not configured" } };
  }
  const pageSize = Number(limit);
  const size =
    Number.isFinite(pageSize) && pageSize > 0
      ? Math.min(Math.floor(pageSize), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  const decoded = decodeToken(nextToken);
  if (decoded?.error) {
    return { statusCode: 400, body: { error: decoded.error } };
  }

  const page = [];
  let exclusiveStartKey = decoded?.key || undefined;
  let lastEvaluatedKey;
  let lastIncludedHistoryKey;
  let filledEarly = false;
  let queries = 0;
  while (page.length < size && queries < 40) {
    queries += 1;
    const queried = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        FilterExpression: "#status = :completed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":pk": HISTORY_PK,
          ":completed": IMPORT_STATUSES.COMPLETED,
        },
        ScanIndexForward: false,
        Limit: size,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    const historyItems = queried.Items || [];
    const hydrated = await mapLimited(historyItems, TASK_LOOKUP_CONCURRENCY, (item) =>
      hydrateHistoryItem(ddb, tableName, item)
    );
    for (let i = 0; i < historyItems.length; i += 1) {
      const item = hydrated[i];
      if (!isCompletedStatus(item?.status)) continue;
      const view = await gateImportBatch({
        user,
        ddb,
        tableName,
        accessTable,
        batchId: item.batchId,
      });
      if (!view.ok) {
        return { statusCode: 500, body: { error: "Internal server error" } };
      }
      if (!view.allowed) continue;
      page.push(item);
      lastIncludedHistoryKey = { PK: historyItems[i].PK, SK: historyItems[i].SK };
      if (page.length >= size) {
        filledEarly = i < historyItems.length - 1;
        break;
      }
    }
    lastEvaluatedKey = queried.LastEvaluatedKey;
    exclusiveStartKey = lastEvaluatedKey;
    if (page.length >= size) break;
    if (!lastEvaluatedKey) break;
  }

  let encodedNext = null;
  if (page.length >= size && lastIncludedHistoryKey && (filledEarly || lastEvaluatedKey)) {
    encodedNext = encodeToken(lastIncludedHistoryKey);
  } else if (lastEvaluatedKey) {
    encodedNext = encodeToken(lastEvaluatedKey);
  }

  const counted = await countVisibleCompletedImportHistory({
    user,
    ddb,
    tableName,
    accessTable,
  });
  if (!counted.ok) {
    return { statusCode: counted.statusCode, body: counted.body };
  }
  return {
    statusCode: 200,
    body: {
      items: page.map(publicSummary),
      nextToken: encodedNext,
      totalCount: counted.count,
    },
  };
}

function emailsFromAssignments(items) {
  return (items || [])
    .filter((item) => item && !item.removed)
    .map((item) => normalizeEmail(item.email))
    .filter(Boolean);
}

async function listAssignments(ddb, tableName, taskId) {
  const items = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `TASK#${taskId}`,
      ":sk": "ASSIGNMENT#",
    },
  });
  return emailsFromAssignments(items);
}

function assignmentFromTask(task, assignedEmails) {
  if (!task) {
    return { state: "NONE", scheduled: false, emails: [] };
  }
  const mode = String(task.assignmentMode || "").toUpperCase();
  const state = String(task.assignmentState || "").toUpperCase();
  const scheduled = mode === "SCHEDULED";
  if (
    scheduled &&
    (state === ASSIGNMENT_PENDING || state === ASSIGNMENT_ASSIGNING)
  ) {
    const emails = [
      ...new Set(
        (task.pendingAssignees || [])
          .map((email) => normalizeEmail(email))
          .filter(Boolean)
      ),
    ];
    return { state, scheduled: true, emails };
  }
  return {
    state: state || "ASSIGNED",
    scheduled,
    emails: assignedEmails || [],
  };
}

async function assignmentForRow(ddb, tableName, row) {
  const taskId = row?.taskId;
  if (!taskId) {
    return { state: "NONE", scheduled: false, emails: [] };
  }
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: "ENTITY#TASK", SK: `TASK#${taskId}` },
    })
  );
  const task = res.Item || null;
  const mode = String(task?.assignmentMode || row.assignmentMode || "").toUpperCase();
  const state = String(task?.assignmentState || "").toUpperCase();
  if (
    mode === "SCHEDULED" &&
    (state === ASSIGNMENT_PENDING || state === ASSIGNMENT_ASSIGNING)
  ) {
    return assignmentFromTask(task, []);
  }
  const emails = task
    ? await listAssignments(ddb, tableName, taskId)
    : [];
  return assignmentFromTask(task, emails);
}

function publicRow(row, assignment) {
  const values = row.values || {};
  return {
    rowNumber: row.rowNumber,
    taskTitle: values.taskTitle || "",
    projectName: row.projectName || values.project || "",
    excelAssignees: values.assignees || [],
    resolvedAssignees: (row.resolvedAssignees || []).map((item) =>
      item && typeof item === "object" ? item.email : item
    ),
    assignmentMode: String(row.assignmentMode || values.assignmentMode || "").toUpperCase(),
    taskType: values.taskType || "",
    priority: values.priority || "",
    startDateTime: values.startDateTime || "",
    deadlineDateTime: values.deadlineDateTime || "",
    description: values.description || "",
    status: row.status || "",
    errors: row.errors || [],
    warnings: row.warnings || [],
    cellErrors: row.cellErrors || [],
    taskId: row.taskId || null,
    assignment,
  };
}

async function handleGetTaskImport({
  user,
  batchId,
  ddb,
  s3,
  tableName = process.env.WORK_TABLE,
  bucket = process.env.DOCUMENTS_BUCKET,
  accessTable = process.env.USER_ACCESS_TABLE,
} = {}) {
  const auth = await authorizeImportOperator({ user, ddb, accessTable });
  if (!auth.ok) {
    return { statusCode: auth.statusCode, body: auth.body };
  }
  const id = String(batchId || "").trim();
  if (!id || !BATCH_ID_RE.test(id)) {
    return { statusCode: 400, body: { error: "Invalid batchId." } };
  }
  if (!tableName) {
    return { statusCode: 500, body: { error: "Work table not configured" } };
  }
  const meta = await getMeta(ddb, tableName, id);
  if (!meta || meta.type !== TYPE_TASK_IMPORT) {
    return { statusCode: 404, body: { error: "Import batch not found" } };
  }
  const view = await gateImportBatch({
    user,
    ddb,
    tableName,
    accessTable,
    batchId: id,
  });
  if (!view.ok) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  if (!view.allowed) {
    return { statusCode: 404, body: { error: "Import batch not found" } };
  }

  const rowItems = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": importPk(id),
      ":sk": "ROW#",
    },
  });
  rowItems.sort((a, b) => Number(a.rowNumber || 0) - Number(b.rowNumber || 0));
  const rows = await mapLimited(rowItems, TASK_LOOKUP_CONCURRENCY, async (row) => {
    const assignment = await assignmentForRow(ddb, tableName, row);
    return publicRow(row, assignment);
  });

  const s3Key = meta.s3Key || "";
  let fileAvailable = false;
  if (bucket && s3 && canDownloadAuditOriginal(meta)) {
    fileAvailable = await objectExists(s3, bucket, s3Key);
  }

  return {
    statusCode: 200,
    body: {
      summary: {
        ...publicSummary(meta),
        fileAvailable,
      },
      rows,
    },
  };
}

async function handleGetTaskImportDownloadUrl({
  user,
  batchId,
  ddb,
  s3,
  getSignedUrlFn = getSignedUrl,
  tableName = process.env.WORK_TABLE,
  bucket = process.env.DOCUMENTS_BUCKET,
  accessTable = process.env.USER_ACCESS_TABLE,
  signedTtl = DOWNLOAD_TTL_SECONDS,
} = {}) {
  const auth = await authorizeImportOperator({ user, ddb, accessTable });
  if (!auth.ok) {
    return { statusCode: auth.statusCode, body: auth.body };
  }
  const id = String(batchId || "").trim();
  if (!id || !BATCH_ID_RE.test(id)) {
    return { statusCode: 400, body: { error: "Invalid batchId." } };
  }
  if (!tableName) {
    return { statusCode: 500, body: { error: "Work table not configured" } };
  }
  if (!bucket) {
    return { statusCode: 500, body: { error: "Documents bucket not configured" } };
  }
  const meta = await getMeta(ddb, tableName, id);
  if (!meta || meta.type !== TYPE_TASK_IMPORT) {
    return { statusCode: 404, body: { error: "Import batch not found" } };
  }
  const view = await gateImportBatch({
    user,
    ddb,
    tableName,
    accessTable,
    batchId: id,
  });
  if (!view.ok) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  if (!view.allowed) {
    return { statusCode: 404, body: { error: "Import batch not found" } };
  }
  const s3Key = meta.s3Key || "";
  if (!canDownloadAuditOriginal(meta) || !isTrustedImportKey(s3Key, id)) {
    return { statusCode: 404, body: { error: "Original Excel file is not available." } };
  }
  const exists = await objectExists(s3, bucket, s3Key);
  if (!exists) {
    return { statusCode: 404, body: { error: "Original Excel file is not available." } };
  }
  const ttl = Math.min(
    Number.isFinite(Number(signedTtl)) && Number(signedTtl) > 0
      ? Number(signedTtl)
      : DOWNLOAD_TTL_SECONDS,
    DOWNLOAD_TTL_SECONDS
  );
  const fileName = sanitizeDownloadFileName(meta.fileName);
  const downloadUrl = await getSignedUrlFn(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ResponseContentDisposition: downloadContentDisposition(meta.fileName),
    }),
    { expiresIn: ttl }
  );
  return {
    statusCode: 200,
    body: {
      batchId: id,
      fileName,
      downloadUrl,
      expiresIn: ttl,
    },
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  DOWNLOAD_TTL_SECONDS,
  DOWNLOAD_FALLBACK_FILENAME,
  sanitizeDownloadFileName,
  downloadContentDisposition,
  listPathMatch,
  downloadPathMatch,
  detailPathMatch,
  encodeToken,
  decodeToken,
  publicSummary,
  isTrustedImportKey,
  handleListTaskImports,
  handleGetTaskImport,
  handleGetTaskImportDownloadUrl,
};

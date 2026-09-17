const { HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const {
  HISTORY_PK,
  META_SK,
  TYPE_TASK_IMPORT,
  importPk,
  buildS3Key,
} = require("./taskImport");
const { BATCH_ID_RE, queryAll } = require("./taskImportPreview");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 20;
const DOWNLOAD_TTL_SECONDS = 300;
const TASK_LOOKUP_CONCURRENCY = 8;
const ASSIGNMENT_PENDING = "PENDING";
const ASSIGNMENT_ASSIGNING = "ASSIGNING";

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
  };
}

function isTrustedImportKey(s3Key, batchId) {
  const key = String(s3Key || "").replace(/^\/+/, "");
  if (!key) return false;
  if (key.includes("..") || key.includes("\\") || key.includes("\0")) {
    return false;
  }
  if (key.includes("//")) return false;
  if (!key.startsWith("task-imports/")) return false;
  const parts = key.split("/");
  if (parts.length !== 4) return false;
  if (parts[0] !== "task-imports") return false;
  if (!parts[1] || !parts[2]) return false;
  if (parts[3] !== "original.xlsx") return false;
  if (batchId && parts[2] !== String(batchId)) return false;
  return true;
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

async function countImportHistory(ddb, tableName) {
  let count = 0;
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": HISTORY_PK },
        Select: "COUNT",
        ExclusiveStartKey: lastKey,
      })
    );
    count += Number(res.Count || 0);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return count;
}

async function handleListTaskImports({
  user,
  ddb,
  tableName = process.env.WORK_TABLE,
  limit,
  nextToken,
} = {}) {
  if (!user?.isAdmin) {
    return { statusCode: 403, body: { error: "Admin required" } };
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

  const queried = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": HISTORY_PK },
      ScanIndexForward: false,
      Limit: size,
      ExclusiveStartKey: decoded?.key || undefined,
    })
  );
  const historyItems = queried.Items || [];
  const hydrated = await mapLimited(historyItems, TASK_LOOKUP_CONCURRENCY, (item) =>
    hydrateHistoryItem(ddb, tableName, item)
  );
  const totalCount = await countImportHistory(ddb, tableName);
  return {
    statusCode: 200,
    body: {
      items: hydrated.map(publicSummary),
      nextToken: encodeToken(queried.LastEvaluatedKey) || null,
      totalCount,
    },
  };
}

function emailsFromAssignments(items) {
  return (items || [])
    .filter((item) => item && !item.removed)
    .map((item) => String(item.email || "").toLowerCase())
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
    const emails = (task.pendingAssignees || [])
      .map((email) => String(email || "").toLowerCase())
      .filter(Boolean);
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

async function objectExists(s3, bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    const name = String(err?.name || err?.Code || err?.code || "");
    if (
      status === 404 ||
      name === "NotFound" ||
      name === "NoSuchKey" ||
      name === "NotFound"
    ) {
      return false;
    }
    throw err;
  }
}

async function handleGetTaskImport({
  user,
  batchId,
  ddb,
  s3,
  tableName = process.env.WORK_TABLE,
  bucket = process.env.DOCUMENTS_BUCKET,
} = {}) {
  if (!user?.isAdmin) {
    return { statusCode: 403, body: { error: "Admin required" } };
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

  const s3Key = meta.s3Key || buildS3Key(meta.uploadedBy, id);
  let fileAvailable = false;
  if (bucket && s3 && isTrustedImportKey(s3Key, id)) {
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
  signedTtl = DOWNLOAD_TTL_SECONDS,
} = {}) {
  if (!user?.isAdmin) {
    return { statusCode: 403, body: { error: "Admin required" } };
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
  const s3Key = meta.s3Key || buildS3Key(meta.uploadedBy, id);
  if (!isTrustedImportKey(s3Key, id)) {
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
  const downloadUrl = await getSignedUrlFn(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: s3Key,
    }),
    { expiresIn: ttl }
  );
  return {
    statusCode: 200,
    body: {
      batchId: id,
      fileName: meta.fileName || "original.xlsx",
      downloadUrl,
      expiresIn: ttl,
    },
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  DOWNLOAD_TTL_SECONDS,
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

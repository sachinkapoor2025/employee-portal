const {
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { normalizeEmail } = require("./escalation");
const {
  IMPORT_STATUSES,
  AUDIT_ELIGIBILITY,
  META_SK,
  TYPE_TASK_IMPORT,
  buildS3Key,
  importPk,
  rowSk,
  syncImportHistory,
} = require("./taskImport");
const {
  ROW_STATUS,
  buildCellErrors,
  parseTaskImportWorkbook,
} = require("./taskImportParse");
const { isActiveProject } = require("./projectManage");

const TYPE_TASK_IMPORT_ROW = "TASK_IMPORT_ROW";
const BATCH_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function previewPathMatch(path, pathParameters) {
  const normalized = String(path || "").replace(/\/+$/, "");
  const fromParams = pathParameters?.batchId
    ? String(pathParameters.batchId)
    : "";
  if (fromParams && /\/task-imports\/[^/]+\/preview$/.test(normalized)) {
    return decodeURIComponent(fromParams);
  }
  const match = normalized.match(/\/task-imports\/([^/]+)\/preview$/);
  if (!match) return null;
  const batchId = decodeURIComponent(match[1]);
  if (batchId === "upload-url") return null;
  return batchId;
}

function isPreviewPath(path, pathParameters) {
  return Boolean(previewPathMatch(path, pathParameters));
}

function validateBatchId(batchId) {
  const id = String(batchId || "").trim();
  if (!id || !BATCH_ID_RE.test(id)) {
    return { error: "Invalid batchId." };
  }
  return { batchId: id };
}

async function streamToBuffer(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isS3NotFound(err) {
  if (!err) return false;
  const status = err.$metadata?.httpStatusCode;
  const name = String(err.name || err.Code || err.code || "");
  return (
    status === 404 ||
    name === "NoSuchKey" ||
    name === "NotFound" ||
    name === "NoSuchBucket"
  );
}

async function queryAll(ddb, input) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        ...input,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function defaultListProjects(ddb, tableName) {
  const items = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": "ENTITY#PROJECT" },
  });
  return items
    .filter((item) => isActiveProject(item))
    .map((item) => ({
      projectId: item.projectId || String(item.SK || "").replace(/^PROJECT#/, ""),
      name: String(item.name || "").trim(),
    }))
    .filter((item) => item.projectId && item.name);
}

async function defaultLoadUserAccess(ddb, accessTable, email) {
  if (!accessTable || !email) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: accessTable,
      Key: { PK: email, SK: email },
    })
  );
  return res.Item || null;
}

function assigneeStatusError(email, access) {
  if (!access) {
    return `Assignee ${email} does not exist.`;
  }
  const status = String(access.status || "").toUpperCase();
  if (status === "ACTIVE") return null;
  if (status === "BLOCKED") return `Assignee ${email} is BLOCKED.`;
  if (status === "PENDING") return `Assignee ${email} is PENDING.`;
  if (!status) return `Assignee ${email} does not exist.`;
  return `Assignee ${email} must be ACTIVE.`;
}

function enrichPreviewRow(row, accessByEmail) {
  const errors = [...(row.errors || [])];
  const resolvedAssignees = [];
  for (const email of row.values?.assignees || []) {
    const access = accessByEmail.get(email) || null;
    const message = assigneeStatusError(email, access);
    if (message) {
      errors.push({ field: "assigneeEmail", message, value: email });
    } else {
      resolvedAssignees.push({
        email,
        status: "ACTIVE",
      });
    }
  }

  const values = { ...(row.values || {}) };
  const resolvedProject = Boolean(values.projectId);
  return {
    rowNumber: row.rowNumber,
    status: errors.length ? ROW_STATUS.INVALID : ROW_STATUS.VALID,
    raw: row.raw,
    values,
    errors,
    warnings: row.warnings || [],
    projectId: resolvedProject ? values.projectId : null,
    projectName: resolvedProject ? values.project : null,
    resolvedAssignees,
  };
}

function publicRow(row) {
  const cellErrors = buildCellErrors(row);
  return {
    rowNumber: row.rowNumber,
    status: row.status,
    raw: row.raw,
    values: row.values,
    errors: row.errors,
    warnings: row.warnings,
    cellErrors,
    projectId: row.projectId,
    projectName: row.projectName,
    resolvedAssignees: row.resolvedAssignees,
  };
}

function buildRowItem({ batchId, row, now }) {
  const view = publicRow(row);
  return {
    PK: importPk(batchId),
    SK: rowSk(row.rowNumber),
    type: TYPE_TASK_IMPORT_ROW,
    batchId,
    rowNumber: row.rowNumber,
    raw: view.raw,
    values: view.values,
    errors: view.errors,
    warnings: view.warnings,
    status: view.status,
    projectId: view.projectId,
    projectName: view.projectName,
    resolvedAssignees: view.resolvedAssignees,
    cellErrors: view.cellErrors,
    updatedAt: now,
  };
}

async function listExistingRowItems(ddb, tableName, batchId) {
  return queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": importPk(batchId),
      ":sk": "ROW#",
    },
  });
}

async function replaceRowRecords({ ddb, tableName, batchId, rows, now }) {
  const nextKeys = new Set(rows.map((row) => rowSk(row.rowNumber)));
  const existing = await listExistingRowItems(ddb, tableName, batchId);
  for (const row of rows) {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: buildRowItem({ batchId, row, now }),
      })
    );
  }
  for (const item of existing) {
    if (!nextKeys.has(item.SK)) {
      await ddb.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { PK: item.PK, SK: item.SK },
        })
      );
    }
  }
}

function previewStatus(parsed, rows) {
  if ((parsed.errors || []).length || rows.some((row) => row.status !== ROW_STATUS.VALID)) {
    return IMPORT_STATUSES.NEEDS_FIX;
  }
  return IMPORT_STATUSES.READY;
}

async function parseAndResolveWorkbook({
  buffer,
  ddb,
  tableName = process.env.WORK_TABLE,
  accessTable = process.env.USER_ACCESS_TABLE,
  nowMs,
  listProjects,
  loadUserAccess,
} = {}) {
  const loadProjects = listProjects || (() => defaultListProjects(ddb, tableName));
  const loadAccess =
    loadUserAccess ||
    ((email) => defaultLoadUserAccess(ddb, accessTable, email));
  const projects = await loadProjects();
  const parsed = parseTaskImportWorkbook(buffer, {
    nowMs: Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now(),
    projects,
  });
  const uniqueEmails = new Set();
  for (const row of parsed.rows || []) {
    for (const email of row.values?.assignees || []) uniqueEmails.add(email);
  }
  const accessByEmail = new Map();
  for (const email of uniqueEmails) {
    accessByEmail.set(email, await loadAccess(email));
  }
  const rows = (parsed.rows || []).map((row) =>
    enrichPreviewRow(row, accessByEmail)
  );
  const validRows = rows.filter((row) => row.status === ROW_STATUS.VALID).length;
  const invalidRows = rows.length - validRows;
  const warningCount = rows.reduce((sum, row) => sum + (row.warnings || []).length, 0);
  return {
    parsed,
    rows,
    status: previewStatus(parsed, rows),
    validRows,
    invalidRows,
    warningCount,
  };
}

async function handlePreviewRequest({
  user,
  batchId,
  ddb,
  s3,
  now,
  nowMs,
  tableName = process.env.WORK_TABLE,
  bucket = process.env.DOCUMENTS_BUCKET,
  accessTable = process.env.USER_ACCESS_TABLE,
  listProjects,
  loadUserAccess,
} = {}) {
  if (!user?.isAdmin) {
    return { statusCode: 403, body: { error: "Admin required" } };
  }

  const idCheck = validateBatchId(batchId);
  if (idCheck.error) {
    return { statusCode: 400, body: { error: idCheck.error } };
  }
  const id = idCheck.batchId;

  if (!tableName) {
    return { statusCode: 500, body: { error: "Work table not configured" } };
  }
  if (!bucket) {
    return { statusCode: 500, body: { error: "Documents bucket not configured" } };
  }

  const metaRes = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: importPk(id), SK: META_SK },
    })
  );
  const meta = metaRes.Item;
  if (!meta || meta.type !== TYPE_TASK_IMPORT) {
    return { statusCode: 404, body: { error: "Import batch not found." } };
  }
  const locked = String(meta.status || "").toUpperCase();
  if (
    locked === IMPORT_STATUSES.PROCESSING ||
    locked === IMPORT_STATUSES.COMPLETED ||
    locked === IMPORT_STATUSES.PARTIAL
  ) {
    return {
      statusCode: 409,
      body: {
        error: "This import has already been confirmed.",
        status: meta.status,
        batchId: id,
      },
    };
  }

  const actor = normalizeEmail(user.email);
  const owner = normalizeEmail(meta.uploadedBy);
  if (!actor || actor !== owner) {
    return { statusCode: 403, body: { error: "Forbidden" } };
  }

  const s3Key = meta.s3Key || buildS3Key(meta.uploadedBy, id);
  let buffer;
  try {
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: s3Key,
      })
    );
    buffer = await streamToBuffer(obj.Body);
  } catch (err) {
    if (isS3NotFound(err)) {
      return { statusCode: 404, body: { error: "Import file not found." } };
    }
    throw err;
  }

  const resolved = await parseAndResolveWorkbook({
    buffer,
    ddb,
    tableName,
    accessTable,
    nowMs,
    listProjects,
    loadUserAccess,
  });
  const { parsed, rows, status, validRows, invalidRows, warningCount } = resolved;
  const updatedAt = now || new Date().toISOString();
  const previewedBy = actor;

  await replaceRowRecords({
    ddb,
    tableName,
    batchId: id,
    rows,
    now: updatedAt,
  });

  const nextMeta = {
    ...meta,
    status,
    totalRows: rows.length,
    validRows,
    invalidRows,
    warningCount,
    updatedAt,
    previewedAt: updatedAt,
    previewedBy,
    auditEligibility: AUDIT_ELIGIBILITY.INELIGIBLE,
  };
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: nextMeta,
    })
  );
  await syncImportHistory(ddb, tableName, nextMeta);

  return {
    statusCode: 200,
    body: {
      batchId: id,
      status,
      totalRows: rows.length,
      validRows,
      invalidRows,
      warningCount,
      errors: parsed.errors || [],
      rows: rows.map(publicRow),
    },
  };
}

module.exports = {
  TYPE_TASK_IMPORT_ROW,
  BATCH_ID_RE,
  previewPathMatch,
  isPreviewPath,
  validateBatchId,
  streamToBuffer,
  isS3NotFound,
  queryAll,
  parseAndResolveWorkbook,
  handlePreviewRequest,
  enrichPreviewRow,
  publicRow,
  replaceRowRecords,
  listExistingRowItems,
  buildRowItem,
};

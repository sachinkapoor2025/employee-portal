const crypto = require("crypto");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const {
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const escalation = require("./escalation");
const { isConditionalCheckFailed } = require("./redAdminNotify");
const { putTaskCopiesSafe, putAssignmentSafe, putCreatedTaskRecords, assertPersistOk } = require("./taskNotifyPersist");
const {
  AUDIT_ELIGIBILITY,
  IMPORT_STATUSES,
  META_SK,
  TYPE_TASK_IMPORT,
  buildS3Key,
  importPk,
  rowSk,
  syncImportHistory,
} = require("./taskImport");
const { ROW_STATUS } = require("./taskImportParse");
const {
  BATCH_ID_RE,
  TYPE_TASK_IMPORT_ROW,
  listExistingRowItems,
  parseAndResolveWorkbook,
  publicRow,
  replaceRowRecords,
  streamToBuffer,
  isS3NotFound,
  validateBatchId,
} = require("./taskImportPreview");
const {
  cleanupNonEligibleOriginal,
  promoteImportAudit,
} = require("./taskImportAudit");
const { sendCompletedImportSummaryEmail } = require("./taskImportSummary");
const {
  assignedNotifyKey,
  getAccessRow,
  isActiveAccess,
  AccessLookupError,
  notifyExcelAssignment,
} = require("./taskImportAssignNotify");
const { authorizeImportRowCreate, filterScheduledAssignees, authorizeImportOperator } = require("./workflowAccess");
const { createCache } = require("./taskReadAccess");
const {
  ACTION_POSTPONE,
  alreadyAssignedState,
  attendanceDecisionForEmployee,
  nextScheduleFields,
  taskEvaluationRange,
} = require("./scheduledAttendance");
const {
  ASSIGNED_SHIFT_FIT,
  assignedShiftFit,
} = require("./assignedShiftFit");
const { notifyScheduledPostponement } = require("./taskScheduledPostponeNotify");
const { notifyScheduledShiftConflicts } = require("./taskScheduledShiftConflictNotify");

const ROW_IMPORTED = "IMPORTED";
const ASSIGNMENT_PENDING = "PENDING";
const ASSIGNMENT_ASSIGNING = "ASSIGNING";
const ASSIGNMENT_ASSIGNED = "ASSIGNED";
const ASSIGNMENT_SKIPPED = "SKIPPED";
const LAMBDA_TIMEOUT_MS = 120000;
const DEFAULT_PROCESSING_LEASE_MS = 180000;
const DEFAULT_SCHEDULED_ASSIGN_LEASE_MS = 180000;

function envLeaseMs(name, fallback) {
  const n = Number(process.env[name]);
  const value = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(value, LAMBDA_TIMEOUT_MS);
}

function processingLeaseMs() {
  return envLeaseMs("TASK_IMPORT_PROCESSING_LEASE_MS", DEFAULT_PROCESSING_LEASE_MS);
}

function scheduledAssignLeaseMs() {
  return envLeaseMs(
    "TASK_SCHEDULED_ASSIGN_LEASE_MS",
    DEFAULT_SCHEDULED_ASSIGN_LEASE_MS
  );
}

function isTimestampStale(iso, nowMs, leaseMs) {
  const started = Date.parse(iso || "");
  if (!Number.isFinite(started)) return true;
  return nowMs - started >= leaseMs;
}

function isProcessingLeaseStale(meta, nowMs = Date.now()) {
  if (String(meta?.status || "").toUpperCase() !== IMPORT_STATUSES.PROCESSING) {
    return false;
  }
  return isTimestampStale(meta.processingStartedAt, nowMs, processingLeaseMs());
}

function isAssigningLeaseStale(task, nowMs = Date.now()) {
  if (String(task?.assignmentState || "").toUpperCase() !== ASSIGNMENT_ASSIGNING) {
    return false;
  }
  return isTimestampStale(
    task.assigningStartedAt,
    nowMs,
    scheduledAssignLeaseMs()
  );
}

function withoutProcessingLease(meta) {
  const next = { ...(meta || {}) };
  delete next.processingStartedAt;
  delete next.processingOwner;
  return next;
}

function confirmPathMatch(path, pathParameters) {
  const normalized = String(path || "").replace(/\/+$/, "");
  const fromParams = pathParameters?.batchId
    ? String(pathParameters.batchId)
    : "";
  if (fromParams && /\/task-imports\/[^/]+\/confirm$/.test(normalized)) {
    return decodeURIComponent(fromParams);
  }
  const match = normalized.match(/\/task-imports\/([^/]+)\/confirm$/);
  if (!match) return null;
  const batchId = decodeURIComponent(match[1]);
  if (batchId === "upload-url") return null;
  return batchId;
}

function importedTaskId(batchId, rowNumber) {
  const hash = crypto
    .createHash("sha1")
    .update(`task-import:${batchId}:${rowNumber}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.slice(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function isPendingScheduledTask(task) {
  const mode = String(task?.assignmentMode || "").toUpperCase();
  const state = String(task?.assignmentState || "").toUpperCase();
  return (
    mode === "SCHEDULED" &&
    (state === ASSIGNMENT_PENDING ||
      state === ASSIGNMENT_ASSIGNING ||
      state === ASSIGNMENT_SKIPPED)
  );
}

function snapshotTask(task, assignments) {
  const emails = (assignments || [])
    .filter((a) => a && !a.removed)
    .map((a) => escalation.normalizeEmail(a.email));
  return {
    ...task,
    assignees: emails,
    assignee: emails[0] || task.assignee || "",
    assignments: (assignments || []).map((a) => ({
      email: escalation.normalizeEmail(a.email),
      status: a.status || "TODO",
      assignedAt: a.assignedAt || null,
      assignedBy: a.assignedBy || "",
      completedAt: a.completedAt || null,
      completedDate: a.completedDate || null,
      completedZone: a.completedZone || null,
      highestZone: a.highestZone || null,
      recordedZone: a.recordedZone || null,
      zoneReachedAt: a.zoneReachedAt || null,
      redAdminNotifyStatus: a.redAdminNotifyStatus || null,
      redAdminNotifyClaimedAt: a.redAdminNotifyClaimedAt || null,
      redAdminNotifiedAt: a.redAdminNotifiedAt || null,
      redAdminNotifyRecipients: a.redAdminNotifyRecipients || {},
      redAdminNotifyAttempts: Number(a.redAdminNotifyAttempts || 0) || null,
      removed: !!a.removed,
      ...escalation.assignmentBlockerFields(a),
    })),
    status: escalation.deriveParentStatus(assignments, task.status),
  };
}

async function putTaskCopies(ddb, tableName, task) {
  const result = await putTaskCopiesSafe(ddb, tableName, task);
  assertPersistOk(result, {
    op: "putTaskCopies",
    taskId: task?.taskId || "",
    PK: task?.PK || "",
    SK: task?.SK || "",
  });
  return result;
}

function assignmentRecord(taskId, assignment) {
  const email = escalation.normalizeEmail(assignment.email);
  if (!email) return null;
  return {
    PK: `TASK#${taskId}`,
    SK: `ASSIGNMENT#${email}`,
    type: "ASSIGNMENT",
    taskId,
    email,
    status: assignment.status || "TODO",
    assignedAt: assignment.assignedAt || new Date().toISOString(),
    assignedBy: assignment.assignedBy || "",
    completedAt: assignment.completedAt || null,
    completedDate: assignment.completedDate || null,
    completedZone: assignment.completedZone || null,
    highestZone: assignment.highestZone || null,
    recordedZone: assignment.recordedZone || null,
    zoneReachedAt: assignment.zoneReachedAt || null,
    redAdminNotifyStatus: assignment.redAdminNotifyStatus || null,
    redAdminNotifyClaimedAt: assignment.redAdminNotifyClaimedAt || null,
    redAdminNotifiedAt: assignment.redAdminNotifiedAt || null,
    redAdminNotifyRecipients: assignment.redAdminNotifyRecipients || {},
    redAdminNotifyAttempts: Number(assignment.redAdminNotifyAttempts || 0) || null,
    removed: !!assignment.removed,
    ...escalation.assignmentBlockerFields(assignment, { omitIfAbsent: true }),
  };
}

async function writeAssignment(ddb, tableName, taskId, assignment) {
  const item = assignmentRecord(taskId, assignment);
  if (!item) return null;
  const result = await putAssignmentSafe(ddb, tableName, item);
  assertPersistOk(result, {
    op: "writeAssignment",
    taskId,
    email: item.email,
    PK: item.PK,
    SK: item.SK,
  });
  return result.item;
}

async function persistAssignmentsAndTask(
  ddb,
  tableName,
  task,
  assignments,
  options = {}
) {
  const merged = snapshotTask(task, assignments);
  merged.projectId = String(task.projectId || "").trim();
  merged.updatedAt = new Date().toISOString();
  if (options.create) {
    const assignmentItems = (assignments || [])
      .map((assignment) => assignmentRecord(task.taskId, assignment))
      .filter(Boolean);
    const result = await putCreatedTaskRecords(
      ddb,
      tableName,
      merged,
      assignmentItems
    );
    assertPersistOk(result, {
      op: "persistTaskCreate",
      taskId: task.taskId,
      PK: merged.PK,
      SK: merged.SK,
    });
    return merged;
  }
  for (const assignment of assignments || []) {
    await writeAssignment(ddb, tableName, task.taskId, assignment);
  }
  await putTaskCopies(ddb, tableName, merged);
  return merged;
}

async function appendActivity(ddb, tableName, taskId, action, detail, actorEmail, extra = {}) {
  const now = extra.timestamp || new Date().toISOString();
  const id = crypto.randomUUID();
  const { timestamp: _ignored, ...rest } = extra || {};
  void _ignored;
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `TASK#${taskId}`,
        SK: `ACTIVITY#${now}#${id}`,
        activityId: id,
        taskId,
        action,
        detail: detail || "",
        actorEmail: actorEmail || "",
        timestamp: now,
        ...rest,
      },
    })
  );
}

async function notifyAssigned(ddb, email, title, taskId, extra = {}) {
  await notifyExcelAssignment({
    ddb,
    accessTable: extra.accessTable,
    listAccessRows: extra.listAccessRows,
    kind: extra.kind || "immediate",
    assigneeEmails: [email],
    task: {
      taskId,
      title,
      importBatchId: extra.importBatchId,
      createdBy: extra.createdBy,
      createdByName: extra.createdByName,
      projectId: extra.projectId,
    },
  });
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

async function putMeta(ddb, tableName, meta) {
  await ddb.send(new PutCommand({ TableName: tableName, Item: meta }));
  await syncImportHistory(ddb, tableName, meta);
}

async function getTask(ddb, tableName, taskId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: "ENTITY#TASK", SK: `TASK#${taskId}` },
    })
  );
  return res.Item || null;
}

function baseTaskFields({ row, batchId, taskId, user, createdByName, now }) {
  return {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
    taskId,
    projectId: row.projectId,
    title: row.values.taskTitle,
    description: row.values.description || "",
    category: row.values.taskType || "",
    priority: row.values.priority,
    dueDate: row.values.deadlineDateTime,
    startDate: row.values.startDateTime,
    durationType: null,
    durationHours: null,
    durationDays: null,
    durationStart: null,
    durationEnd: null,
    completedDate: null,
    labels: [],
    archived: false,
    createdAt: now,
    createdBy: user.email,
    createdByName,
    updatedAt: now,
    importSource: "EXCEL",
    importBatchId: batchId,
    importRowNumber: row.rowNumber,
    assignmentMode: row.values.assignmentMode,
  };
}

async function createImmediateTask({
  ddb,
  tableName,
  row,
  batchId,
  user,
  createdByName,
  now,
  nowMs,
  accessTable,
  listAccessRows,
}) {
  const taskId = importedTaskId(batchId, row.rowNumber);
  const existing = await getTask(ddb, tableName, taskId);
  const emails = (row.resolvedAssignees || []).map((item) => item.email);
  const notifyOpts = {
    ddb,
    accessTable,
    listAccessRows,
    kind: "immediate",
    assigneeEmails: emails,
    task: {
      taskId,
      title: existing?.title || row.values.taskTitle,
      importBatchId: batchId,
      createdBy: user.email,
      createdByName,
      projectId: existing?.projectId || row.projectId,
    },
    tableName,
  };
  if (existing) {
    await notifyExcelAssignment(notifyOpts);
    return { taskId, assignmentMode: "IMMEDIATE", status: "ASSIGNED", reused: true };
  }
  const assignments = emails.map((email) => ({
    email,
    status: "TODO",
    assignedAt: now,
    assignedBy: user.email,
    recordedZone: escalation.zoneAt(
      escalation.parseDeadlineMs(row.values.deadlineDateTime),
      nowMs
    ),
  }));
  const item = snapshotTask(
    {
      ...baseTaskFields({ row, batchId, taskId, user, createdByName, now }),
      assignee: emails[0] || "",
      status: "TODO",
      assignmentState: ASSIGNMENT_ASSIGNED,
    },
    assignments
  );
  await persistAssignmentsAndTask(ddb, tableName, item, assignments, {
    create: true,
  });
  await appendActivity(
    ddb,
    tableName,
    taskId,
    "task_created",
    `Task created by ${createdByName}`,
    user.email,
    { actorName: createdByName, timestamp: now }
  );
  if (item.category) {
    await appendActivity(
      ddb,
      tableName,
      taskId,
      "task_updated",
      `Category set to ${item.category}`,
      user.email,
      { timestamp: now }
    );
  }
  if (emails.length) {
    await appendActivity(
      ddb,
      tableName,
      taskId,
      "task_assigned",
      `Assigned to ${emails.join(", ")}`,
      user.email,
      { timestamp: now }
    );
    await notifyExcelAssignment({
      ...notifyOpts,
      task: {
        ...notifyOpts.task,
        title: item.title,
        createdBy: user.email,
        createdByName,
      },
    });
  }
  return { taskId, assignmentMode: "IMMEDIATE", status: "ASSIGNED", reused: false };
}

async function createScheduledTask({
  ddb,
  tableName,
  row,
  batchId,
  user,
  createdByName,
  now,
}) {
  const taskId = importedTaskId(batchId, row.rowNumber);
  const existing = await getTask(ddb, tableName, taskId);
  const emails = (row.resolvedAssignees || []).map((item) => item.email);
  if (existing) {
    const pending = isPendingScheduledTask(existing);
    return {
      taskId,
      assignmentMode: "SCHEDULED",
      status: pending ? "SCHEDULED" : "ASSIGNED",
      reused: true,
    };
  }
  const item = {
    ...baseTaskFields({ row, batchId, taskId, user, createdByName, now }),
    assignee: "",
    assignees: [],
    assignments: [],
    status: "TODO",
    assignmentState: ASSIGNMENT_PENDING,
    scheduledAssignAt: row.values.startDateTime,
    pendingAssignees: [
      ...new Set(
        emails.map((email) => escalation.normalizeEmail(email)).filter(Boolean)
      ),
    ],
  };
  item.projectId = String(item.projectId || "").trim();
  const created = await putCreatedTaskRecords(ddb, tableName, item, []);
  assertPersistOk(created, {
    op: "putTaskCopiesCreate",
    taskId,
    PK: item.PK,
    SK: item.SK,
  });
  await appendActivity(
    ddb,
    tableName,
    taskId,
    "task_created",
    `Scheduled task created by ${createdByName}`,
    user.email,
    { actorName: createdByName, timestamp: now }
  );
  return { taskId, assignmentMode: "SCHEDULED", status: "SCHEDULED", reused: false };
}

async function markRowImported(ddb, tableName, batchId, row, result, now) {
  const existing = (
    await listExistingRowItems(ddb, tableName, batchId)
  ).find((item) => item.rowNumber === row.rowNumber);
  const item = {
    ...(existing || {}),
    PK: importPk(batchId),
    SK: rowSk(row.rowNumber),
    type: TYPE_TASK_IMPORT_ROW,
    batchId,
    rowNumber: row.rowNumber,
    raw: row.raw,
    values: row.values,
    errors: row.errors || [],
    warnings: row.warnings || [],
    cellErrors: publicRow(row).cellErrors,
    status: ROW_IMPORTED,
    projectId: row.projectId,
    projectName: row.projectName,
    resolvedAssignees: row.resolvedAssignees,
    taskId: result.taskId,
    assignmentMode: result.assignmentMode,
    importedAt: existing?.importedAt || now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
}

function rowResultFromImported(item) {
  const mode = String(item.assignmentMode || "").toUpperCase();
  return {
    rowNumber: item.rowNumber,
    taskId: item.taskId,
    assignmentMode: mode || "IMMEDIATE",
    status: mode === "SCHEDULED" ? "SCHEDULED" : "ASSIGNED",
  };
}

async function confirmResponseFromRows(ddb, tableName, meta) {
  const rows = await listExistingRowItems(ddb, tableName, meta.batchId);
  const imported = rows.filter((row) => row.status === ROW_IMPORTED && row.taskId);
  return {
    statusCode: 200,
    body: {
      batchId: meta.batchId,
      status: meta.status,
      auditEligibility: meta.auditEligibility || null,
      totalRows: Number(meta.totalRows || imported.length),
      successCount: Number(meta.successCount || imported.length),
      failureCount: Number(meta.failureCount || 0),
      tasks: imported
        .sort((a, b) => a.rowNumber - b.rowNumber)
        .map(rowResultFromImported),
    },
  };
}

async function claimBatchForProcessing(ddb, tableName, batchId, now, owner, confirmedBy, nowMs) {
  const clock = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.parse(now) || Date.now();
  const staleIso = new Date(clock - processingLeaseMs()).toISOString();
  const key = { PK: importPk(batchId), SK: META_SK };
  const updateExpression =
    "SET #status = :processing, processingStartedAt = :now, processingOwner = :owner, updatedAt = :now, confirmedAt = :now, confirmedBy = :by";
  const names = { "#status": "status" };
  const baseValues = {
    ":processing": IMPORT_STATUSES.PROCESSING,
    ":now": now,
    ":owner": owner,
    ":by": confirmedBy,
  };

  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        ConditionExpression:
          "#status = :ready OR #status = :partial OR #status = :failed",
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: {
          ...baseValues,
          ":ready": IMPORT_STATUSES.READY,
          ":partial": IMPORT_STATUSES.PARTIAL,
          ":failed": IMPORT_STATUSES.FAILED,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    await syncImportHistory(ddb, tableName, res.Attributes);
    return { ok: true, meta: res.Attributes };
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }

  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        ConditionExpression:
          "#status = :processing AND (attribute_not_exists(processingStartedAt) OR processingStartedAt < :stale)",
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: {
          ...baseValues,
          ":stale": staleIso,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    await syncImportHistory(ddb, tableName, res.Attributes);
    return { ok: true, meta: res.Attributes, reclaimed: true };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { ok: false };
    }
    throw err;
  }
}

async function maybeSendCompletedImportSummary(opts) {
  try {
    return await sendCompletedImportSummaryEmail(opts);
  } catch (err) {
    console.error(
      "TASK_IMPORT_SUMMARY_ERROR",
      JSON.stringify({ batchId: opts?.batchId || null })
    );
    console.error(err);
    return { skipped: true, reason: "UNHANDLED" };
  }
}

async function respondCompletedImport({
  ddb,
  tableName,
  accessTable,
  meta,
  now,
  nowMs,
  listAccessRows,
}) {
  const response = await confirmResponseFromRows(ddb, tableName, meta);
  await maybeSendCompletedImportSummary({
    ddb,
    tableName,
    accessTable,
    batchId: meta.batchId,
    tasks: response.body.tasks || [],
    now,
    nowMs,
    listAccessRows,
  });
  return response;
}

async function handleConfirmRequest({
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
  listAccessRows,
} = {}) {
  const auth = await authorizeImportOperator({ user, ddb, accessTable });
  if (!auth.ok) {
    return { statusCode: auth.statusCode, body: auth.body };
  }
  if (!escalation.normalizeEmail(user.email)) {
    return { statusCode: 401, body: { error: "Unauthorized" } };
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

  const existingMeta = await getMeta(ddb, tableName, id);
  if (!existingMeta || existingMeta.type !== TYPE_TASK_IMPORT) {
    return { statusCode: 404, body: { error: "Import batch not found." } };
  }
  const actor = escalation.normalizeEmail(user.email);
  if (!actor || actor !== escalation.normalizeEmail(existingMeta.uploadedBy)) {
    return { statusCode: 403, body: { error: "Forbidden" } };
  }

  const current = String(existingMeta.status || "").toUpperCase();
  if (current === IMPORT_STATUSES.NEEDS_FIX || current === IMPORT_STATUSES.UPLOADED) {
    return {
      statusCode: 400,
      body: {
        error: "Import is not ready to confirm. Fix validation errors and preview again.",
        status: existingMeta.status,
      },
    };
  }
  if (current === IMPORT_STATUSES.COMPLETED) {
    return respondCompletedImport({
      ddb,
      tableName,
      accessTable,
      meta: existingMeta,
      now,
      nowMs,
      listAccessRows,
    });
  }

  const updatedAt = now || new Date().toISOString();
  const clockMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (
    current === IMPORT_STATUSES.PROCESSING &&
    !isProcessingLeaseStale(existingMeta, clockMs)
  ) {
    return confirmResponseFromRows(ddb, tableName, existingMeta);
  }

  const owner = crypto.randomUUID();
  const claimed = await claimBatchForProcessing(
    ddb,
    tableName,
    id,
    updatedAt,
    owner,
    actor,
    clockMs
  );
  if (!claimed.ok) {
    const latest = await getMeta(ddb, tableName, id);
    if (!latest) {
      return { statusCode: 404, body: { error: "Import batch not found." } };
    }
    if (latest.status === IMPORT_STATUSES.COMPLETED) {
      return respondCompletedImport({
        ddb,
        tableName,
        accessTable,
        meta: latest,
        now,
        nowMs,
        listAccessRows,
      });
    }
    if (
      latest.status === IMPORT_STATUSES.PROCESSING &&
      !isProcessingLeaseStale(latest, clockMs)
    ) {
      return confirmResponseFromRows(ddb, tableName, latest);
    }
    if (
      latest.status === IMPORT_STATUSES.NEEDS_FIX ||
      latest.status === IMPORT_STATUSES.UPLOADED
    ) {
      return {
        statusCode: 400,
        body: {
          error: "Import is not ready to confirm. Fix validation errors and preview again.",
          status: latest.status,
        },
      };
    }
    return {
      statusCode: 409,
      body: { error: "This import cannot be confirmed in its current state.", status: latest.status },
    };
  }

  const meta = claimed.meta || existingMeta;
  const s3Key = meta.s3Key || buildS3Key(meta.uploadedBy, id);
  let buffer;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
    buffer = await streamToBuffer(obj.Body);
  } catch (err) {
    if (isS3NotFound(err)) {
      const failed = {
        ...withoutProcessingLease(meta),
        status: IMPORT_STATUSES.FAILED,
        updatedAt,
      };
      await putMeta(ddb, tableName, failed);
      await cleanupNonEligibleOriginal({
        ddb,
        s3,
        tableName,
        bucket,
        meta: failed,
        now: updatedAt,
      });
      return { statusCode: 404, body: { error: "Import file not found." } };
    }
    throw err;
  }

  const resolved = await parseAndResolveWorkbook({
    buffer,
    ddb,
    tableName,
    accessTable,
    nowMs: clockMs,
    listProjects,
    loadUserAccess,
    user,
  });

  if (
    resolved.status !== IMPORT_STATUSES.READY ||
    !resolved.rows.length ||
    resolved.invalidRows > 0 ||
    (resolved.parsed.errors || []).length
  ) {
    await replaceRowRecords({
      ddb,
      tableName,
      batchId: id,
      rows: resolved.rows,
      now: updatedAt,
    });
    await putMeta(ddb, tableName, {
      ...withoutProcessingLease(meta),
      status: IMPORT_STATUSES.NEEDS_FIX,
      totalRows: resolved.rows.length,
      validRows: resolved.validRows,
      invalidRows: resolved.invalidRows,
      warningCount: resolved.warningCount,
      auditEligibility: AUDIT_ELIGIBILITY.INELIGIBLE,
      updatedAt,
    });
    return {
      statusCode: 400,
      body: {
        error: "Import is not ready to confirm. Fix validation errors and preview again.",
        status: IMPORT_STATUSES.NEEDS_FIX,
        batchId: id,
        totalRows: resolved.rows.length,
        validRows: resolved.validRows,
        invalidRows: resolved.invalidRows,
        warningCount: resolved.warningCount,
        errors: resolved.parsed.errors || [],
        rows: resolved.rows.map(publicRow),
      },
    };
  }

  const storedRows = await listExistingRowItems(ddb, tableName, id);
  const storedByNumber = new Map(storedRows.map((item) => [item.rowNumber, item]));
  const createdByName =
    user.createdByName || escalation.displayNameFromEmail(user.email);
  const tasks = [];
  const failures = [];
  const importCache = createCache();
  for (const row of resolved.rows) {
    try {
      const stored = storedByNumber.get(row.rowNumber);
      if (stored?.status === ROW_IMPORTED && stored.taskId) {
        tasks.push(rowResultFromImported(stored));
        continue;
      }
      const emails = (row.resolvedAssignees || []).map((item) => item.email);
      const rowAuth = await authorizeImportRowCreate({
        ddb,
        tableName,
        accessTable,
        user,
        projectId: row.projectId,
        emails,
        cache: importCache,
      });
      if (!rowAuth.ok) {
        failures.push({
          rowNumber: row.rowNumber,
          message: "Unable to import this row.",
        });
        continue;
      }
      if (!rowAuth.allowed) {
        failures.push({
          rowNumber: row.rowNumber,
          message: "Cannot import tasks into this project.",
        });
        continue;
      }
      const mode = String(row.values.assignmentMode || "").toUpperCase();
      const result =
        mode === "SCHEDULED"
          ? await createScheduledTask({
              ddb,
              tableName,
              row,
              batchId: id,
              user: { email: actor },
              createdByName,
              now: updatedAt,
            })
          : await createImmediateTask({
              ddb,
              tableName,
              row,
              batchId: id,
              user: { email: actor },
              createdByName,
              now: updatedAt,
              nowMs: clockMs,
              accessTable,
              listAccessRows,
            });
      await markRowImported(ddb, tableName, id, row, result, updatedAt);
      tasks.push({
        rowNumber: row.rowNumber,
        taskId: result.taskId,
        assignmentMode: result.assignmentMode,
        status: result.status,
      });
    } catch (err) {
      failures.push({
        rowNumber: row.rowNumber,
        message: err?.message || "Failed to import row.",
      });
    }
  }

  const successCount = tasks.length;
  const failureCount = failures.length;
  const status =
    failureCount === 0
      ? IMPORT_STATUSES.COMPLETED
      : successCount > 0
        ? IMPORT_STATUSES.PARTIAL
        : IMPORT_STATUSES.FAILED;
  await putMeta(ddb, tableName, {
    ...withoutProcessingLease(meta),
    status,
    totalRows: resolved.rows.length,
    validRows: resolved.validRows,
    invalidRows: 0,
    warningCount: resolved.warningCount,
    processedRows: successCount + failureCount,
    successCount,
    failureCount,
    confirmedAt: meta.confirmedAt || updatedAt,
    confirmedBy: actor,
    completedAt: status === IMPORT_STATUSES.COMPLETED ? updatedAt : null,
    auditEligibility:
      status === IMPORT_STATUSES.COMPLETED
        ? meta.auditEligibility || AUDIT_ELIGIBILITY.INELIGIBLE
        : AUDIT_ELIGIBILITY.INELIGIBLE,
    updatedAt,
  });
  if (status === IMPORT_STATUSES.COMPLETED) {
    try {
      await promoteImportAudit({
        ddb,
        s3,
        tableName,
        bucket,
        batchId: id,
        now: updatedAt,
        nowMs: clockMs,
      });
    } catch (err) {
      console.error(
        "TASK_IMPORT_AUDIT_PROMOTE_ERROR",
        JSON.stringify({ batchId: id })
      );
      console.error(err);
    }
    await maybeSendCompletedImportSummary({
      ddb,
      tableName,
      accessTable,
      batchId: id,
      tasks,
      now: updatedAt,
      nowMs: clockMs,
      listAccessRows,
    });
  }

  let latest = {};
  try {
    latest = (await getMeta(ddb, tableName, id)) || {};
  } catch (err) {
    console.error(
      "TASK_IMPORT_CONFIRM_META_READ_ERROR",
      JSON.stringify({ batchId: id })
    );
    console.error(err);
  }
  return {
    statusCode: 200,
    body: {
      batchId: id,
      status,
      auditEligibility: latest.auditEligibility || null,
      totalRows: resolved.rows.length,
      successCount,
      failureCount,
      failures,
      tasks,
    },
  };
}

function uniqueCodes(list) {
  const seen = new Set();
  const out = [];
  for (const value of list || []) {
    const code = String(value || "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function uniqueEmails(list) {
  const seen = new Set();
  const out = [];
  for (const value of list || []) {
    const email = escalation.normalizeEmail(value);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function assignedEmailSet(task) {
  const emails = [
    ...(task?.assignees || []),
    ...((task?.assignments || [])
      .filter((row) => row && !row.removed)
      .map((row) => row.email)),
  ];
  return new Set(uniqueEmails(emails));
}

function remainingPendingEmails(task) {
  const assigned = assignedEmailSet(task);
  const pending = uniqueEmails(
    task?.pendingAssignees && task.pendingAssignees.length
      ? task.pendingAssignees
      : task?.assignees || []
  );
  return pending.filter((email) => !assigned.has(email));
}

function existingAssignmentList(task) {
  if (Array.isArray(task?.assignments) && task.assignments.length) {
    return task.assignments.filter((row) => row && !row.removed);
  }
  return uniqueEmails(task?.assignees || []).map((email) => ({
    email,
    status: "TODO",
    assignedAt: task.updatedAt || task.createdAt || new Date().toISOString(),
    assignedBy: escalation.normalizeEmail(task.createdBy) || "",
  }));
}

function isAccessLookupFailure(err) {
  return (
    err instanceof AccessLookupError ||
    err?.name === "AccessLookupError" ||
    err?.code === "SCHEDULED_ACL_LOOKUP_FAILED"
  );
}

async function classifyScheduledAssignees({
  ddb,
  tableName,
  accessTable,
  attendanceTable,
  task,
  emails,
  loadUserAccess,
}) {
  const pending = uniqueEmails(emails);
  const skipped = [];
  const eligible = [];
  for (const email of pending) {
    const access = await getAccessRow(ddb, accessTable, email, loadUserAccess);
    if (isActiveAccess(access)) eligible.push(email);
    else skipped.push(email);
  }
  const membership = await filterScheduledAssignees({
    ddb,
    tableName,
    task,
    emails: eligible,
  });
  if (!membership.ok) {
    const err = new Error("SCHEDULED_ACL_LOOKUP_FAILED");
    err.code = "SCHEDULED_ACL_LOOKUP_FAILED";
    throw err;
  }
  skipped.push(...membership.skipped);
  const assignNow = [];
  const postpone = [];
  const conflict = [];
  const attendanceStatusByEmail = {};
  const fitByEmail = {};
  const reasons = [];
  const range = taskEvaluationRange(task);
  for (const email of membership.active) {
    const decision = await attendanceDecisionForEmployee({
      ddb,
      attendanceTable,
      email,
      task,
    });
    attendanceStatusByEmail[email] = decision.attendanceStatus;
    if (decision.action === ACTION_POSTPONE) {
      postpone.push(email);
      reasons.push(decision.reason);
      continue;
    }
    const fit = await assignedShiftFit(ddb, tableName, {
      email,
      taskStart: range.startMs,
      taskEnd: range.endMs,
      evaluatedAt: task.scheduledAssignAt || range.startMs,
    });
    fitByEmail[email] = fit.result;
    if (fit.result === ASSIGNED_SHIFT_FIT.FIT) {
      assignNow.push(email);
    } else {
      conflict.push(email);
    }
  }
  return {
    skipped: uniqueEmails(skipped),
    assignNow,
    postpone,
    conflict,
    fitByEmail,
    attendanceStatusByEmail,
    reasons: uniqueCodes(reasons),
  };
}

async function postponeScheduledTask({
  ddb,
  tableName,
  task,
  nowIso,
  nowMs,
  postponedEmails,
  reasons,
  attendanceStatusByEmail,
  moveTaskDates,
}) {
  if (!ddb || !tableName || !task?.taskId) return { ok: false };
  const expectedAssignAt = task.scheduledAssignAt;
  const next = nextScheduleFields(task, { moveTaskDates });
  const count = Number(task.postponementCount || 0) + 1;
  const reason = uniqueCodes(reasons).join(",") || "UNAVAILABLE";
  const state = String(task.assignmentState || "").toUpperCase();
  const names = { "#mode": "assignmentMode" };
  const values = {
    ":scheduled": "SCHEDULED",
    ":expected": expectedAssignAt,
    ":nextAssign": next.scheduledAssignAt,
    ":count": count,
    ":now": nowIso,
    ":reason": reason,
    ":statusMap": attendanceStatusByEmail || {},
    ":pending": ASSIGNMENT_PENDING,
  };
  let condition =
    "#mode = :scheduled AND assignmentState = :pending AND scheduledAssignAt = :expected";
  let updateExpression =
    "SET scheduledAssignAt = :nextAssign, postponementCount = :count, lastPostponementAt = :now, lastPostponementReason = :reason, lastAttendanceStatusByEmail = :statusMap, updatedAt = :now";
  if (moveTaskDates) {
    updateExpression += ", startDate = :nextStart, dueDate = :nextDue";
    values[":nextStart"] = next.startDate;
    values[":nextDue"] = next.dueDate;
  }
  if (!task.originalStartDate) {
    updateExpression +=
      ", originalStartDate = :origStart, originalDueDate = :origDue, originalScheduledAssignAt = :origAssign";
    values[":origStart"] = task.startDate;
    values[":origDue"] = task.dueDate;
    values[":origAssign"] = task.scheduledAssignAt;
  }
  if (state === ASSIGNMENT_ASSIGNED) {
    condition =
      "#mode = :scheduled AND assignmentState = :assigned AND scheduledAssignAt = :expected";
    values[":assigned"] = ASSIGNMENT_ASSIGNED;
  } else if (state === ASSIGNMENT_ASSIGNING) {
    const staleIso = new Date(nowMs - scheduledAssignLeaseMs()).toISOString();
    condition =
      "#mode = :scheduled AND assignmentState = :assigning AND scheduledAssignAt = :expected AND (attribute_not_exists(assigningStartedAt) OR assigningStartedAt < :stale)";
    values[":assigning"] = ASSIGNMENT_ASSIGNING;
    values[":stale"] = staleIso;
    updateExpression += ", assignmentState = :pending";
    updateExpression += " REMOVE assigningStartedAt, assigningOwner";
  } else {
    updateExpression += ", assignmentState = :pending";
  }
  if (Array.isArray(postponedEmails)) {
    updateExpression = updateExpression.replace(
      "SET ",
      "SET pendingAssignees = :pendingEmails, "
    );
    values[":pendingEmails"] = uniqueEmails(postponedEmails);
  }
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: "ENTITY#TASK", SK: `TASK#${task.taskId}` },
        ConditionExpression: condition,
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );
    const updated = {
      ...(res.Attributes || {}),
      PK: "ENTITY#TASK",
      SK: `TASK#${task.taskId}`,
    };
    await putTaskCopies(ddb, tableName, updated);
    return { ok: true, task: updated, previous: task, next, count, reason };
  } catch (err) {
    if (isConditionalCheckFailed(err)) return { ok: false, conflict: true };
    throw err;
  }
}

async function persistUnassignedShiftConflict({
  ddb,
  tableName,
  task,
  nowIso,
  nowMs,
  conflictEmails,
  fitByEmail,
}) {
  if (!ddb || !tableName || !task?.taskId) return { ok: false };
  const expectedAssignAt = task.scheduledAssignAt;
  const state = String(task.assignmentState || "").toUpperCase();
  const names = { "#mode": "assignmentMode" };
  const values = {
    ":scheduled": "SCHEDULED",
    ":expected": expectedAssignAt,
    ":now": nowIso,
    ":pendingEmails": uniqueEmails(conflictEmails),
    ":fitMap": fitByEmail || {},
  };
  let condition =
    "#mode = :scheduled AND assignmentState = :pending AND scheduledAssignAt = :expected";
  let updateExpression =
    "SET pendingAssignees = :pendingEmails, lastShiftFitByEmail = :fitMap, updatedAt = :now, assignmentState = :pending";
  values[":pending"] = ASSIGNMENT_PENDING;
  if (state === ASSIGNMENT_ASSIGNED) {
    condition =
      "#mode = :scheduled AND assignmentState = :assigned AND scheduledAssignAt = :expected";
    values[":assigned"] = ASSIGNMENT_ASSIGNED;
    updateExpression =
      "SET pendingAssignees = :pendingEmails, lastShiftFitByEmail = :fitMap, updatedAt = :now";
  } else if (state === ASSIGNMENT_ASSIGNING) {
    const staleIso = new Date(nowMs - scheduledAssignLeaseMs()).toISOString();
    condition =
      "#mode = :scheduled AND assignmentState = :assigning AND scheduledAssignAt = :expected AND (attribute_not_exists(assigningStartedAt) OR assigningStartedAt < :stale)";
    values[":assigning"] = ASSIGNMENT_ASSIGNING;
    values[":stale"] = staleIso;
    updateExpression += " REMOVE assigningStartedAt, assigningOwner";
  }
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: "ENTITY#TASK", SK: `TASK#${task.taskId}` },
        ConditionExpression: condition,
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );
    const updated = {
      ...(res.Attributes || {}),
      PK: "ENTITY#TASK",
      SK: `TASK#${task.taskId}`,
    };
    await putTaskCopies(ddb, tableName, updated);
    return { ok: true, task: updated };
  } catch (err) {
    if (isConditionalCheckFailed(err)) return { ok: false, conflict: true };
    throw err;
  }
}

async function notifyPostponeIfNeeded({
  ddb,
  accessTable,
  listAccessRows,
  task,
  postponedEmails,
  previousStart,
  previousDue,
  previousScheduledAssignAt,
  nextStart,
  nextDue,
  reasons,
  attendanceStatusByEmail,
  postponementCount,
}) {
  if (!postponedEmails?.length) return;
  await notifyScheduledPostponement({
    ddb,
    accessTable,
    listAccessRows,
    task,
    postponedEmails,
    previousStart,
    previousDue,
    previousScheduledAssignAt,
    nextStart,
    nextDue,
    reasons,
    attendanceStatusByEmail,
    postponementCount,
  });
}

async function notifyShiftConflictIfNeeded({
  ddb,
  accessTable,
  tableName,
  listAccessRows,
  task,
  conflictEmails,
  fitByEmail,
}) {
  if (!conflictEmails?.length) return;
  try {
    return await notifyScheduledShiftConflicts({
      ddb,
      accessTable,
      tableName,
      listAccessRows,
      task,
      conflictEmails,
      fitByEmail,
    });
  } catch (err) {
    console.error(
      "TASK_SCHEDULED_SHIFT_CONFLICT_NOTIFY_ERROR",
      JSON.stringify({ taskId: task?.taskId || null })
    );
    console.error(err);
    return { skipped: true, reason: "UNHANDLED" };
  }
}

async function skipInactiveScheduledAssignment(
  ddb,
  tableName,
  task,
  skippedEmails,
  nowIso
) {
  const next = {
    ...task,
    assignmentState: ASSIGNMENT_SKIPPED,
    assignmentSkipReason: "EMPLOYEE_INACTIVE",
    assignmentSkippedEmails: skippedEmails,
    assignmentSkippedAt: nowIso,
    updatedAt: nowIso,
  };
  delete next.assigningStartedAt;
  delete next.assigningOwner;
  await putTaskCopies(ddb, tableName, next);
  const actor = escalation.normalizeEmail(task.createdBy) || "";
  await appendActivity(
    ddb,
    tableName,
    task.taskId,
    "task_assignment_skipped",
    `Scheduled assignment skipped; inactive employee(s): ${skippedEmails.join(", ")}`,
    actor,
    {
      timestamp: nowIso,
      actorName: task.createdByName || "",
      skippedEmails,
    }
  );
  console.warn(
    "TASK_IMPORT_SCHEDULED_SKIPPED_INACTIVE",
    JSON.stringify({
      taskId: task.taskId,
      skippedEmails,
    })
  );
  return next;
}

async function activateScheduledTask(
  ddb,
  tableName,
  task,
  nowMs,
  nowIso,
  {
    accessTable,
    listAccessRows,
    loadUserAccess,
    emailsToAssign,
    remainingPending,
  } = {}
) {
  const emails = uniqueEmails(
    emailsToAssign || task.pendingAssignees || task.assignees || []
  );
  const leftover = uniqueEmails(remainingPending || []);
  const active = [];
  const skipped = [];
  for (const email of emails) {
    // Missing row (null) and non-ACTIVE status are inactive → SKIPPED.
    // Lookup/runtime errors throw and leave ASSIGNING for lease retry.
    const access = await getAccessRow(ddb, accessTable, email, loadUserAccess);
    if (isActiveAccess(access)) active.push(email);
    else skipped.push(email);
  }
  const membership = await filterScheduledAssignees({
    ddb,
    tableName,
    task,
    emails: active,
  });
  if (!membership.ok) {
    const err = new Error("SCHEDULED_ACL_LOOKUP_FAILED");
    err.code = "SCHEDULED_ACL_LOOKUP_FAILED";
    throw err;
  }
  skipped.push(...membership.skipped);
  const memberActive = membership.active.filter(
    (email) => !assignedEmailSet(task).has(email)
  );
  const assignedBy =
    escalation.normalizeEmail(task.createdBy) ||
    escalation.normalizeEmail(task.assignedBy) ||
    "";
  if (!memberActive.length && !leftover.length) {
    const skippedTask = await skipInactiveScheduledAssignment(
      ddb,
      tableName,
      task,
      skipped.length ? skipped : emails,
      nowIso
    );
    if (membership.skipped.length) {
      skippedTask.assignmentSkipReason = "NOT_PROJECT_MEMBER";
      await putTaskCopies(ddb, tableName, skippedTask);
    }
    return skippedTask;
  }
  const newAssignments = memberActive.map((email) => ({
    email,
    status: "TODO",
    assignedAt: nowIso,
    assignedBy,
    recordedZone: escalation.zoneAt(
      escalation.parseDeadlineMs(task.dueDate),
      nowMs
    ),
  }));
  const allAssignments = [...existingAssignmentList(task), ...newAssignments];
  const next = snapshotTask(
    {
      ...task,
      assignmentState: memberActive.length || alreadyAssignedState(task)
        ? ASSIGNMENT_ASSIGNED
        : task.assignmentState,
      pendingAssignees: leftover,
      assignmentSkipReason: skipped.length ? "EMPLOYEE_INACTIVE" : undefined,
      assignmentSkippedEmails: skipped.length ? skipped : undefined,
      assignmentSkippedAt: skipped.length ? nowIso : undefined,
      updatedAt: nowIso,
    },
    allAssignments
  );
  delete next.assigningStartedAt;
  delete next.assigningOwner;
  if (memberActive.length) {
    await persistAssignmentsAndTask(ddb, tableName, next, allAssignments);
  } else {
    await putTaskCopies(ddb, tableName, next);
  }
  if (skipped.length) {
    await appendActivity(
      ddb,
      tableName,
      task.taskId,
      "task_assignment_skipped",
      `Scheduled assignment skipped for inactive employee(s): ${skipped.join(", ")}`,
      assignedBy,
      {
        timestamp: nowIso,
        actorName: task.createdByName || "",
        skippedEmails: skipped,
      }
    );
  }
  if (memberActive.length) {
    await appendActivity(
      ddb,
      tableName,
      task.taskId,
      "task_assigned",
      `Assigned to ${memberActive.join(", ")}`,
      assignedBy,
      {
        timestamp: nowIso,
        actorName: task.createdByName || "",
      }
    );
    await notifyExcelAssignment({
      ddb,
      tableName,
      accessTable,
      listAccessRows,
      kind: "scheduled",
      assigneeEmails: memberActive,
      task: {
        taskId: task.taskId,
        title: task.title,
        importBatchId: task.importBatchId,
        createdBy: assignedBy,
        createdByName: task.createdByName,
        projectId: task.projectId,
      },
    });
  }
  return next;
}

async function claimScheduledActivation(ddb, tableName, task, nowIso, nowMs, owner) {
  const key = { PK: "ENTITY#TASK", SK: `TASK#${task.taskId}` };
  const staleIso = new Date(nowMs - scheduledAssignLeaseMs()).toISOString();
  const updateExpression =
    "SET assignmentState = :assigning, assigningStartedAt = :now, assigningOwner = :owner, updatedAt = :now";
  const names = { "#mode": "assignmentMode" };

  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        ConditionExpression: "#mode = :scheduled AND assignmentState = :pending",
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: {
          ":scheduled": "SCHEDULED",
          ":pending": ASSIGNMENT_PENDING,
          ":assigning": ASSIGNMENT_ASSIGNING,
          ":now": nowIso,
          ":owner": owner,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    return { ok: true, task: res.Attributes };
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }

  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        ConditionExpression:
          "#mode = :scheduled AND assignmentState = :assigning AND (attribute_not_exists(assigningStartedAt) OR assigningStartedAt < :stale)",
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: {
          ":scheduled": "SCHEDULED",
          ":assigning": ASSIGNMENT_ASSIGNING,
          ":stale": staleIso,
          ":now": nowIso,
          ":owner": owner,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    return { ok: true, task: res.Attributes, reclaimed: true };
  } catch (err) {
    if (isConditionalCheckFailed(err)) return { ok: false };
    throw err;
  }
}

async function processDueScheduledTask({
  ddb,
  tableName,
  accessTable,
  attendanceTable,
  task,
  nowMs,
  nowIso,
  listAccessRows,
  loadUserAccess,
  claim,
}) {
  const emails = remainingPendingEmails(task);
  if (!emails.length) return 0;
  let decision;
  try {
    decision = await classifyScheduledAssignees({
      ddb,
      tableName,
      accessTable,
      attendanceTable,
      task,
      emails,
      loadUserAccess,
    });
  } catch (err) {
    if (!claim || !isAccessLookupFailure(err)) {
      console.error(
        "SCHEDULED_ASSIGN_ERROR",
        JSON.stringify({ taskId: task.taskId || "" })
      );
      console.error(err);
      return 0;
    }
    const claimed = await claimScheduledActivation(
      ddb,
      tableName,
      task,
      nowIso,
      nowMs,
      crypto.randomUUID()
    );
    if (!claimed.ok) return 0;
    try {
      await activateScheduledTask(ddb, tableName, claimed.task, nowMs, nowIso, {
        accessTable,
        listAccessRows,
        loadUserAccess,
      });
      return 1;
    } catch (activateErr) {
      console.error(
        "SCHEDULED_ASSIGN_ERROR",
        JSON.stringify({ taskId: task.taskId || "" })
      );
      console.error(activateErr);
      return 0;
    }
  }

  if (!decision.assignNow.length && !decision.postpone.length) {
    if (decision.conflict.length) {
      const persisted = await persistUnassignedShiftConflict({
        ddb,
        tableName,
        task,
        nowIso,
        nowMs,
        conflictEmails: decision.conflict,
        fitByEmail: decision.fitByEmail,
      });
      if (persisted.ok) {
        await notifyShiftConflictIfNeeded({
          ddb,
          accessTable,
          tableName,
          listAccessRows,
          task: persisted.task || task,
          conflictEmails: decision.conflict,
          fitByEmail: decision.fitByEmail,
        });
        return 1;
      }
      return 0;
    }
    if (!claim) {
      const next = {
        ...task,
        pendingAssignees: [],
        assignmentSkippedEmails: decision.skipped,
        assignmentSkippedAt: nowIso,
        assignmentSkipReason: "EMPLOYEE_INACTIVE",
        updatedAt: nowIso,
      };
      await putTaskCopies(ddb, tableName, next);
      return 1;
    }
    const claimed = await claimScheduledActivation(
      ddb,
      tableName,
      task,
      nowIso,
      nowMs,
      crypto.randomUUID()
    );
    if (!claimed.ok) return 0;
    await activateScheduledTask(ddb, tableName, claimed.task, nowMs, nowIso, {
      accessTable,
      listAccessRows,
      loadUserAccess,
    });
    return 1;
  }

  if (!decision.assignNow.length && decision.postpone.length) {
    const postponed = await postponeScheduledTask({
      ddb,
      tableName,
      task,
      nowIso,
      nowMs,
      postponedEmails: uniqueEmails([
        ...decision.postpone,
        ...(decision.conflict || []),
      ]),
      reasons: decision.reasons,
      attendanceStatusByEmail: decision.attendanceStatusByEmail,
      moveTaskDates: !alreadyAssignedState(task),
    });
    if (!postponed.ok) return 0;
    await notifyPostponeIfNeeded({
      ddb,
      accessTable,
      listAccessRows,
      task,
      postponedEmails: decision.postpone,
      previousStart: task.startDate,
      previousDue: task.dueDate,
      previousScheduledAssignAt: task.scheduledAssignAt,
      nextStart: postponed.next.startDate,
      nextDue: postponed.next.dueDate,
      reasons: decision.reasons,
      attendanceStatusByEmail: decision.attendanceStatusByEmail,
      postponementCount: postponed.count,
    });
    await notifyShiftConflictIfNeeded({
      ddb,
      accessTable,
      tableName,
      listAccessRows,
      task,
      conflictEmails: decision.conflict,
      fitByEmail: decision.fitByEmail,
    });
    return 1;
  }

  let current = task;
  if (claim) {
    const claimed = await claimScheduledActivation(
      ddb,
      tableName,
      task,
      nowIso,
      nowMs,
      crypto.randomUUID()
    );
    if (!claimed.ok) return 0;
    current = claimed.task;
  }
  try {
    const assignedTask = await activateScheduledTask(
      ddb,
      tableName,
      current,
      nowMs,
      nowIso,
      {
        accessTable,
        listAccessRows,
        loadUserAccess,
        emailsToAssign: decision.assignNow,
        remainingPending: uniqueEmails([
          ...decision.postpone,
          ...(decision.conflict || []),
        ]),
      }
    );
    if (decision.conflict.length && assignedTask) {
      assignedTask.lastShiftFitByEmail = decision.fitByEmail;
      await putTaskCopies(ddb, tableName, assignedTask);
      await notifyShiftConflictIfNeeded({
        ddb,
        accessTable,
        tableName,
        listAccessRows,
        task: assignedTask,
        conflictEmails: decision.conflict,
        fitByEmail: decision.fitByEmail,
      });
    }
    if (decision.postpone.length) {
      const postponed = await postponeScheduledTask({
        ddb,
        tableName,
        task: assignedTask,
        nowIso,
        nowMs,
        postponedEmails: uniqueEmails([
          ...decision.postpone,
          ...(decision.conflict || []),
        ]),
        reasons: decision.reasons,
        attendanceStatusByEmail: decision.attendanceStatusByEmail,
        moveTaskDates: false,
      });
      if (postponed.ok) {
        await notifyPostponeIfNeeded({
          ddb,
          accessTable,
          listAccessRows,
          task: assignedTask,
          postponedEmails: decision.postpone,
          previousStart: assignedTask.startDate,
          previousDue: assignedTask.dueDate,
          previousScheduledAssignAt: assignedTask.scheduledAssignAt,
          nextStart: postponed.next.startDate,
          nextDue: postponed.next.dueDate,
          reasons: decision.reasons,
          attendanceStatusByEmail: decision.attendanceStatusByEmail,
          postponementCount: postponed.count,
        });
      }
    }
    return 1;
  } catch (err) {
    console.error(
      "SCHEDULED_ASSIGN_ERROR",
      JSON.stringify({ taskId: task.taskId || "" })
    );
    console.error(err);
    return 0;
  }
}

async function assignDueScheduledTasks({
  ddb,
  tableName = process.env.WORK_TABLE,
  accessTable = process.env.USER_ACCESS_TABLE,
  attendanceTable = process.env.ATTENDANCE_TABLE,
  nowMs = Date.now(),
  listAccessRows,
  loadUserAccess,
} = {}) {
  if (!tableName) return { processed: 0 };
  const { queryAll } = require("./taskImportPreview");
  const tasks = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
  });
  const nowIso = new Date(nowMs).toISOString();
  let processed = 0;
  for (const task of tasks) {
    if (task.archived) continue;
    if (String(task.assignmentMode || "").toUpperCase() !== "SCHEDULED") continue;
    const state = String(task.assignmentState || "").toUpperCase();
    const due = Date.parse(task.scheduledAssignAt || "");
    if (!Number.isFinite(due) || due > nowMs) continue;
    if (state === ASSIGNMENT_ASSIGNED) {
      if (!remainingPendingEmails(task).length) continue;
      processed += await processDueScheduledTask({
        ddb,
        tableName,
        accessTable,
        attendanceTable,
        task,
        nowMs,
        nowIso,
        listAccessRows,
        loadUserAccess,
        claim: false,
      });
      continue;
    }
    if (state !== ASSIGNMENT_PENDING && state !== ASSIGNMENT_ASSIGNING) continue;
    if (state === ASSIGNMENT_ASSIGNING && !isAssigningLeaseStale(task, nowMs)) {
      continue;
    }
    processed += await processDueScheduledTask({
      ddb,
      tableName,
      accessTable,
      attendanceTable,
      task,
      nowMs,
      nowIso,
      listAccessRows,
      loadUserAccess,
      claim: true,
    });
  }
  return { processed };
}

module.exports = {
  ROW_IMPORTED,
  ASSIGNMENT_PENDING,
  ASSIGNMENT_ASSIGNING,
  ASSIGNMENT_ASSIGNED,
  ASSIGNMENT_SKIPPED,
  BATCH_ID_RE,
  confirmPathMatch,
  importedTaskId,
  assignedNotifyKey,
  isPendingScheduledTask,
  isProcessingLeaseStale,
  isAssigningLeaseStale,
  processingLeaseMs,
  scheduledAssignLeaseMs,
  handleConfirmRequest,
  assignDueScheduledTasks,
  promoteWaitingImportAudits: require("./taskImportAudit").promoteWaitingImportAudits,
  activateScheduledTask,
  claimBatchForProcessing,
  claimScheduledActivation,
  postponeScheduledTask,
  remainingPendingEmails,
};

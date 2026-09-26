const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { randomUUID } = require("crypto");
const escalation = require("./escalation");
const { zoneNotifyCopy } = require("./zoneNotify");
const { notifyAdminsTaskEnteredRed, claimRedAdminNotify, finalizeRedAdminNotify, persistRedAdminRecipient } = require("./redAdminNotify");
const { activeAdminEmailsFromAccess, activeCompletionAdminEmailsFromAccess } = require("../common/roles");
const {
  putTaskCopiesSafe,
  putAssignmentSafe,
  putCreatedTaskRecords,
  assertPersistOk,
  PersistConflictError,
} = require("./taskNotifyPersist");
const taskImport = require("./taskImport");
const taskImportPreview = require("./taskImportPreview");
const taskImportConfirm = require("./taskImportConfirm");
const projectManage = require("./projectManage");
const taskImportHistory = require("./taskImportHistory");
const { notifyTaskCompleted } = require("./taskCompleteNotify");
const { notifyTaskSubmittedForReview } = require("./taskReviewNotify");
const taskReadAccess = require("./taskReadAccess");
const taskMutateAccess = require("./taskMutateAccess");
const workflowAccess = require("./workflowAccess");
const shiftCatalog = require("./shiftCatalog");
const myActivity = require("./myActivity");
const { notifyBlockerReported } = require("./taskBlockerNotify");
const {
  putChangesAssignedShiftFit,
  shiftFitConflictBody,
  validateAssigneesAssignedShiftFit,
} = require("./assignedShiftFit");
const taskReviewReassign = require("./taskReviewReassign");
const { materializeTodaysConfirmedLeave } = require("../leave/materialize");
const { canViewTask } = taskReadAccess;
const { requireEligiblePortalAdmin } = require("./portalAdminAuth");

const ddbClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
let ddb = ddbClient;
const s3 = new S3Client({ region: process.env.AWS_REGION });

const STATUSES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "REVIEW",
  "DONE",
  "CANCELLED",
];
const PRIORITIES = escalation.PRIORITIES;
const DURATION_TYPES = ["HOURS", "DAYS", "DATES"];

function parseDuration(body = {}) {
  const type = String(body.durationType || "").toUpperCase();
  if (!DURATION_TYPES.includes(type)) {
    return {
      durationType: null,
      durationHours: null,
      durationDays: null,
      durationStart: null,
      durationEnd: null,
    };
  }
  if (type === "HOURS") {
    const n = Number(body.durationHours);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        durationType: null,
        durationHours: null,
        durationDays: null,
        durationStart: null,
        durationEnd: null,
      };
    }
    return {
      durationType: "HOURS",
      durationHours: n,
      durationDays: null,
      durationStart: null,
      durationEnd: null,
    };
  }
  if (type === "DAYS") {
    const n = Number(body.durationDays);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        durationType: null,
        durationHours: null,
        durationDays: null,
        durationStart: null,
        durationEnd: null,
      };
    }
    return {
      durationType: "DAYS",
      durationHours: null,
      durationDays: n,
      durationStart: null,
      durationEnd: null,
    };
  }
  const start = body.durationStart || null;
  const end = body.durationEnd || null;
  if (!start && !end) {
    return {
      durationType: null,
      durationHours: null,
      durationDays: null,
      durationStart: null,
      durationEnd: null,
    };
  }
  return {
    durationType: "DATES",
    durationHours: null,
    durationDays: null,
    durationStart: start,
    durationEnd: end,
  };
}

function taskPathMatch(path) {
  // /tasks/{taskId}[/sub[/action]] or /prod/tasks/{taskId}[/sub[/action]]
  const m = String(path).match(
    /\/tasks\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/
  );
  if (!m) return null;
  return {
    taskId: decodeURIComponent(m[1]),
    sub: m[2] || null,
    action: m[3] || null,
  };
}

function isOverdue(task) {
  return !!escalation.decorateTask(task, Date.now()).overdue;
}

function isScheduleEvent(event) {
  if (!event || event.httpMethod) return false;
  if (event.taskEscalation === true || event.source === "task-escalation") {
    return true;
  }
  if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
    return true;
  }
  return false;
}

async function getTask(taskId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: { PK: "ENTITY#TASK", SK: `TASK#${taskId}` },
    })
  );
  return res.Item || null;
}

async function putTaskCopies(task) {
  const result = await putTaskCopiesSafe(ddb, process.env.WORK_TABLE, task);
  assertPersistOk(result, {
    op: "putTaskCopies",
    taskId: task?.taskId || "",
    PK: task?.PK || "",
    SK: task?.SK || "",
  });
  return result;
}

async function appendActivity(taskId, action, detail, actorEmail, extra = {}) {
  return appendActivityAt(
    taskId,
    action,
    detail,
    actorEmail,
    extra.timestamp || new Date().toISOString(),
    extra
  );
}

async function appendActivityAt(taskId, action, detail, actorEmail, timestamp, extra = {}) {
  const now = timestamp || new Date().toISOString();
  const id = randomUUID();
  const { timestamp: _ignored, ...rest } = extra || {};
  void _ignored;
  const item = {
    PK: `TASK#${taskId}`,
    SK: `ACTIVITY#${now}#${id}`,
    activityId: id,
    taskId,
    action,
    detail: detail || "",
    actorEmail: actorEmail || "",
    timestamp: now,
    ...rest,
  };
  await ddb.send(
    new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
  );
  return item;
}

async function loadAssignmentItems(taskId) {
  if (!taskId) return [];
  return listByPrefix(`TASK#${taskId}`, "ASSIGNMENT#");
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
    completionRemark: assignment.completionRemark || null,
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

async function writeAssignment(taskId, assignment, options = {}) {
  const item = assignmentRecord(taskId, assignment);
  if (!item) return null;
  void options;
  const result = await putAssignmentSafe(ddb, process.env.WORK_TABLE, item);
  assertPersistOk(result, {
    op: "writeAssignment",
    taskId,
    email: item.email,
    PK: item.PK,
    SK: item.SK,
  });
  return result.item;
}

async function resolveAssignments(task) {
  const stored = await loadAssignmentItems(task.taskId);
  if (stored.length) return stored;
  return escalation.synthesizeAssignments(task);
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
      completionRemark: a.completionRemark || null,
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

function findAssignmentByEmail(assignments, email) {
  const target = escalation.normalizeEmail(email);
  if (!target) return null;
  return (
    (assignments || []).find(
      (a) => escalation.normalizeEmail(a.email) === target && !a.removed
    ) || null
  );
}

function decoratedTaskResponse(task, assignments, viewerEmail) {
  return escalation.decorateTask(
    snapshotTask(task, assignments),
    Date.now(),
    viewerEmail
  );
}

async function handleReportBlocker({ user, task, taskId, body, cache }) {
  const denied = await denyUnlessTaskReadable(user, task, cache);
  if (denied) return denied;
  const actorEmail = escalation.normalizeEmail(user.email);
  if (!actorEmail) return json(401, { error: "Unauthorized" });

  const remark = String(body?.remark ?? "").trim();
  if (!remark) return json(400, { error: "Remark is required" });

  const assignments = await resolveAssignments(task);
  const mine = findAssignmentByEmail(assignments, actorEmail);
  if (!mine) return json(404, { error: "Assignment not found" });

  const status = String(mine.status || "").trim().toUpperCase();
  if (status !== "IN_PROGRESS") {
    return json(400, {
      error: "Blocker can only be reported for an IN_PROGRESS assignment",
    });
  }

  if (
    escalation.normalizeBlockerStatus(mine.blockerStatus) ===
    escalation.BLOCKER_ACTIVE
  ) {
    return json(400, {
      error: "A blocker is already active for this assignment",
    });
  }

  const now = new Date().toISOString();
  mine.blockerStatus = escalation.BLOCKER_ACTIVE;
  mine.blockerRemark = remark;
  mine.blockerReportedAt = now;
  mine.blockerResolvedAt = null;
  mine.blockerResolvedBy = null;
  await writeAssignment(taskId, mine);
  await appendActivity(
    taskId,
    "BLOCKER_REPORTED",
    "Employee reported a blocker",
    actorEmail,
    {
      assignmentEmail: actorEmail,
      blockerRemark: remark,
    }
  );
  try {
    await notifyBlockerReported({
      ddb,
      tableName: process.env.WORK_TABLE,
      accessTable: process.env.USER_ACCESS_TABLE,
      task,
      assignmentEmail: actorEmail,
      remark,
      reportedAt: now,
      listAccessRows: scanAccessRows,
    });
  } catch (err) {
    console.error(
      "TASK_BLOCKER_REPORTED_NOTIFY_ERROR",
      JSON.stringify({ taskId })
    );
    console.error(err);
  }
  return json(200, decoratedTaskResponse(task, assignments, actorEmail));
}

async function handleResolveBlocker({ user, task, taskId, body, cache }) {
  const updateAuth = await taskMutateAccess.authorizeTaskUpdate({
    ...taskReadAuthArgs(user, task, cache),
  });
  const denied = denyAuthz(user, updateAuth);
  if (denied) return denied;
  if (!updateAuth.mayAdminMutate) {
    return json(403, { error: "Forbidden" });
  }

  const targetEmail = escalation.normalizeEmail(body?.assignmentEmail);
  if (!targetEmail) {
    return json(400, { error: "assignmentEmail required" });
  }

  const assignments = await resolveAssignments(task);
  const target = findAssignmentByEmail(assignments, targetEmail);
  if (!target) return json(404, { error: "Assignment not found" });

  if (
    escalation.normalizeBlockerStatus(target.blockerStatus) !==
    escalation.BLOCKER_ACTIVE
  ) {
    return json(400, { error: "No active blocker to resolve" });
  }

  const actorEmail = escalation.normalizeEmail(user.email);
  const now = new Date().toISOString();
  target.blockerStatus = escalation.BLOCKER_RESOLVED;
  target.blockerResolvedAt = now;
  target.blockerResolvedBy = actorEmail;
  await writeAssignment(taskId, target);
  await appendActivity(
    taskId,
    "BLOCKER_RESOLVED",
    "Blocker resolved",
    actorEmail,
    {
      assignmentEmail: targetEmail,
      blockerRemark: target.blockerRemark || null,
      blockerReportedAt: target.blockerReportedAt || null,
      blockerResolvedAt: now,
      blockerResolvedBy: actorEmail,
    }
  );
  return json(200, decoratedTaskResponse(task, assignments, actorEmail));
}

async function persistAssignmentsAndTask(task, assignments, options = {}) {
  if (options.create) {
    const assignmentItems = (assignments || [])
      .map((a) => assignmentRecord(task.taskId, a))
      .filter(Boolean);
    const merged = snapshotTask(task, assignments);
    merged.projectId = String(task.projectId || "").trim();
    merged.updatedAt = new Date().toISOString();
    const copies = await putCreatedTaskRecords(
      ddb,
      process.env.WORK_TABLE,
      merged,
      assignmentItems
    );
    assertPersistOk(copies, {
      op: "persistTaskCreate",
      taskId: task.taskId,
      PK: merged.PK,
      SK: merged.SK,
    });
    return merged;
  }
  for (const a of assignments) {
    await writeAssignment(task.taskId, a, options);
  }
  const merged = snapshotTask(task, assignments);
  merged.updatedAt = new Date().toISOString();
  const copies = await putTaskCopies(merged);
  assertPersistOk(copies, {
    op: "persistTask",
    taskId: task.taskId,
    PK: merged.PK,
    SK: merged.SK,
  });
  return merged;
}

async function notifyTaskEvent(email, type, title, message, dedupKey, extra = {}, channels = {}) {
  if (!email || !type || !dedupKey) return;
  try {
    const { dispatchNotification } = require("../common/notify");
    await dispatchNotification(ddb, {
      email,
      type,
      title,
      subject: title,
      message,
      reason: type,
      dedupKey,
      extra,
      channel: channels.channel,
      emailEnabled: channels.emailEnabled,
      inAppEnabled: channels.inAppEnabled,
      inAppSk: channels.inAppSk,
    });
  } catch (err) {
    console.error("Task notification failed", err);
  }
}

async function notifyAssignedEmployeeEmail(email, task, options = {}) {
  if (!email || !task) return;
  try {
    const { notifyAssignedEmployee } = require("./taskAssignNotify");
    let projectName = options.projectName;
    if (projectName === undefined) {
      try {
        projectName = (await getProjectName(task.projectId)) || "";
      } catch (err) {
        console.error("TASK_ASSIGNED_PROJECT_NAME_ERROR", err?.name);
        projectName = "";
      }
    }
    await notifyAssignedEmployee({
      ddb,
      task,
      assigneeEmail: email,
      assignedByName: options.assignedByName || "",
      assignedByEmail: options.assignedByEmail || "",
      projectName,
      kind: options.kind || "assigned",
      reasonLabel: options.reasonLabel || "",
      remark: options.remark || "",
      assignedAt: options.assignedAt || "",
    });
  } catch (err) {
    console.error(
      "TASK_ASSIGNED_EMAIL_ERROR",
      JSON.stringify({ taskId: task.taskId || "" })
    );
    console.error(err);
  }
}

async function persistEscalations(task, nowMs = Date.now(), resolveAdmins) {
  const assignments = await resolveAssignments(task);
  let changed = false;
  const enteredRedEmails = new Set();
  const redAtByEmail = {};
  const next = [];
  for (const a of assignments) {
    if (a.removed || escalation.isComplete(a.status) || escalation.isCancelled(a.status)) {
      next.push(a);
      continue;
    }
    const result = escalation.detectTransitions(a, task.dueDate, nowMs);
    if (
      result.events.length ||
      result.assignment.recordedZone !== a.recordedZone
    ) {
      changed = true;
    }
    if (result.events.length) {
      console.log(
        "TASK_ESCALATION_EVALUATED",
        JSON.stringify({
          taskId: task.taskId,
          zone: result.assignment.recordedZone,
        })
      );
    }
    next.push(result.assignment);
    for (const ev of result.events) {
      if (ev.action === "zone_orange") {
        console.log(
          "TASK_ZONE_CHANGED",
          JSON.stringify({ taskId: task.taskId, change: "GREEN → ORANGE" })
        );
      }
      if (ev.action === "zone_red") {
        enteredRedEmails.add(escalation.normalizeEmail(a.email));
        redAtByEmail[escalation.normalizeEmail(a.email)] = ev.timestamp;
        console.log(
          "TASK_ZONE_CHANGED",
          JSON.stringify({ taskId: task.taskId, change: "ORANGE → RED" })
        );
      }
      await appendActivityAt(
        task.taskId,
        ev.action,
        `${ev.detail} (${a.email})`,
        "system",
        ev.timestamp,
        { assignmentEmail: a.email }
      );
      const orange = ev.action === "zone_orange";
      const copy = zoneNotifyCopy({
        orange,
        title: task.title,
        deadline: task.dueDate,
        zoneStartedAt: ev.timestamp,
      });
      const dedupKey = `${task.taskId}#${a.email}#${ev.action}#${task.dueDate || ""}`;
      await notifyTaskEvent(
        a.email,
        copy.type,
        copy.title,
        copy.message,
        dedupKey,
        {
          taskId: task.taskId,
          zone: copy.zone,
          category: copy.category,
          deadline: task.dueDate || null,
          zoneStartedAt: ev.timestamp,
        },
        {
          channel: "inapp",
          inAppSk: orange
            ? undefined
            : `NOTIFY#TASK_RED#${dedupKey}`,
        }
      );
    }
  }

  const redStartedFallback = Number.isFinite(escalation.parseDeadlineMs(task.dueDate))
    ? new Date(
        escalation.parseDeadlineMs(task.dueDate) + escalation.ORANGE_MS
      ).toISOString()
    : new Date(nowMs).toISOString();

  let saved;
  if (changed) {
    saved = await persistAssignmentsAndTask(task, next);
  } else {
    saved = snapshotTask(task, next);
  }

  const pendingAdmin = next.filter((a) => {
    if (a.removed || escalation.isComplete(a.status) || escalation.isCancelled(a.status)) {
      return false;
    }
    const email = escalation.normalizeEmail(a.email);
    return escalation.needsRedAdminNotify(saved, a, enteredRedEmails.has(email), nowMs);
  });
  if (!pendingAdmin.length) return saved;

  let listAccessRows;
  try {
    if (typeof resolveAdmins === "function") {
      listAccessRows = resolveAdmins;
    } else if (Array.isArray(resolveAdmins)) {
      const rows = resolveAdmins;
      listAccessRows = async () => rows;
    }
  } catch (err) {
    console.error(
      "RED_ADMIN_EMAIL_FAILED",
      JSON.stringify({ taskId: task.taskId, status: "FAILED" })
    );
    console.error(err);
    return saved;
  }

  const tableName = process.env.WORK_TABLE;
  const nowIso = new Date(nowMs).toISOString();
  for (const a of pendingAdmin) {
    const email = escalation.normalizeEmail(a.email);
    const assignmentItem = {
      PK: `TASK#${task.taskId}`,
      SK: `ASSIGNMENT#${email}`,
      type: "ASSIGNMENT",
      taskId: task.taskId,
      email,
      status: a.status || "TODO",
      assignedAt: a.assignedAt || nowIso,
      assignedBy: a.assignedBy || "",
      completedAt: a.completedAt || null,
      completedDate: a.completedDate || null,
      completedZone: a.completedZone || null,
      completionRemark: a.completionRemark || null,
      highestZone: a.highestZone || null,
      recordedZone: a.recordedZone || null,
      zoneReachedAt: a.zoneReachedAt || null,
      redAdminNotifyStatus: a.redAdminNotifyStatus || null,
      redAdminNotifyClaimedAt: a.redAdminNotifyClaimedAt || null,
      redAdminNotifiedAt: a.redAdminNotifiedAt || null,
      redAdminNotifyRecipients: a.redAdminNotifyRecipients || {},
      redAdminNotifyAttempts: Number(a.redAdminNotifyAttempts || 0) || null,
      removed: !!a.removed,
    };
    let claimed;
    try {
      claimed = await claimRedAdminNotify(ddb, {
        tableName,
        item: assignmentItem,
        nowIso,
        nowMs,
      });
    } catch (err) {
      console.error(
        "RED_ADMIN_EMAIL_FAILED",
        JSON.stringify({ taskId: task.taskId, status: "FAILED" })
      );
      console.error(err);
      continue;
    }
    if (!claimed.ok) {
      console.log(
        "RED_ADMIN_NOTIFY_SKIPPED",
        JSON.stringify({
          taskId: task.taskId,
          assignmentEmail: email,
          reason: claimed.reason || "already claimed or sent",
        })
      );
      continue;
    }
    a.redAdminNotifyStatus = "SENDING";
    a.redAdminNotifyClaimedAt = nowIso;
    a.redAdminNotifyAttempts = claimed.item.redAdminNotifyAttempts;
    a.redAdminNotifyRecipients = claimed.item.redAdminNotifyRecipients || {};
    let notifyStatus = "FAILED";
    try {
      notifyStatus = await notifyAdminsTaskEnteredRed({
        task: saved,
        assignment: a,
        redAt: redAtByEmail[email] || redStartedFallback,
        listAccessRows,
        ddb,
        accessTable: process.env.USER_ACCESS_TABLE,
        getAssigneeProfile,
        getProjectName,
        existingRecipients: a.redAdminNotifyRecipients,
        persistRecipient: async (recipient, entry) => {
          await persistRedAdminRecipient(ddb, {
            tableName,
            key: { PK: assignmentItem.PK, SK: assignmentItem.SK },
            email: recipient,
            messageId: entry.messageId,
            notifiedAt: entry.notifiedAt,
          });
        },
        nowMs,
        nowIso,
      });
    } catch (err) {
      console.error(
        "RED_ADMIN_EMAIL_FAILED",
        JSON.stringify({ taskId: task.taskId, status: "FAILED" })
      );
      console.error(err);
      notifyStatus = "FAILED";
    }
    try {
      const finalized = await finalizeRedAdminNotify(ddb, {
        tableName,
        item: claimed.item,
        status: notifyStatus,
        nowIso,
      });
      if (finalized.ok) {
        a.redAdminNotifyStatus = finalized.status;
        if (finalized.status === "SENT") {
          a.redAdminNotifiedAt = finalized.item.redAdminNotifiedAt || nowIso;
        }
      }
    } catch (persistErr) {
      console.error(persistErr);
    }
  }

  try {
    saved = snapshotTask(saved, next);
  } catch (err) {
    console.error(err);
  }
  return saved;
}

async function queryAllTasks() {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: process.env.WORK_TABLE,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function scanAccessRows() {
  if (!process.env.USER_ACCESS_TABLE) return [];
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: process.env.USER_ACCESS_TABLE,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function listActiveAdminEmails() {
  const rows = await scanAccessRows();
  return activeAdminEmailsFromAccess(rows);
}

async function listRedZoneAdminEmails() {
  const rows = await scanAccessRows();
  return activeCompletionAdminEmailsFromAccess(rows);
}

function isBlockedAccessStatus(status) {
  return String(status || "").toUpperCase() === "BLOCKED";
}

function newAssignmentEmails(requestedEmails, currentActiveEmails = []) {
  const current = new Set(
    (currentActiveEmails || [])
      .map((email) => escalation.normalizeEmail(email))
      .filter(Boolean)
  );
  return (requestedEmails || [])
    .map((email) => escalation.normalizeEmail(email))
    .filter((email) => email && !current.has(email));
}

function collectBlockedNewAssignees(
  requestedEmails,
  currentActiveEmails,
  statusByEmail = {}
) {
  return newAssignmentEmails(requestedEmails, currentActiveEmails).filter((email) =>
    isBlockedAccessStatus(statusByEmail[email])
  );
}

async function loadUserAccessStatus(email) {
  const normalized = escalation.normalizeEmail(email);
  if (!process.env.USER_ACCESS_TABLE || !normalized) return null;
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_ACCESS_TABLE,
        Key: { PK: normalized, SK: normalized },
      })
    );
    return res.Item?.status || null;
  } catch {
    return null;
  }
}

async function blockedNewAssignees(requestedEmails, currentActiveEmails = []) {
  const newcomers = newAssignmentEmails(requestedEmails, currentActiveEmails);
  const statusByEmail = {};
  for (const email of newcomers) {
    statusByEmail[email] = await loadUserAccessStatus(email);
  }
  return collectBlockedNewAssignees(
    requestedEmails,
    currentActiveEmails,
    statusByEmail
  );
}

async function runEscalationSweep() {
  const tasks = await queryAllTasks();
  let accessRows;
  const resolveAdmins = async () => {
    if (!accessRows) accessRows = await scanAccessRows();
    return accessRows;
  };
  try {
    await materializeTodaysConfirmedLeave({ ddb, now: new Date() });
  } catch (err) {
    console.error("LEAVE_MATERIALIZE_ERROR", err);
  }
  await taskImportConfirm.assignDueScheduledTasks({
    ddb,
    tableName: process.env.WORK_TABLE,
    nowMs: Date.now(),
  });
  await taskImportConfirm.promoteWaitingImportAudits({
    ddb,
    s3,
    tableName: process.env.WORK_TABLE,
    bucket: process.env.DOCUMENTS_BUCKET,
    nowMs: Date.now(),
  });
  const afterAssign = await queryAllTasks();
  let processed = 0;
  for (const task of afterAssign) {
    if (task.archived) continue;
    if (taskImportConfirm.isPendingScheduledTask(task)) continue;
    try {
      await persistEscalations(task, Date.now(), resolveAdmins);
      processed += 1;
    } catch (err) {
      console.error(
        "TASK_ESCALATION_ERROR",
        JSON.stringify({ taskId: task.taskId || task.SK || "" })
      );
      console.error(err);
    }
  }
  return json(200, { ok: true, processed });
}

async function getProjectName(projectId) {
  if (!projectId) return "";
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: { PK: "ENTITY#PROJECT", SK: `PROJECT#${projectId}` },
    })
  );
  return res.Item?.name || "";
}

async function getAssigneeProfile(email) {
  if (!email || !process.env.USER_PROFILE_TABLE) {
    return {
      email: email || "",
      name: "",
      empId: "",
      department: "",
      designation: "",
    };
  }
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: {
          PK: `USER#${String(email).toLowerCase()}`,
          SK: "PROFILE",
        },
      })
    );
    const p = res.Item || {};
    return {
      email: email,
      name: p.name || "",
      empId: p.empId || "",
      department: p.department || "",
      designation: p.designation || "",
    };
  } catch {
    return {
      email,
      name: "",
      empId: "",
      department: "",
      designation: "",
    };
  }
}

function nameFromClaims(event) {
  const claims = event.requestContext?.authorizer?.claims || {};
  const combined = `${claims.given_name || ""} ${claims.family_name || ""}`.trim();
  if (combined) return combined;
  const name = String(claims.name || "").trim();
  if (name && !name.includes("@")) return name;
  return "";
}

async function resolveCreatorName(event, user, typed) {
  const profile = await getAssigneeProfile(user.email);
  return (
    escalation.pickPersonName(typed, profile.name, nameFromClaims(event)) ||
    escalation.displayNameFromEmail(user.email)
  );
}

function taskReadAuthArgs(user, task, cache) {
  return {
    ddb,
    tableName: process.env.WORK_TABLE,
    accessTable: process.env.USER_ACCESS_TABLE,
    user,
    task,
    cache,
  };
}

async function handleReviewReassign({ user, body, sourceTaskId, cache, event }) {
  const sourceTask = await getTask(sourceTaskId);
  if (!sourceTask) return json(404, { error: "Task not found" });

  const sourceAssignments = await resolveAssignments(sourceTask);
  const sourceSnap = snapshotTask(sourceTask, sourceAssignments);
  const updateAuth = await taskMutateAccess.authorizeTaskUpdate({
    ...taskReadAuthArgs(user, sourceSnap, cache),
    task: sourceSnap,
  });
  const updateDenied = denyAuthz(user, updateAuth);
  if (updateDenied) return updateDenied;
  if (!updateAuth.mayAdminMutate) {
    return json(403, { error: "Forbidden" });
  }

  const parsedReview = taskReviewReassign.parseReviewReassignRequest(
    body,
    sourceAssignments
  );
  if (!parsedReview.ok) {
    return json(parsedReview.statusCode || 400, { error: parsedReview.error });
  }

  const description =
    body.description !== undefined
      ? String(body.description)
      : String(sourceTask.description || "");
  const createParsed = escalation.validateCreatePayload({
    title: sourceTask.title,
    description,
    assignees: [parsedReview.targetEmail],
    assignee: parsedReview.targetEmail,
    priority: sourceTask.priority,
    category: sourceTask.category,
    startDate: body.startDate,
    dueDate: body.dueDate,
  });
  if (!createParsed.ok) {
    const first =
      Object.values(createParsed.errors)[0] ||
      "Unable to reassign task. Please try again.";
    return json(400, { error: first, errors: createParsed.errors });
  }

  const createAuth = await taskMutateAccess.authorizeTaskCreate({
    ...taskReadAuthArgs(user, { projectId: sourceTask.projectId }, cache),
    projectId: sourceTask.projectId,
  });
  const createDenied = denyAuthz(user, createAuth);
  if (createDenied) return createDenied;

  const blocked = await blockedNewAssignees([parsedReview.targetEmail]);
  if (blocked.length) {
    return json(400, {
      error: "Cannot assign a task to a deactivated user.",
    });
  }
  const memberAssign =
    await taskMutateAccess.assertRestrictedAssigneesAreMembers({
      ddb,
      tableName: process.env.WORK_TABLE,
      project: createAuth.project || updateAuth.project,
      emails: [parsedReview.targetEmail],
    });
  const memberDenied = denyAuthz(user, memberAssign);
  if (memberDenied) return memberDenied;

  const fitCheck = await validateAssigneesAssignedShiftFit(
    ddb,
    process.env.WORK_TABLE,
    {
      emails: [parsedReview.targetEmail],
      startDate: createParsed.startDate,
      dueDate: createParsed.dueDate,
      assignmentState: "ASSIGNED",
    }
  );
  if (!fitCheck.ok) {
    return json(400, shiftFitConflictBody(fitCheck.conflicts));
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const createdByName = await resolveCreatorName(event, user);
  const assignments = [
    {
      email: parsedReview.targetEmail,
      status: "TODO",
      assignedAt: now,
      assignedBy: user.email,
      recordedZone: escalation.zoneAt(
        escalation.parseDeadlineMs(createParsed.dueDate),
        nowMs
      ),
    },
  ];
  const item = snapshotTask(
    {
      PK: "ENTITY#TASK",
      SK: `TASK#${id}`,
      taskId: id,
      projectId: sourceTask.projectId,
      title: createParsed.title,
      description: createParsed.description || "",
      category: createParsed.category || sourceTask.category || "",
      assignee: parsedReview.targetEmail,
      priority: createParsed.priority,
      status: "TODO",
      dueDate: createParsed.dueDate,
      startDate: createParsed.startDate,
      durationType: null,
      durationHours: null,
      durationDays: null,
      durationStart: null,
      durationEnd: null,
      completedDate: null,
      labels: Array.isArray(sourceTask.labels) ? sourceTask.labels : [],
      archived: false,
      createdAt: now,
      createdBy: user.email,
      createdByName,
      updatedAt: now,
      sourceTaskId,
      reassignmentReason: parsedReview.reason,
      reassignmentRemark: parsedReview.remark,
      reassignedBy: user.email,
      reassignedAt: now,
    },
    assignments
  );

  await persistAssignmentsAndTask(item, assignments, { create: true });

  const reasonText = taskReviewReassign.reasonLabel(parsedReview.reason);
  const newLabel = taskReviewReassign.shortTaskId(id);
  const sourceLabel = taskReviewReassign.shortTaskId(sourceTaskId);
  await appendActivity(
    sourceTaskId,
    "task_reassigned",
    `${reasonText}: ${parsedReview.sourceEmail} → ${parsedReview.targetEmail}. New task ${newLabel}. Schedule ${createParsed.startDate} → ${createParsed.dueDate}. ${parsedReview.remark}`,
    user.email,
    {
      assignmentEmail: parsedReview.sourceEmail,
      newTaskId: id,
      targetEmail: parsedReview.targetEmail,
      reassignmentReason: parsedReview.reason,
      reassignmentRemark: parsedReview.remark,
      startDate: createParsed.startDate,
      dueDate: createParsed.dueDate,
    }
  );
  await appendActivity(
    id,
    "task_created",
    `Task created from ${sourceLabel} after ${reasonText} review`,
    user.email,
    {
      actorName: createdByName,
      sourceTaskId,
      reassignmentReason: parsedReview.reason,
    }
  );
  await appendActivity(
    id,
    "task_assigned",
    `Assigned to ${parsedReview.targetEmail}`,
    user.email
  );
  await notifyTaskEvent(
    parsedReview.targetEmail,
    "TASK_ASSIGNED",
    `New task assigned: ${item.title}`,
    `You have been assigned "${item.title}".`,
    `${id}#${parsedReview.targetEmail}#assigned#${now}`,
    { taskId: id, sourceTaskId },
    { channel: "inapp" }
  );
  await notifyAssignedEmployeeEmail(parsedReview.targetEmail, item, {
    assignedByName: createdByName,
    assignedByEmail: user.email,
    assignedAt: now,
    kind: "review-reassigned",
    reasonLabel: reasonText,
    remark: parsedReview.remark,
  });

  return json(201, {
    ...escalation.decorateTask(item, nowMs, user.email),
    sourceTaskId,
    reassignmentReason: parsedReview.reason,
    reassignmentRemark: parsedReview.remark,
    reassignedBy: user.email,
    reassignedAt: now,
  });
}

async function denyUnlessTaskReadable(user, task, cache) {
  const decision = await taskReadAccess.authorizeTaskRead(
    taskReadAuthArgs(user, task, cache)
  );
  return denyAuthz(user, decision);
}

function denyAuthz(user, decision) {
  if (!decision?.ok) {
    return json(500, { error: "Internal server error" });
  }
  if (decision.allowed) return null;
  if (decision.code === taskMutateAccess.CODE_ASSIGNEE_NOT_MEMBER) {
    return json(400, {
      error: "Cannot assign a task to a user who is not a project member.",
    });
  }
  if (!escalation.normalizeEmail(user?.email)) {
    return json(401, { error: "Unauthorized" });
  }
  return json(403, { error: "Forbidden" });
}

async function listByPrefix(pk, prefix) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": pk, ":sk": prefix },
      ScanIndexForward: false,
    })
  );
  return res.Items || [];
}

exports.handler = async (event) => {
  if (isScheduleEvent(event)) {
    try {
      return await runEscalationSweep();
    } catch (err) {
      console.error("Task escalation sweep error:", err);
      return json(500, { error: "Internal server error" });
    }
  }

  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  const path = event.path || "";
  const method = event.httpMethod;
  const body = event.body ? JSON.parse(event.body) : {};
  const taskRoute = taskPathMatch(path);
  const taskReadCache = taskReadAccess.createCache();

  try {
    if (myActivity.myActivityPathMatch(path) && method === "GET") {
      const result = await myActivity.handleGetMyActivity({
        user,
        query: event.queryStringParameters || {},
        ddb,
        nowMs: Date.now(),
      });
      return json(result.statusCode, result.body);
    }
    if (shiftCatalog.listShiftsPathMatch(path) && method === "GET") {
      const result = await shiftCatalog.handleListShifts({
        user,
        ddb,
        tableName: process.env.WORK_TABLE,
        accessTable: process.env.USER_ACCESS_TABLE,
      });
      return json(result.statusCode, result.body);
    }
    if (shiftCatalog.listShiftsPathMatch(path) && method === "POST") {
      const result = await shiftCatalog.handleCreateShift({
        user,
        body,
        ddb,
        tableName: process.env.WORK_TABLE,
        accessTable: process.env.USER_ACCESS_TABLE,
      });
      return json(result.statusCode, result.body);
    }
    const shiftId = shiftCatalog.shiftIdPathMatch(path, event.pathParameters);
    if (shiftId && method === "PATCH") {
      const result = await shiftCatalog.handleUpdateShift({
        user,
        shiftId,
        body,
        ddb,
        tableName: process.env.WORK_TABLE,
        accessTable: process.env.USER_ACCESS_TABLE,
      });
      return json(result.statusCode, result.body);
    }
    const shiftEmail = shiftCatalog.employeeShiftPathMatch(
      path,
      event.pathParameters
    );
    if (shiftEmail && method === "GET") {
      const result = await shiftCatalog.handleGetEmployeeShift({
        user,
        email: shiftEmail,
        ddb,
        tableName: process.env.WORK_TABLE,
        accessTable: process.env.USER_ACCESS_TABLE,
      });
      return json(result.statusCode, result.body);
    }
    if (shiftEmail && method === "PUT") {
      const result = await shiftCatalog.handleAssignEmployeeShift({
        user,
        email: shiftEmail,
        body,
        ddb,
        tableName: process.env.WORK_TABLE,
        accessTable: process.env.USER_ACCESS_TABLE,
      });
      return json(result.statusCode, result.body);
    }

    if (taskImport.isUploadUrlPath(path) && method === "POST") {
      const result = await taskImport.handleUploadUrlRequest({
        user,
        body,
        ddb,
        s3,
      });
      return json(result.statusCode, result.body);
    }

    const previewBatchId = taskImportPreview.previewPathMatch(
      path,
      event.pathParameters
    );
    if (previewBatchId && method === "POST") {
      const result = await taskImportPreview.handlePreviewRequest({
        user,
        batchId: previewBatchId,
        ddb,
        s3,
      });
      return json(result.statusCode, result.body);
    }

    const confirmBatchId = taskImportConfirm.confirmPathMatch(
      path,
      event.pathParameters
    );
    if (confirmBatchId && method === "POST") {
      const createdByName = await resolveCreatorName(event, user);
      const result = await taskImportConfirm.handleConfirmRequest({
        user: { ...user, createdByName },
        batchId: confirmBatchId,
        ddb,
        s3,
      });
      return json(result.statusCode, result.body);
    }

    const importDownloadId = taskImportHistory.downloadPathMatch(
      path,
      event.pathParameters
    );
    if (importDownloadId && method === "GET") {
      const result = await taskImportHistory.handleGetTaskImportDownloadUrl({
        user,
        batchId: importDownloadId,
        ddb,
        s3,
      });
      return json(result.statusCode, result.body);
    }
    if (taskImportHistory.listPathMatch(path) && method === "GET") {
      const qs = event.queryStringParameters || {};
      const result = await taskImportHistory.handleListTaskImports({
        user,
        ddb,
        tableName: process.env.WORK_TABLE,
        limit: qs.limit,
        nextToken: qs.nextToken,
      });
      return json(result.statusCode, result.body);
    }
    const importDetailId = taskImportHistory.detailPathMatch(
      path,
      event.pathParameters
    );
    if (importDetailId && method === "GET") {
      const result = await taskImportHistory.handleGetTaskImport({
        user,
        batchId: importDetailId,
        ddb,
        s3,
      });
      return json(result.statusCode, result.body);
    }

    // ── TASK BY ID / COMMENTS / ACTIVITY / ATTACHMENTS ──
    if (taskRoute) {
      const { taskId, sub, action } = taskRoute;
      const task = await getTask(taskId);

      if (sub === "attachment-download-url" && method === "POST") {
        const { s3Key, attachmentId } = body;
        let key = s3Key;
        if (!key && attachmentId && task) {
          const att = await ddb.send(
            new GetCommand({
              TableName: process.env.WORK_TABLE,
              Key: {
                PK: `TASK#${taskId}`,
                SK: `ATTACHMENT#${attachmentId}`,
              },
            })
          );
          key = att.Item?.s3Key;
        }
        if (!key) return json(400, { error: "s3Key or attachmentId required" });
        const objectKey = String(key).replace(/^\/+/, "");
        if (!objectKey || objectKey.includes("..")) {
          return json(400, { error: "Invalid s3Key" });
        }
        const download = await taskReadAccess.authorizeAttachmentDownload({
          ...taskReadAuthArgs(user, task, taskReadCache),
          taskId,
          objectKey,
        });
        if (!download.ok) {
          return json(500, { error: "Internal server error" });
        }
        if (!download.allowed) return json(403, { error: "Forbidden" });
        const bucket = process.env.TASK_ATTACHMENTS_BUCKET;
        if (!bucket) {
          return json(500, { error: "Attachments bucket not configured" });
        }
        const downloadUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
          { expiresIn: 300 }
        );
        return json(200, { downloadUrl });
      }

      if (!sub && method === "GET") {
        if (!task) return json(404, { error: "Task not found" });
        const assignments = await resolveAssignments(task);
        const snap = snapshotTask(task, assignments);
        const denied = await denyUnlessTaskReadable(user, snap, taskReadCache);
        if (denied) return denied;

        const decorated = escalation.decorateTask(snap, Date.now(), user.email);
        const [projectName, assignee, assigneeProfiles, creatorProfile] =
          await Promise.all([
            getProjectName(task.projectId),
            getAssigneeProfile(decorated.assignee),
            Promise.all(
              (decorated.assignees || []).map((email) => getAssigneeProfile(email))
            ),
            getAssigneeProfile(task.createdBy),
          ]);

        return json(200, {
          ...decorated,
          projectName,
          assigneeProfile: assignee,
          assigneeProfiles,
          createdByName: escalation.creatorDisplayName({
            createdBy: task.createdBy,
            createdByName: task.createdByName || creatorProfile.name,
          }),
          creatorProfile,
        });
      }

      if (!task) return json(404, { error: "Task not found" });

      if (sub === "blocker" && method === "POST") {
        if (action === "resolve") {
          return handleResolveBlocker({
            user,
            task,
            taskId,
            body,
            cache: taskReadCache,
          });
        }
        if (action) return json(404, { error: "Not found" });
        return handleReportBlocker({
          user,
          task,
          taskId,
          body,
          cache: taskReadCache,
        });
      }

      if (sub === "comments" && method === "POST") {
        const text = String(body.text || body.comment || "").trim();
        if (!text) return json(400, { error: "Comment text required" });
        const commentAuth = await taskMutateAccess.authorizeCommentCreate(
          taskReadAuthArgs(user, task, taskReadCache)
        );
        const commentDenied = denyAuthz(user, commentAuth);
        if (commentDenied) return commentDenied;
        const now = new Date().toISOString();
        const id = randomUUID();
        const item = {
          PK: `TASK#${taskId}`,
          SK: `COMMENT#${now}#${id}`,
          commentId: id,
          taskId,
          text,
          authorEmail: user.email,
          authorName: body.authorName || user.email.split("@")[0],
          createdAt: now,
        };
        await ddb.send(
          new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
        );
        await appendActivity(
          taskId,
          "comment_added",
          "Comment added",
          user.email
        );
        return json(201, item);
      }

      const denied = await denyUnlessTaskReadable(user, task, taskReadCache);
      if (denied) return denied;

      // Comments
      if (sub === "comments" && method === "GET") {
        const items = await listByPrefix(`TASK#${taskId}`, "COMMENT#");
        return json(200, items);
      }

      // Activity
      if (sub === "activity" && method === "GET") {
        const items = await listByPrefix(`TASK#${taskId}`, "ACTIVITY#");
        return json(200, items);
      }

      // Attachments
      if (sub === "attachments" && method === "GET") {
        const items = await listByPrefix(`TASK#${taskId}`, "ATTACHMENT#");
        return json(200, items);
      }

      if (sub === "attachment-upload-url" && method === "POST") {
        const fileName = body.fileName;
        const contentType = body.contentType || "application/octet-stream";
        if (!fileName) return json(400, { error: "fileName required" });
        const fileError = escalation.validateAttachment({
          fileName,
          fileSize: body.fileSize,
        });
        if (fileError) return json(400, { error: fileError });
        const bucket = process.env.TASK_ATTACHMENTS_BUCKET;
        if (!bucket) {
          return json(500, { error: "Attachments bucket not configured" });
        }
        const key = `tasks/${taskId}/${Date.now()}-${fileName}`;
        const uploadUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: contentType,
          }),
          { expiresIn: 300 }
        );
        return json(200, { uploadUrl, s3Key: key, fileName, contentType });
      }

      if (sub === "attachments" && method === "POST") {
        const { fileName, contentType, s3Key } = body;
        if (!fileName || !s3Key) {
          return json(400, { error: "fileName and s3Key required" });
        }
        const now = new Date().toISOString();
        const id = randomUUID();
        const item = {
          PK: `TASK#${taskId}`,
          SK: `ATTACHMENT#${id}`,
          attachmentId: id,
          taskId,
          fileName,
          contentType: contentType || "application/octet-stream",
          s3Key,
          uploadedBy: user.email,
          uploadedAt: now,
        };
        await ddb.send(
          new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
        );
        await appendActivity(
          taskId,
          "attachment_uploaded",
          `Uploaded ${fileName}`,
          user.email
        );
        return json(201, item);
      }

      return json(405, { error: "Method not allowed" });
    }

    // ── PROJECTS ──
    if (path.endsWith("/projects") && method === "GET") {
      const listed = await projectManage.handleListProjects({
        user,
        ddb,
        tableName: process.env.WORK_TABLE,
        accessTable: process.env.USER_ACCESS_TABLE,
        status: event.queryStringParameters?.status,
      });
      return json(listed.statusCode, listed.body);
    }

    if (path.endsWith("/projects") && method === "POST") {
      const created = await projectManage.handleCreateProject({
        user,
        body,
        ddb,
        tableName: process.env.WORK_TABLE,
        accessTable: process.env.USER_ACCESS_TABLE,
        restrictedCreateEnabled: projectManage.isRestrictedCreateEnabled(),
      });
      return json(created.statusCode, created.body);
    }

    if (path.endsWith("/projects")) {
      return json(405, { error: "Method not allowed" });
    }

    const projectRoute = projectManage.projectPathMatch(
      path,
      event.pathParameters
    );
    if (projectRoute && method === "DELETE") {
      const removed = await projectManage.handleDeleteProject({
        user,
        projectId: projectRoute.projectId,
        body,
        query: event.queryStringParameters || {},
        ddb,
        s3,
        tableName: process.env.WORK_TABLE,
        accessTable: process.env.USER_ACCESS_TABLE,
        attachmentsBucket: process.env.TASK_ATTACHMENTS_BUCKET,
        documentsBucket: process.env.DOCUMENTS_BUCKET,
      });
      return json(removed.statusCode, removed.body);
    }
    if (projectRoute && method === "PATCH") {
      const patched = await projectManage.handlePatchProject({
        user,
        projectId: projectRoute.projectId,
        body,
        ddb,
        tableName: process.env.WORK_TABLE,
        accessTable: process.env.USER_ACCESS_TABLE,
      });
      return json(patched.statusCode, patched.body);
    }
    if (projectRoute) {
      return json(405, { error: "Method not allowed" });
    }

    // ── TASKS LIST / CREATE / UPDATE ──
    if (path.endsWith("/tasks") && method === "GET") {
      if (!escalation.normalizeEmail(user.email)) {
        return json(401, { error: "Unauthorized" });
      }
      const {
        projectId: projectIdRaw,
        assignee,
        mine,
        zone,
        q,
        search,
        priority,
        includePendingShiftConflicts: includePendingRaw,
      } = event.queryStringParameters || {};
      const includePendingShiftConflicts =
        String(includePendingRaw || "").toLowerCase() === "true";
      if (includePendingShiftConflicts) {
        const conflictAuth = await requireEligiblePortalAdmin({
          user,
          ddb,
          accessTable: process.env.USER_ACCESS_TABLE,
        });
        if (!conflictAuth.ok) {
          return json(conflictAuth.statusCode, conflictAuth.body);
        }
      }
      const projectId = String(projectIdRaw || "").trim();
      let items = [];

      if (projectId) {
        const res = await ddb.send(
          new QueryCommand({
            TableName: process.env.WORK_TABLE,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues: {
              ":pk": `PROJECT#${projectId}`,
              ":sk": "TASK#",
            },
          })
        );
        items = res.Items || [];
      } else {
        const res = await ddb.send(
          new QueryCommand({
            TableName: process.env.WORK_TABLE,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
          })
        );
        items = res.Items || [];
      }

      items = items.filter((t) => !t.archived);
      const pendingScheduled = items.filter((t) =>
        taskImportConfirm.isPendingScheduledTask(t)
      );
      items = items.filter((t) => !taskImportConfirm.isPendingScheduledTask(t));

      const focusEmail =
        mine === "true" ? user.email : assignee || "";

      if (includePendingShiftConflicts) {
        const conflictFocus = escalation.normalizeEmail(focusEmail);
        const extra = pendingScheduled.filter((t) => {
          if (conflictFocus) {
            return Boolean(
              shiftCatalog.unresolvedShiftConflictStatus(t, conflictFocus)
            );
          }
          return (t.pendingAssignees || []).some((email) =>
            shiftCatalog.unresolvedShiftConflictStatus(t, email)
          );
        });
        items = items.concat(extra);
      }

      if (mine === "true" || assignee) {
        const target = focusEmail || user.email;
        items = items.filter(
          (t) =>
            escalation.taskAssignedTo(t, target) ||
            (includePendingShiftConflicts &&
              Boolean(shiftCatalog.unresolvedShiftConflictStatus(t, target)))
        );
      }

      const resolved = [];
      for (const t of items) {
        const assignments = await resolveAssignments(t);
        resolved.push(snapshotTask(t, assignments));
      }
      items = resolved;

      const visible = await taskReadAccess.filterVisibleTasks({
        ...taskReadAuthArgs(user, null, taskReadCache),
        tasks: items,
      });
      if (!visible.ok) {
        return json(500, { error: "Internal server error" });
      }
      items = visible.tasks;

      items = items.map((t) =>
        escalation.decorateTask(t, Date.now(), user.email)
      );

      const query = q || search;
      if (query) {
        items = items.filter((t) => escalation.matchesSearch(t, query));
      }
      if (priority) {
        items = items.filter((t) =>
          escalation.matchesPriorityFilter(t, priority)
        );
      }

      const counts = escalation.zoneCounts(items, focusEmail || undefined);
      items = escalation.applyZoneFilter(
        items,
        zone,
        focusEmail || undefined
      );

      return json(200, { tasks: items, zoneCounts: counts });
    }

    if (path.endsWith("/tasks") && method === "POST") {
      if (!escalation.normalizeEmail(user.email)) {
        return json(401, { error: "Unauthorized" });
      }
      const sourceTaskId = String(body.sourceTaskId || "").trim();
      if (sourceTaskId) {
        return await handleReviewReassign({
          user,
          body,
          sourceTaskId,
          cache: taskReadCache,
          event,
        });
      }
      const projectId = String(body.projectId || "").trim();
      if (!projectId) {
        return json(400, { error: "projectId and title required" });
      }

      const parsed = escalation.validateCreatePayload(body);
      if (!parsed.ok) {
        const first = Object.values(parsed.errors)[0] || "Unable to create task. Please try again.";
        return json(400, { error: first, errors: parsed.errors });
      }

      const createAuth = await taskMutateAccess.authorizeTaskCreate({
        ...taskReadAuthArgs(user, { projectId }, taskReadCache),
        projectId,
      });
      if (!createAuth.ok) {
        return json(500, { error: "Internal server error" });
      }
      if (!createAuth.allowed) {
        return json(403, { error: "Forbidden" });
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const nowMs = Date.now();
      const emails = parsed.emails;
      const blocked = await blockedNewAssignees(emails);
      if (blocked.length) {
        return json(400, {
          error: "Cannot assign a task to a deactivated user.",
        });
      }
      const memberAssign = await taskMutateAccess.assertRestrictedAssigneesAreMembers(
        {
          ddb,
          tableName: process.env.WORK_TABLE,
          project: createAuth.project,
          emails,
        }
      );
      const memberDenied = denyAuthz(user, memberAssign);
      if (memberDenied) return memberDenied;
      const initialStatus = "TODO";
      const createdByName = await resolveCreatorName(
        event,
        user,
        body.authorName || body.createdByName
      );
      const assignments = emails.map((email) => ({
        email,
        status: initialStatus,
        assignedAt: now,
        assignedBy: user.email,
        recordedZone: escalation.zoneAt(
          escalation.parseDeadlineMs(parsed.dueDate),
          nowMs
        ),
      }));

      const item = snapshotTask(
        {
          PK: "ENTITY#TASK",
          SK: `TASK#${id}`,
          taskId: id,
          projectId,
          title: parsed.title,
          description: parsed.description || "",
          category: parsed.category || "",
          assignee: emails[0] || "",
          priority: parsed.priority,
          status: initialStatus,
          dueDate: parsed.dueDate,
          startDate: parsed.startDate,
          durationType: null,
          durationHours: null,
          durationDays: null,
          durationStart: null,
          durationEnd: null,
          completedDate: null,
          labels: body.labels || [],
          archived: false,
          createdAt: now,
          createdBy: user.email,
          createdByName,
          updatedAt: now,
        },
        assignments
      );

      await persistAssignmentsAndTask(item, assignments, { create: true });
      await appendActivity(
        id,
        "task_created",
        `Task created by ${createdByName}`,
        user.email,
        { actorName: createdByName }
      );
      if (parsed.category) {
        await appendActivity(
          id,
          "task_updated",
          `Category set to ${parsed.category}`,
          user.email
        );
      }
      if (emails.length) {
        await appendActivity(
          id,
          "task_assigned",
          `Assigned to ${emails.join(", ")}`,
          user.email
        );
        let projectName = "";
        try {
          projectName = (await getProjectName(item.projectId)) || "";
        } catch (err) {
          console.error("TASK_ASSIGNED_PROJECT_NAME_ERROR", err?.name);
        }
        for (const email of emails) {
          await notifyTaskEvent(
            email,
            "TASK_ASSIGNED",
            `New task assigned: ${item.title}`,
            `You have been assigned "${item.title}".`,
            `${id}#${email}#assigned#${now}`,
            { taskId: id },
            { channel: "inapp" }
          );
          await notifyAssignedEmployeeEmail(email, item, {
            assignedByName: createdByName,
            assignedByEmail: user.email,
            projectName,
            assignedAt: now,
            kind: "assigned",
          });
        }
      }

      return json(201, escalation.decorateTask(item, nowMs, user.email));
    }

    if (path.endsWith("/tasks") && method === "PUT") {
      if (!escalation.normalizeEmail(user.email)) {
        return json(401, { error: "Unauthorized" });
      }
      const { taskId, projectId, ...updates } = body;
      if (!taskId) return json(400, { error: "taskId required" });

      const existing = await getTask(taskId);
      if (!existing) return json(404, { error: "Task not found" });

      let assignments = await resolveAssignments(existing);
      const snapExisting = snapshotTask(existing, assignments);
      const updateAuth = await taskMutateAccess.authorizeTaskUpdate({
        ...taskReadAuthArgs(user, snapExisting, taskReadCache),
        task: snapExisting,
      });
      const updateDenied = denyAuthz(user, updateAuth);
      if (updateDenied) return updateDenied;
      const mayAdminMutate = Boolean(updateAuth.mayAdminMutate);
      const isAssignee = escalation.taskAssignedTo(snapExisting, user.email);
      if (!mayAdminMutate && !isAssignee) return json(403, { error: "Forbidden" });

      const allowed = mayAdminMutate
        ? updates
        : {
            status: updates.status,
            assignmentEmail: updates.assignmentEmail,
            completionRemark: updates.completionRemark,
          };

      if (allowed.status && !STATUSES.includes(allowed.status)) {
        delete allowed.status;
      }
      if (allowed.priority) {
        allowed.priority = escalation.normalizePriority(allowed.priority);
      }
      if (allowed.category !== undefined) {
        allowed.category = escalation.normalizeCategory(allowed.category);
      }
      if (allowed.durationType !== undefined) {
        Object.assign(allowed, parseDuration(allowed));
      }

      delete allowed.createdBy;
      delete allowed.createdByName;
      delete allowed.PK;
      delete allowed.SK;
      delete allowed.projectId;
      delete allowed.redAdminNotifyStatus;
      delete allowed.redAdminNotifiedAt;

      const nowIso = new Date().toISOString();
      const nowMs = Date.now();
      let completionTransitioned = false;
      let completedAssignment = null;
      let reviewSubmitted = null;
      const merged = {
        ...existing,
        ...allowed,
        taskId: existing.taskId,
        projectId: existing.projectId,
        PK: "ENTITY#TASK",
        SK: `TASK#${taskId}`,
        createdBy: existing.createdBy,
        createdByName:
          existing.createdByName || escalation.creatorDisplayName(existing),
        updatedAt: nowIso,
      };

      delete merged.assignmentEmail;
      delete merged.completionRemark;
      delete merged.assignees;
      delete merged.zone;
      delete merged.overdue;
      delete merged.timing;
      delete merged.myAssignment;
      delete merged.assigneeProfiles;
      delete merged.displayStatus;
      delete merged.priorityLabel;

      const currentEmails = assignments
        .filter((a) => a && !a.removed)
        .map((a) => escalation.normalizeEmail(a.email))
        .filter(Boolean);
      const assigneeFieldsProvided =
        mayAdminMutate &&
        (updates.assignees !== undefined || updates.assignee !== undefined);
      const nextEmails = assigneeFieldsProvided
        ? escalation.normalizeEmailList(
            updates.assignees !== undefined ? updates.assignees : updates.assignee,
            null
          )
        : currentEmails;
      const timingFieldsProvided =
        mayAdminMutate &&
        (updates.startDate !== undefined ||
          updates.dueDate !== undefined ||
          updates.scheduledAssignAt !== undefined);

      if (merged.startDate && merged.dueDate) {
        const startMs = escalation.parseInstantMs(merged.startDate, false);
        const dueMs = escalation.parseDeadlineMs(merged.dueDate);
        if (
          Number.isFinite(startMs) &&
          Number.isFinite(dueMs) &&
          dueMs < startMs
        ) {
          return json(400, {
            error: "Deadline must be after the start date and time.",
          });
        }
      }
      if (
        merged.startDate &&
        !escalation.allowsQuarterHourOrExisting(
          merged.startDate,
          existing.startDate
        )
      ) {
        return json(400, {
          error:
            "Start time must be in 15-minute intervals (00, 15, 30, or 45).",
        });
      }
      if (
        merged.dueDate &&
        !escalation.allowsQuarterHourOrExisting(
          merged.dueDate,
          existing.dueDate
        )
      ) {
        return json(400, {
          error:
            "Deadline time must be in 15-minute intervals (00, 15, 30, or 45).",
        });
      }

      if (assigneeFieldsProvided) {
        const blocked = await blockedNewAssignees(nextEmails, currentEmails);
        if (blocked.length) {
          return json(400, {
            error: "Cannot assign a task to a deactivated user.",
          });
        }
        const memberAssign = await taskMutateAccess.assertRestrictedAssigneesAreMembers(
          {
            ddb,
            tableName: process.env.WORK_TABLE,
            project: updateAuth.project,
            emails: nextEmails,
          }
        );
        const memberDenied = denyAuthz(user, memberAssign);
        if (memberDenied) return memberDenied;
      }

      if (
        (assigneeFieldsProvided || timingFieldsProvided) &&
        putChangesAssignedShiftFit({
          currentEmails,
          nextEmails,
          currentStart: existing.startDate,
          nextStart: merged.startDate,
          currentDue: existing.dueDate,
          nextDue: merged.dueDate,
          currentScheduledAssignAt: existing.scheduledAssignAt,
          nextScheduledAssignAt: merged.scheduledAssignAt,
        })
      ) {
        const fitCheck = await validateAssigneesAssignedShiftFit(
          ddb,
          process.env.WORK_TABLE,
          {
            emails: nextEmails,
            startDate: merged.startDate,
            dueDate: merged.dueDate,
            scheduledAssignAt: merged.scheduledAssignAt,
            assignmentState: existing.assignmentState,
          }
        );
        if (!fitCheck.ok) {
          return json(400, shiftFitConflictBody(fitCheck.conflicts));
        }
      }

      const statusLabel = (s) => {
        const map = {
          TODO: "TODO",
          IN_PROGRESS: "IN PROGRESS",
          REVIEW: "IN REVIEW",
          DONE: "COMPLETED",
          CANCELLED: "CANCELLED",
          BACKLOG: "TODO",
        };
        return map[String(s || "").toUpperCase()] || s;
      };

      const applyStatusToAssignment = async (target, nextStatus, remark = "") => {
        if (!target || target.removed) return;
        if (nextStatus === "DONE") {
          const wasComplete = escalation.isComplete(target.status);
          const completed = escalation.completeAssignment(
            target,
            merged.dueDate,
            nowMs,
            nowIso
          );
          Object.assign(target, completed);
          if (!wasComplete && escalation.isComplete(target.status)) {
            if (remark) target.completionRemark = remark;
            completionTransitioned = true;
            completedAssignment = target;
            await appendActivity(
              taskId,
              "task_completed",
              remark
                ? `Completed by ${target.email} (zone ${completed.completedZone}): ${remark}`
                : `Completed by ${target.email} (zone ${completed.completedZone})`,
              user.email,
              {
                assignmentEmail: target.email,
                zone: completed.completedZone,
                ...(remark ? { completionRemark: remark } : {}),
              }
            );
          }
        } else {
          const prev = target.status;
          target.status = nextStatus;
          if (nextStatus !== "DONE") {
            target.completedAt = null;
            target.completedDate = null;
            target.completedZone = null;
          }
          if (prev !== nextStatus) {
            await appendActivity(
              taskId,
              "status_changed",
              `${target.email}: ${statusLabel(prev)} → ${statusLabel(nextStatus)}`,
              user.email,
              { assignmentEmail: target.email }
            );
          }
        }
      };

      if (allowed.status) {
        const actorEmail = escalation.normalizeEmail(user.email);
        const requestedEmail = escalation.normalizeEmail(allowed.assignmentEmail);
        const activeAssignments = assignments.filter((a) => a && !a.removed);
        const selfAssignment = activeAssignments.find(
          (a) => escalation.normalizeEmail(a.email) === actorEmail
        );
        const targetEmail = mayAdminMutate
          ? requestedEmail ||
            (selfAssignment
              ? actorEmail
              : activeAssignments.length === 1
                ? escalation.normalizeEmail(activeAssignments[0].email)
                : "")
          : actorEmail;
        if (targetEmail) {
          const mine = assignments.find(
            (a) =>
              escalation.normalizeEmail(a.email) === targetEmail && !a.removed
          );
          if (mine) {
            const currentStatus = String(mine.status || "").toUpperCase();
            const nextStatus = String(allowed.status || "").toUpperCase();
            if (
              !mayAdminMutate &&
              !escalation.isComplete(mine.status) &&
              !escalation.employeeMayChangeStatus(mine, existing.dueDate, nowMs)
            ) {
              return json(403, {
                error:
                  "Red Zone tasks can only be updated by an administrator.",
              });
            }
            if (!mayAdminMutate && nextStatus === "CANCELLED") {
              // Employees cannot cancel tasks.
            } else if (
              !mayAdminMutate &&
              escalation.isComplete(mine.status)
            ) {
              // Employees cannot reopen a completed assignment.
            } else if (!mayAdminMutate && nextStatus === "REVIEW") {
              return json(400, {
                error: "REVIEW cannot be set directly",
              });
            } else if (!mayAdminMutate && nextStatus === "DONE") {
              if (currentStatus === "REVIEW") {
                return json(400, {
                  error: "This assignment is already in review",
                });
              }
              const remark = String(
                allowed.completionRemark != null
                  ? allowed.completionRemark
                  : updates.completionRemark || ""
              ).trim();
              if (!remark) {
                return json(400, {
                  error: "Completion Remark is required.",
                });
              }
              allowed.completionRemark = remark;
              const prev = mine.status;
              mine.status = "REVIEW";
              mine.completionRemark = remark;
              if (prev !== "REVIEW") {
                await appendActivity(
                  taskId,
                  "status_changed",
                  `${mine.email}: ${statusLabel(prev)} → ${statusLabel("REVIEW")}`,
                  user.email,
                  { assignmentEmail: mine.email }
                );
                reviewSubmitted = {
                  email: mine.email,
                  remark,
                };
              }
            } else {
              await applyStatusToAssignment(mine, allowed.status);
            }
          }
        } else if (mayAdminMutate && allowed.status === "CANCELLED") {
          for (const a of assignments.filter((x) => !x.removed)) {
            await applyStatusToAssignment(a, "CANCELLED");
          }
        }
      }

      if (
        mayAdminMutate &&
        (updates.assignees !== undefined || updates.assignee !== undefined)
      ) {
        const emails = nextEmails;
        const current = new Set(currentEmails);
        const nextSet = new Set(emails);
        for (const a of assignments) {
          const email = escalation.normalizeEmail(a.email);
          if (!nextSet.has(email) && !a.removed) {
            a.removed = true;
            await appendActivity(
              taskId,
              "task_reassigned",
              `Removed assignee ${email}`,
              user.email,
              { assignmentEmail: email }
            );
          }
        }
        for (const email of emails) {
          const existingA = assignments.find(
            (a) => escalation.normalizeEmail(a.email) === email
          );
          if (!existingA) {
            assignments.push({
              email,
              status: "TODO",
              assignedAt: nowIso,
              assignedBy: user.email,
              recordedZone: escalation.zoneAt(
                escalation.parseDeadlineMs(merged.dueDate),
                nowMs
              ),
            });
            await appendActivity(
              taskId,
              "task_assigned",
              `Assigned to ${email}`,
              user.email,
              { assignmentEmail: email }
            );
            await notifyTaskEvent(
              email,
              "TASK_ASSIGNED",
              `New task assigned: ${merged.title}`,
              `You have been assigned "${merged.title}".`,
              `${taskId}#${email}#assigned#${nowIso}`,
              { taskId },
              { channel: "inapp" }
            );
            await notifyAssignedEmployeeEmail(email, merged, {
              assignedByName:
                escalation.pickPersonName(user.name) ||
                escalation.displayNameFromEmail(user.email),
              assignedByEmail: user.email,
              assignedAt: nowIso,
              kind: "assigned",
            });
          } else if (existingA.removed) {
            existingA.removed = false;
            existingA.assignedAt = nowIso;
            existingA.assignedBy = user.email;
            if (!escalation.isComplete(existingA.status)) {
              existingA.status = "TODO";
              existingA.recordedZone = escalation.zoneAt(
                escalation.parseDeadlineMs(merged.dueDate),
                nowMs
              );
            }
            await appendActivity(
              taskId,
              "task_assigned",
              `Assigned to ${email}`,
              user.email,
              { assignmentEmail: email }
            );
            await notifyTaskEvent(
              email,
              "TASK_ASSIGNED",
              `New task assigned: ${merged.title}`,
              `You have been assigned "${merged.title}".`,
              `${taskId}#${email}#assigned#${nowIso}`,
              { taskId },
              { channel: "inapp" }
            );
            await notifyAssignedEmployeeEmail(email, merged, {
              assignedByName:
                escalation.pickPersonName(user.name) ||
                escalation.displayNameFromEmail(user.email),
              assignedByEmail: user.email,
              assignedAt: nowIso,
              kind: "assigned",
            });
          }
        }
        if ([...nextSet].sort().join(",") !== [...current].sort().join(",")) {
          await appendActivity(
            taskId,
            "task_reassigned",
            emails.length
              ? `Assignees: ${emails.join(", ")}`
              : "Task unassigned",
            user.email
          );
        }
      }

      if (
        mayAdminMutate &&
        allowed.dueDate !== undefined &&
        allowed.dueDate !== existing.dueDate
      ) {
        await appendActivity(
          taskId,
          "deadline_changed",
          `Deadline changed from ${existing.dueDate || "none"} → ${
            allowed.dueDate || "none"
          }`,
          user.email,
          { previousDeadline: existing.dueDate || null }
        );
        assignments = assignments.map((a) =>
          escalation.resetEscalationForNewDeadline(a, allowed.dueDate, nowMs)
        );
        delete merged.redAdminNotifyStatus;
        delete merged.redAdminNotifiedAt;
      }

      if (allowed.priority && allowed.priority !== existing.priority) {
        await appendActivity(
          taskId,
          "priority_changed",
          `Priority changed from ${existing.priority} → ${allowed.priority}`,
          user.email
        );
      }
      if (allowed.archived === true && !existing.archived) {
        await appendActivity(
          taskId,
          "task_archived",
          "Task archived",
          user.email
        );
      }
      if (
        (allowed.title && allowed.title !== existing.title) ||
        (allowed.description !== undefined &&
          allowed.description !== existing.description)
      ) {
        await appendActivity(
          taskId,
          "task_updated",
          "Task details updated",
          user.email
        );
      }

      const saved = await persistAssignmentsAndTask(merged, assignments);
      if (reviewSubmitted) {
        try {
          let projectName = "";
          let employeeName = "";
          try {
            projectName = (await getProjectName(saved.projectId)) || "";
          } catch (err) {
            console.error("TASK_REVIEW_PROJECT_NAME_ERROR", err?.name);
          }
          try {
            const profile = await getAssigneeProfile(reviewSubmitted.email);
            employeeName =
              escalation.pickPersonName(profile?.name) ||
              escalation.displayNameFromEmail(reviewSubmitted.email);
          } catch (err) {
            employeeName = escalation.displayNameFromEmail(reviewSubmitted.email);
            console.error("TASK_REVIEW_EMPLOYEE_NAME_ERROR", err?.name);
          }
          await notifyTaskSubmittedForReview({
            ddb,
            tableName: process.env.WORK_TABLE,
            accessTable: process.env.USER_ACCESS_TABLE,
            task: saved,
            employeeEmail: reviewSubmitted.email,
            employeeName,
            completionRemark: reviewSubmitted.remark,
            projectName,
          });
        } catch (err) {
          console.error(
            "TASK_REVIEW_SUBMITTED_EMAIL_ERROR",
            JSON.stringify({ taskId })
          );
          console.error(err);
        }
      }
      if (completionTransitioned && escalation.isComplete(saved.status)) {
        try {
          let projectName = "";
          let employeeName = "";
          try {
            projectName = (await getProjectName(saved.projectId)) || "";
          } catch (err) {
            console.error("TASK_COMPLETED_PROJECT_NAME_ERROR", err?.name);
          }
          const employeeEmail = completedAssignment?.email || "";
          if (employeeEmail) {
            try {
              const profile = await getAssigneeProfile(employeeEmail);
              employeeName =
                escalation.pickPersonName(profile?.name) ||
                escalation.displayNameFromEmail(employeeEmail);
            } catch {
              employeeName = escalation.displayNameFromEmail(employeeEmail);
            }
          }
          await notifyTaskCompleted({
            ddb,
            tableName: process.env.WORK_TABLE,
            accessTable: process.env.USER_ACCESS_TABLE,
            task: saved,
            assignment: completedAssignment,
            employeeEmail,
            employeeName,
            completedBy: user.email,
            completedByName:
              escalation.pickPersonName(user.name) ||
              escalation.displayNameFromEmail(user.email),
            completedAt: completedAssignment?.completedAt || nowIso,
            completionRemark: completedAssignment?.completionRemark || "",
            nowMs,
            projectName,
          });
        } catch (err) {
          console.error(
            "TASK_COMPLETED_EMAIL_ERROR",
            JSON.stringify({ taskId })
          );
          console.error(err);
        }
      }
      void projectId;
      return json(
        200,
        escalation.decorateTask(saved, nowMs, user.email)
      );
    }

    // Soft-delete / archive via PUT preferred; hard delete for admin
    if (path.endsWith("/tasks") && method === "DELETE") {
      if (!escalation.normalizeEmail(user.email)) {
        return json(401, { error: "Unauthorized" });
      }
      const taskId = body.taskId || event.queryStringParameters?.taskId;
      if (!taskId) return json(400, { error: "taskId required" });
      const existing = await getTask(taskId);
      if (!existing) return json(404, { error: "Task not found" });

      const deleteAuth = await taskMutateAccess.authorizeTaskDelete({
        ...taskReadAuthArgs(user, existing, taskReadCache),
        task: existing,
      });
      if (!deleteAuth.ok) {
        return json(500, { error: "Internal server error" });
      }
      if (!deleteAuth.allowed) {
        return json(403, { error: "Forbidden" });
      }

      const merged = {
        ...existing,
        archived: true,
        status: existing.status,
        updatedAt: new Date().toISOString(),
      };
      const copies = await putTaskCopies(merged);
      assertPersistOk(copies, {
        op: "archiveTask",
        taskId,
        PK: merged.PK,
        SK: merged.SK,
      });
      await appendActivity(taskId, "task_archived", "Task archived", user.email);
      return json(200, { message: "Task archived", task: merged });
    }

    // ── TIME ENTRIES ──
    if (path.endsWith("/time-entries") && method === "POST") {
      if (!escalation.normalizeEmail(user.email)) {
        return json(401, { error: "Unauthorized" });
      }
      const { taskId, minutes, note } = body;
      if (!taskId || !minutes) {
        return json(400, { error: "taskId and minutes required" });
      }
      const task = await getTask(taskId);
      if (!task) return json(404, { error: "Task not found" });
      const timeAuth = await taskReadAccess.authorizeTaskRead(
        taskReadAuthArgs(user, task, taskReadCache)
      );
      const timeDenied = denyAuthz(user, timeAuth);
      if (timeDenied) return timeDenied;

      const id = randomUUID();
      const now = new Date().toISOString();
      const item = {
        PK: `USER#${user.email}`,
        SK: `TIME#${now}#${id}`,
        timeId: id,
        taskId: task.taskId,
        projectId: task.projectId || null,
        email: user.email,
        minutes: Number(minutes),
        note: note || "",
        date: now.slice(0, 10),
        createdAt: now,
      };

      await ddb.send(
        new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
      );
      return json(201, item);
    }

    if (path.endsWith("/time-entries") && method === "GET") {
      if (!escalation.normalizeEmail(user.email)) {
        return json(401, { error: "Unauthorized" });
      }
      const lookup = await workflowAccess.resolveTimeEntryQueryEmail({
        user,
        requestedEmail: event.queryStringParameters?.email,
        ddb,
        accessTable: process.env.USER_ACCESS_TABLE,
      });
      if (!lookup.ok) {
        return json(lookup.statusCode, lookup.body);
      }
      const email = lookup.email;

      const res = await ddb.send(
        new QueryCommand({
          TableName: process.env.WORK_TABLE,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: {
            ":pk": `USER#${email}`,
            ":sk": "TIME#",
          },
          ScanIndexForward: false,
        })
      );

      const items = res.Items || [];
      const visible = [];
      for (const entry of items) {
        const entryTaskId = String(entry.taskId || "").trim();
        if (!entryTaskId) continue;
        const task = await getTask(entryTaskId);
        if (!task) continue;
        const decision = await taskReadAccess.authorizeTaskRead(
          taskReadAuthArgs(user, task, taskReadCache)
        );
        if (!decision.ok) {
          return json(500, { error: "Internal server error" });
        }
        if (decision.allowed) visible.push(entry);
      }

      return json(200, visible);
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    if (err instanceof PersistConflictError) {
      return json(err.statusCode || 409, { error: err.message });
    }
    console.error("Projects error:", err);
    return json(500, { error: "Internal server error" });
  }
};

exports.STATUSES = STATUSES;
exports.PRIORITIES = PRIORITIES;
exports.canViewTask = canViewTask;
exports.collectBlockedNewAssignees = collectBlockedNewAssignees;
exports.newAssignmentEmails = newAssignmentEmails;
exports.isBlockedAccessStatus = isBlockedAccessStatus;
exports.setClientsForTests = function setClientsForTests(clients = {}) {
  if (Object.prototype.hasOwnProperty.call(clients, "ddb")) ddb = clients.ddb;
};

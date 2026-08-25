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
const weekly = require("./redzoneWeekly");
const { zoneNotifyCopy } = require("./zoneNotify");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
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
  // /tasks/{taskId} or /prod/tasks/{taskId}
  const m = String(path).match(/\/tasks\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) return null;
  return { taskId: decodeURIComponent(m[1]), sub: m[2] || null };
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
  await ddb.send(
    new PutCommand({ TableName: process.env.WORK_TABLE, Item: task })
  );
  if (task.projectId) {
    await ddb.send(
      new PutCommand({
        TableName: process.env.WORK_TABLE,
        Item: {
          ...task,
          PK: `PROJECT#${task.projectId}`,
          SK: `TASK#${task.taskId}`,
        },
      })
    );
  }
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

async function writeAssignment(taskId, assignment) {
  const email = escalation.normalizeEmail(assignment.email);
  if (!email) return null;
  const item = {
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
    removed: !!assignment.removed,
  };
  await ddb.send(
    new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
  );
  return item;
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
      highestZone: a.highestZone || null,
      recordedZone: a.recordedZone || null,
      zoneReachedAt: a.zoneReachedAt || null,
      removed: !!a.removed,
    })),
    status: escalation.deriveParentStatus(assignments, task.status),
  };
}

async function persistAssignmentsAndTask(task, assignments) {
  for (const a of assignments) {
    await writeAssignment(task.taskId, a);
  }
  const merged = snapshotTask(task, assignments);
  merged.updatedAt = new Date().toISOString();
  await putTaskCopies(merged);
  return merged;
}

async function notifyTaskEvent(email, type, title, message, dedupKey, extra = {}) {
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
    });
  } catch (err) {
    console.error("Task notification failed", err);
  }
}

async function persistEscalations(task, nowMs = Date.now()) {
  const assignments = await resolveAssignments(task);
  let changed = false;
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
    next.push(result.assignment);
    for (const ev of result.events) {
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
      await notifyTaskEvent(
        a.email,
        copy.type,
        copy.title,
        copy.message,
        `${task.taskId}#${a.email}#${ev.action}#${task.dueDate || ""}`,
        {
          taskId: task.taskId,
          zone: copy.zone,
          category: copy.category,
          deadline: task.dueDate || null,
          zoneStartedAt: ev.timestamp,
        }
      );
    }
    if (
      escalation.approachingDeadline(task.dueDate, nowMs) &&
      escalation.isOpenStatus(a.status)
    ) {
      await notifyTaskEvent(
        a.email,
        "TASK_DUE_SOON",
        `Task due soon: ${task.title}`,
        `"${task.title}" is approaching its deadline.`,
        `${task.taskId}#${a.email}#due-soon#${task.dueDate || ""}`,
        { taskId: task.taskId }
      );
    }
  }
  if (changed) {
    return persistAssignmentsAndTask(task, next);
  }
  return snapshotTask(task, next);
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

function isRedZoneReportPath(path) {
  return /\/tasks\/redzone-report\/?$/.test(String(path || ""));
}

async function runEscalationSweep() {
  const tasks = await queryAllTasks();
  let processed = 0;
  for (const task of tasks) {
    if (task.archived) continue;
    await persistEscalations(task);
    processed += 1;
  }
  return json(200, { ok: true, processed });
}

async function scanProfiles() {
  if (!process.env.USER_PROFILE_TABLE) return weekly.indexProfiles([]);
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return weekly.indexProfiles(items);
}

async function loadWeeklyConfig() {
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: { PK: weekly.CONFIG_PK, SK: weekly.CONFIG_SK },
    })
  );
  return weekly.normalizeConfig(res.Item);
}

async function saveWeeklyConfig(body, actor) {
  const current = await loadWeeklyConfig();
  const next = weekly.normalizeConfig({
    enabled: body.enabled === undefined ? current.enabled : body.enabled,
    weekday: body.weekday === undefined ? current.weekday : body.weekday,
    sendTime: body.sendTime || current.sendTime,
  });
  const item = {
    PK: weekly.CONFIG_PK,
    SK: weekly.CONFIG_SK,
    enabled: next.enabled,
    weekday: next.weekday,
    sendTime: next.sendTime,
    dgvEmail: weekly.DGV_EMAIL,
    updatedAt: new Date().toISOString(),
    updatedBy: actor || "",
  };
  await ddb.send(
    new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
  );
  return weekly.normalizeConfig(item);
}

async function getWeeklyReport(weekId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: { PK: weekly.REPORT_PK, SK: `WEEK#${weekId}` },
    })
  );
  return res.Item || null;
}

async function putWeeklyReport(item) {
  await ddb.send(
    new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
  );
}

async function listWeeklyReports() {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": weekly.REPORT_PK,
        ":sk": "WEEK#",
      },
      ScanIndexForward: false,
      Limit: 20,
    })
  );
  return res.Items || [];
}

async function gatherRedZoneRows(nowMs) {
  const tasks = await queryAllTasks();
  const snaps = [];
  for (const task of tasks) {
    if (task.archived) continue;
    const assignments = await resolveAssignments(task);
    snaps.push(snapshotTask(task, assignments));
  }
  const profiles = await scanProfiles();
  return weekly.enrichRows(
    weekly.collectRedZoneRows(snaps, nowMs),
    profiles,
    nowMs
  );
}

async function sendWeeklyEmail(email, rows, weekId) {
  const { dispatchNotification } = require("../common/notify");
  const subject = rows.length
    ? "Weekly Red-Zone Ticket Report"
    : "Weekly Red-Zone Ticket Report — none";
  return dispatchNotification(ddb, {
    email,
    type: "TASK_REDZONE_WEEKLY",
    title: subject,
    subject,
    message: weekly.buildReportText(rows),
    html: weekly.buildReportHtml(rows, email),
    reason: "WEEKLY_REDZONE",
    dedupKey: `${weekId}#${email}`,
    extra: { weekId, count: rows.length },
  });
}

async function runWeeklyRedZoneReport({ source = "schedule" } = {}) {
  const now = new Date();
  const nowMs = now.getTime();
  const config = await loadWeeklyConfig();
  const tz = weekly.companyTimeZone();
  const weekId = weekly.weekIdFor(now, tz, config.weekday);

  console.log(
    "REDZONE_WEEKLY_START",
    JSON.stringify({
      source,
      weekId,
      enabled: config.enabled,
      weekday: config.weekday,
      sendTime: config.sendTime,
    })
  );

  if (source === "schedule" && !weekly.shouldSendNow(config, now, tz)) {
    console.log(
      "REDZONE_WEEKLY_SKIP",
      JSON.stringify({ reason: "NOT_SCHEDULED", weekId })
    );
    return { skipped: true, reason: "NOT_SCHEDULED", weekId };
  }

  let existing = await getWeeklyReport(weekId);
  if (existing && weekly.alreadySent(existing)) {
    console.log(
      "REDZONE_WEEKLY_SKIP",
      JSON.stringify({ reason: "ALREADY_SENT", weekId, status: existing.status })
    );
    return { skipped: true, reason: "ALREADY_SENT", weekId, report: existing };
  }
  if (existing && weekly.isInFlight(existing, nowMs) && source === "schedule") {
    console.log(
      "REDZONE_WEEKLY_SKIP",
      JSON.stringify({ reason: "IN_FLIGHT", weekId })
    );
    return { skipped: true, reason: "IN_FLIGHT", weekId };
  }

  const rows = await gatherRedZoneRows(nowMs);
  const grouped = weekly.groupByRecipient(rows, config.dgvEmail);
  const recipients = Object.keys(grouped);
  const toSend = weekly.emailsToSend(grouped, existing);

  console.log(
    "REDZONE_WEEKLY_FOUND",
    JSON.stringify({
      redCount: rows.length,
      recipients,
      toSend,
      weekId,
    })
  );

  const pending = {
    PK: weekly.REPORT_PK,
    SK: `WEEK#${weekId}`,
    weekId,
    status: "PENDING",
    source,
    taskIds: [...new Set(rows.map((r) => r.taskId))],
    redCount: rows.length,
    recipients,
    results: existing?.results || [],
    createdAt: existing?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
  };

  if (!existing) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: process.env.WORK_TABLE,
          Item: pending,
          ConditionExpression: "attribute_not_exists(PK)",
        })
      );
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        const raced = await getWeeklyReport(weekId);
        if (
          raced &&
          (weekly.alreadySent(raced) || weekly.isInFlight(raced, nowMs))
        ) {
          return { skipped: true, reason: "RACE", weekId, report: raced };
        }
        existing = raced;
      } else {
        throw err;
      }
    }
  } else {
    await putWeeklyReport(pending);
  }

  const results = [];
  for (const email of recipients) {
    if (!toSend.includes(email)) {
      const prev = (existing?.results || []).find(
        (r) => escalation.normalizeEmail(r.email) === email
      );
      if (prev) results.push(prev);
      continue;
    }
    const sendRows = grouped[email] || [];
    try {
      const result = await sendWeeklyEmail(email, sendRows, weekId);
      results.push({
        email,
        status: result.status,
        error: result.error || null,
        messageId: result.messageId || null,
        skipped: !!result.skipped,
      });
      if (result.status === "FAILED") {
        console.error(
          "REDZONE_WEEKLY_FAILED",
          JSON.stringify({ email, weekId, error: result.error })
        );
      } else {
        console.log(
          "REDZONE_WEEKLY_SENT",
          JSON.stringify({
            email,
            weekId,
            count: sendRows.length,
            status: result.status,
          })
        );
      }
    } catch (err) {
      results.push({
        email,
        status: "FAILED",
        error: err.name || "SEND_ERROR",
      });
      console.error(
        "REDZONE_WEEKLY_FAILED",
        JSON.stringify({ email, weekId, error: err.name })
      );
    }
  }

  const failed = results.filter((r) => r.status === "FAILED").length;
  const sent = results.filter((r) => r.status === "SENT").length;
  let status = "SENT";
  if (!rows.length && sent) status = "EMPTY";
  else if (failed && sent) status = "PARTIAL";
  else if (failed && !sent) status = "FAILED";
  else if (!sent && !failed) status = rows.length ? "FAILED" : "EMPTY";

  const saved = {
    ...pending,
    status,
    results,
    sentAt: status === "FAILED" ? existing?.sentAt || null : now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await putWeeklyReport(saved);
  console.log(
    "REDZONE_WEEKLY_DONE",
    JSON.stringify({
      weekId,
      status,
      redCount: rows.length,
      sent,
      failed,
      source,
    })
  );
  return {
    skipped: false,
    weekId,
    status,
    redCount: rows.length,
    sent,
    failed,
    report: saved,
  };
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
      const sweep = await runEscalationSweep();
      try {
        await runWeeklyRedZoneReport({ source: "schedule" });
      } catch (err) {
        console.error("REDZONE_WEEKLY_ERROR", err);
      }
      return sweep;
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

  try {
    if (isRedZoneReportPath(path)) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });

      if (method === "GET") {
        const config = await loadWeeklyConfig();
        const history = await listWeeklyReports();
        const weekId = weekly.weekIdFor(
          new Date(),
          weekly.companyTimeZone(),
          config.weekday
        );
        const last = history[0] || (await getWeeklyReport(weekId));
        return json(200, {
          config,
          weekId,
          last: last || null,
          history,
          timezone: weekly.companyTimeZone(),
        });
      }

      if (method === "PUT") {
        const config = await saveWeeklyConfig(body, user.email);
        return json(200, { config });
      }

      if (method === "POST") {
        const result = await runWeeklyRedZoneReport({ source: "manual" });
        return json(200, result);
      }

      return json(405, { error: "Method not allowed" });
    }

    // ── TASK BY ID / COMMENTS / ACTIVITY / ATTACHMENTS ──
    if (taskRoute) {
      const { taskId, sub } = taskRoute;
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
        const email = String(user.email || "").toLowerCase();
        const ownPrefix = email ? `profiles/${email}/` : "";
        const taskPrefix = taskId ? `tasks/${taskId}/` : "";
        const allowed =
          user.isAdmin ||
          (task && escalation.taskAssignedTo(task, user.email)) ||
          (ownPrefix && objectKey.startsWith(ownPrefix)) ||
          (taskPrefix && objectKey.startsWith(taskPrefix));
        if (!allowed) return json(403, { error: "Forbidden" });
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
        if (!user.isAdmin && !escalation.taskAssignedTo(snap, user.email)) {
          return json(403, { error: "Forbidden" });
        }

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
      const canAccess =
        user.isAdmin || escalation.taskAssignedTo(task, user.email);
      if (!canAccess) return json(403, { error: "Forbidden" });

      // Comments
      if (sub === "comments" && method === "GET") {
        const items = await listByPrefix(`TASK#${taskId}`, "COMMENT#");
        return json(200, items);
      }

      if (sub === "comments" && method === "POST") {
        const text = String(body.text || body.comment || "").trim();
        if (!text) return json(400, { error: "Comment text required" });
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
        if (!user.isAdmin && !escalation.taskAssignedTo(task, user.email)) {
          return json(403, { error: "Forbidden" });
        }
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
        if (!user.isAdmin && !escalation.taskAssignedTo(task, user.email)) {
          return json(403, { error: "Forbidden" });
        }
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
      const res = await ddb.send(
        new QueryCommand({
          TableName: process.env.WORK_TABLE,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "ENTITY#PROJECT" },
        })
      );
      return json(200, res.Items || []);
    }

    if (path.endsWith("/projects") && method === "POST") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const id = randomUUID();
      const item = {
        PK: "ENTITY#PROJECT",
        SK: `PROJECT#${id}`,
        projectId: id,
        name: body.name,
        client: body.client || "",
        lead: body.lead || user.email,
        members: body.members || [],
        status: body.status || "ACTIVE",
        description: body.description || "",
        createdAt: new Date().toISOString(),
        createdBy: user.email,
      };
      await ddb.send(
        new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
      );
      return json(201, item);
    }

    // ── TASKS LIST / CREATE / UPDATE ──
    if (path.endsWith("/tasks") && method === "GET") {
      const {
        projectId,
        assignee,
        mine,
        zone,
        q,
        search,
        priority,
      } = event.queryStringParameters || {};
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

      const focusEmail =
        mine === "true" ? user.email : assignee || "";

      if (mine === "true" || assignee) {
        items = items.filter((t) =>
          escalation.taskAssignedTo(t, focusEmail || user.email)
        );
      }

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
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const projectId = body.projectId;
      if (!projectId) {
        return json(400, { error: "projectId and title required" });
      }

      const parsed = escalation.validateCreatePayload(body);
      if (!parsed.ok) {
        const first = Object.values(parsed.errors)[0] || "Unable to create task. Please try again.";
        return json(400, { error: first, errors: parsed.errors });
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const nowMs = Date.now();
      const emails = parsed.emails;
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

      await persistAssignmentsAndTask(item, assignments);
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
        for (const email of emails) {
          await notifyTaskEvent(
            email,
            "TASK_ASSIGNED",
            `New task assigned: ${item.title}`,
            `You have been assigned "${item.title}".`,
            `${id}#${email}#assigned#${now}`,
            { taskId: id }
          );
        }
      }

      return json(201, escalation.decorateTask(item, nowMs, user.email));
    }

    if (path.endsWith("/tasks") && method === "PUT") {
      const { taskId, projectId, ...updates } = body;
      if (!taskId) return json(400, { error: "taskId required" });

      const existing = await getTask(taskId);
      if (!existing) return json(404, { error: "Task not found" });

      let assignments = await resolveAssignments(existing);
      const snapExisting = snapshotTask(existing, assignments);
      const isAssignee = escalation.taskAssignedTo(snapExisting, user.email);
      if (!user.isAdmin && !isAssignee) return json(403, { error: "Forbidden" });

      const allowed = user.isAdmin
        ? updates
        : {
            status: updates.status,
            assignmentEmail: updates.assignmentEmail,
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

      const nowIso = new Date().toISOString();
      const nowMs = Date.now();
      const merged = {
        ...existing,
        ...allowed,
        taskId: existing.taskId,
        PK: "ENTITY#TASK",
        SK: `TASK#${taskId}`,
        createdBy: existing.createdBy,
        createdByName:
          existing.createdByName || escalation.creatorDisplayName(existing),
        updatedAt: nowIso,
      };

      delete merged.assignmentEmail;
      delete merged.assignees;
      delete merged.zone;
      delete merged.overdue;
      delete merged.timing;
      delete merged.myAssignment;
      delete merged.assigneeProfiles;
      delete merged.displayStatus;
      delete merged.priorityLabel;

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

      const applyStatusToAssignment = async (target, nextStatus) => {
        if (!target || target.removed) return;
        if (nextStatus === "DONE") {
          const completed = escalation.completeAssignment(
            target,
            merged.dueDate,
            nowMs,
            nowIso
          );
          Object.assign(target, completed);
          await appendActivity(
            taskId,
            "task_completed",
            `Completed by ${target.email} (zone ${completed.completedZone})`,
            user.email,
            { assignmentEmail: target.email, zone: completed.completedZone }
          );
          await notifyTaskEvent(
            target.email,
            "TASK_COMPLETED",
            `Task completed: ${merged.title}`,
            `"${merged.title}" was marked completed.`,
            `${taskId}#${target.email}#completed#${nowIso}`,
            { taskId }
          );
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
        const targetEmail = user.isAdmin
          ? escalation.normalizeEmail(allowed.assignmentEmail) ||
            (assignments.filter((a) => !a.removed).length <= 1
              ? assignments.find((a) => !a.removed)?.email
              : "")
          : user.email;
        if (targetEmail) {
          const mine = assignments.find(
            (a) =>
              escalation.normalizeEmail(a.email) === targetEmail && !a.removed
          );
          if (mine) {
            if (
              !user.isAdmin &&
              escalation.isComplete(mine.status) &&
              allowed.status !== "DONE"
            ) {
              // Employees cannot reopen a completed assignment.
            } else if (!user.isAdmin && allowed.status === "CANCELLED") {
              // Employees cannot cancel tasks.
            } else {
              await applyStatusToAssignment(mine, allowed.status);
            }
          }
        } else if (user.isAdmin && allowed.status === "CANCELLED") {
          for (const a of assignments.filter((x) => !x.removed)) {
            await applyStatusToAssignment(a, "CANCELLED");
          }
        }
      }

      if (
        user.isAdmin &&
        (updates.assignees !== undefined || updates.assignee !== undefined)
      ) {
        const emails = escalation.normalizeEmailList(
          updates.assignees !== undefined ? updates.assignees : updates.assignee,
          null
        );
        const current = new Set(
          assignments
            .filter((a) => !a.removed)
            .map((a) => escalation.normalizeEmail(a.email))
        );
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
              { taskId }
            );
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
        user.isAdmin &&
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

      const saved = await persistAssignmentsAndTask(merged, assignments);
      void projectId;
      return json(
        200,
        escalation.decorateTask(saved, nowMs, user.email)
      );
    }

    // Soft-delete / archive via PUT preferred; hard delete for admin
    if (path.endsWith("/tasks") && method === "DELETE") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const taskId = body.taskId || event.queryStringParameters?.taskId;
      if (!taskId) return json(400, { error: "taskId required" });
      const existing = await getTask(taskId);
      if (!existing) return json(404, { error: "Task not found" });

      const merged = {
        ...existing,
        archived: true,
        status: existing.status,
        updatedAt: new Date().toISOString(),
      };
      await putTaskCopies(merged);
      await appendActivity(taskId, "task_archived", "Task archived", user.email);
      return json(200, { message: "Task archived", task: merged });
    }

    // ── TIME ENTRIES ──
    if (path.endsWith("/time-entries") && method === "POST") {
      if (!user.email) return json(401, { error: "Unauthorized" });
      const { taskId, minutes, note, projectId } = body;
      if (!taskId || !minutes) {
        return json(400, { error: "taskId and minutes required" });
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const item = {
        PK: `USER#${user.email}`,
        SK: `TIME#${now}#${id}`,
        timeId: id,
        taskId,
        projectId: projectId || null,
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
      const email =
        user.isAdmin && event.queryStringParameters?.email
          ? event.queryStringParameters.email
          : user.email;

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

      return json(200, res.Items || []);
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Projects error:", err);
    return json(500, { error: "Internal server error" });
  }
};

exports.STATUSES = STATUSES;
exports.PRIORITIES = PRIORITIES;

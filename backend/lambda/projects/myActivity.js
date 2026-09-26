const { GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { companyDateKey } = require("../common/shiftWindows");
const { loadCurrentAssignedShift } = require("../attendance/assignedShift");
const escalation = require("./escalation");
const { isPendingScheduledTask } = require("./shiftCatalog");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_LIMIT = 50;
const ACTIVITY_PER_TASK = 20;
const PRESENCE_EVENT_LIMIT = 50;
const SHIFT_SOURCE_SNAPSHOT = "attendance_snapshot";
const SHIFT_SOURCE_CURRENT = "current";
const SHIFT_SOURCE_NONE = "none";

function emptyAttendance() {
  return {
    marked: false,
    status: null,
    workPeriod: null,
    expectedStartTime: null,
    expectedEndTime: null,
    actualCheckInTime: null,
    actualCheckOutTime: null,
    timingStatus: null,
    lateMinutes: null,
    workedBeyondShift: false,
    workedBeyondReason: null,
  };
}

function emptyShift() {
  return {
    shiftId: null,
    name: null,
    startTime: null,
    endTime: null,
    crossesMidnight: false,
    graceMinutes: 0,
    source: SHIFT_SOURCE_NONE,
  };
}

function emptyPresence() {
  return {
    kind: "portal_presence",
    notWorkingHours: true,
    lastSeen: null,
    eventCount: 0,
    events: [],
  };
}

function isValidDateKey(value) {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function resolveDateKey(raw, nowMs) {
  const explicit = String(raw || "").trim();
  if (explicit) {
    if (!isValidDateKey(explicit)) {
      return { ok: false, error: "date must be YYYY-MM-DD." };
    }
    return { ok: true, date: explicit };
  }
  const today = companyDateKey(new Date(nowMs));
  if (!today) return { ok: false, error: "Unable to resolve company date." };
  return { ok: true, date: today };
}

function companyHm(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.COMPANY_TIMEZONE || "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (hour == null || minute == null) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

async function queryAll(ddb, params) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        ...params,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function getItem(ddb, tableName, key) {
  if (!ddb || !tableName) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: key,
    })
  );
  return res.Item || null;
}

function mapAttendance(item) {
  if (!item) return emptyAttendance();
  return {
    marked: true,
    status: item.status || null,
    workPeriod: item.workPeriod || null,
    expectedStartTime: item.expectedStartTime || null,
    expectedEndTime: item.expectedEndTime || null,
    actualCheckInTime: item.actualCheckInTime || null,
    actualCheckOutTime: item.actualCheckOutTime || null,
    timingStatus: item.timingStatus || null,
    lateMinutes: item.lateMinutes ?? null,
    workedBeyondShift: item.workedBeyondShift === true,
    workedBeyondReason: item.workedBeyondReason || null,
  };
}

function shiftFromAttendance(item) {
  if (!item) return null;
  const name = item.shiftName || item.shift || null;
  const startTime =
    item.startTime || companyHm(item.expectedStartTime) || null;
  const endTime = item.endTime || companyHm(item.expectedEndTime) || null;
  const shiftId = item.shiftId || null;
  if (!shiftId && !name && !startTime && !endTime && item.expectedStartTime == null) {
    return null;
  }
  return {
    shiftId,
    name,
    startTime,
    endTime,
    crossesMidnight: item.crossesMidnight === true,
    graceMinutes: Number(item.graceMinutes || 0),
    source: SHIFT_SOURCE_SNAPSHOT,
  };
}

function shiftFromCurrent(assignment) {
  if (!assignment) return emptyShift();
  return {
    shiftId: assignment.shiftId || null,
    name: assignment.name || null,
    startTime: assignment.startTime || null,
    endTime: assignment.endTime || null,
    crossesMidnight: !!assignment.crossesMidnight,
    graceMinutes: Number(assignment.graceMinutes || 0),
    source: SHIFT_SOURCE_CURRENT,
  };
}

function completedOnDate(assignment, dateKey) {
  if (!assignment) return false;
  if (String(assignment.completedDate || "") === dateKey) return true;
  if (assignment.completedAt && companyDateKey(assignment.completedAt) === dateKey) {
    return true;
  }
  return false;
}

function shouldIncludeAssignment(assignment, dateKey) {
  if (!assignment || assignment.removed) return false;
  if (escalation.isOpenStatus(assignment.status)) return true;
  return completedOnDate(assignment, dateKey);
}

function publicActivity(item) {
  return {
    timestamp: item.timestamp || "",
    action: item.action || "",
    detail: item.detail || "",
    actorEmail: item.actorEmail || "",
    assignmentEmail: item.assignmentEmail || "",
  };
}

function activityVisibleToEmployee(item, email) {
  const assigned = escalation.normalizeEmail(item?.assignmentEmail);
  if (!assigned) return true;
  return assigned === email;
}

function publicPresenceEvent(item) {
  return {
    timestamp: item.timestamp || "",
    type: item.type || "",
    page: item.page || null,
    device: item.device || null,
  };
}

async function loadEmployee(ddb, profileTable, email) {
  const profile = await getItem(ddb, profileTable, {
    PK: `USER#${email}`,
    SK: "PROFILE",
  });
  return {
    email,
    name: profile?.name || "",
    empId: profile?.empId || "",
    department: profile?.department || "",
  };
}

async function loadPresence(ddb, activityTable, email, dateKey) {
  const presence = emptyPresence();
  if (!activityTable) return presence;
  const summary = await getItem(ddb, activityTable, {
    PK: `SUMMARY#${email}`,
    SK: `DAY#${dateKey}`,
  });
  if (summary) {
    presence.lastSeen = summary.lastSeen || null;
    presence.eventCount = Number(summary.eventCount || 0);
  }
  const events = await queryAll(ddb, {
    TableName: activityTable,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `USER#${email}`,
      ":sk": "EVENT#",
    },
    ScanIndexForward: false,
  });
  const scoped = events
    .filter((item) => String(item.date || "") === dateKey)
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, PRESENCE_EVENT_LIMIT)
    .map(publicPresenceEvent);
  presence.events = scoped;
  if (!presence.eventCount) presence.eventCount = scoped.length;
  if (!presence.lastSeen && scoped[0]?.timestamp) {
    presence.lastSeen = scoped[0].timestamp;
  }
  return presence;
}

async function loadTaskActivity(ddb, workTable, taskId, dateKey, email) {
  const items = await queryAll(ddb, {
    TableName: workTable,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `TASK#${taskId}`,
      ":sk": "ACTIVITY#",
    },
    ScanIndexForward: false,
  });
  return items
    .filter((item) => {
      const ts = item.timestamp || "";
      if (!ts || companyDateKey(ts) !== dateKey) return false;
      return activityVisibleToEmployee(item, email);
    })
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, ACTIVITY_PER_TASK)
    .map(publicActivity);
}

async function loadTasks(ddb, workTable, email, dateKey, nowMs) {
  const tasks = await queryAll(ddb, {
    TableName: workTable,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
  });
  const out = [];
  for (const task of tasks) {
    if (task?.archived) continue;
    if (isPendingScheduledTask(task)) continue;
    const taskId = String(task.taskId || "").trim();
    if (!taskId) continue;
    const assignment = await getItem(ddb, workTable, {
      PK: `TASK#${taskId}`,
      SK: `ASSIGNMENT#${email}`,
    });
    if (!shouldIncludeAssignment(assignment, dateKey)) continue;
    const decorated = escalation.decorateTask(
      {
        ...task,
        assignments: [assignment],
      },
      nowMs,
      email
    );
    const mine = decorated.myAssignment || assignment;
    const activity = await loadTaskActivity(ddb, workTable, taskId, dateKey, email);
    out.push({
      taskId,
      title: task.title || "",
      projectId: task.projectId || "",
      taskStatus: decorated.status || task.status || "",
      assignmentStatus: mine.status || "",
      assignedAt: mine.assignedAt || null,
      completedAt: mine.completedAt || null,
      startDate: task.startDate || null,
      dueDate: task.dueDate || null,
      zone: decorated.zone || null,
      overdue: !!decorated.overdue,
      timing: decorated.timing || null,
      activity,
    });
    if (out.length >= TASK_LIMIT) break;
  }
  return out;
}

async function handleGetMyActivity({
  user,
  query = {},
  ddb,
  nowMs = Date.now(),
  workTable = process.env.WORK_TABLE,
  attendanceTable = process.env.ATTENDANCE_TABLE,
  profileTable = process.env.USER_PROFILE_TABLE,
  activityTable = process.env.ACTIVITY_TABLE,
} = {}) {
  const email = escalation.normalizeEmail(user?.email);
  if (!email) {
    return { statusCode: 401, body: { error: "Unauthorized" } };
  }

  const resolved = resolveDateKey(query.date, nowMs);
  if (!resolved.ok) {
    return { statusCode: 400, body: { error: resolved.error } };
  }
  const date = resolved.date;

  try {
    const attendanceItem = await getItem(ddb, attendanceTable, {
      PK: email,
      SK: date,
    });
    const attendance = mapAttendance(attendanceItem);
    const snapshotShift = shiftFromAttendance(attendanceItem);
    const current = snapshotShift
      ? null
      : await loadCurrentAssignedShift(ddb, workTable, email);
    const shift = snapshotShift || shiftFromCurrent(current);
    const [employee, tasks, presence] = await Promise.all([
      loadEmployee(ddb, profileTable, email),
      loadTasks(ddb, workTable, email, date, nowMs),
      loadPresence(ddb, activityTable, email, date),
    ]);

    return {
      statusCode: 200,
      body: {
        date,
        employee,
        shift,
        attendance,
        tasks,
        presence,
      },
    };
  } catch (err) {
    console.error("MY_ACTIVITY_ERROR", err?.name || "ERROR");
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
}

function myActivityPathMatch(path) {
  return /\/me\/activity$/.test(String(path || "").replace(/\/+$/, ""));
}

module.exports = {
  TASK_LIMIT,
  ACTIVITY_PER_TASK,
  SHIFT_SOURCE_SNAPSHOT,
  SHIFT_SOURCE_CURRENT,
  SHIFT_SOURCE_NONE,
  isValidDateKey,
  resolveDateKey,
  myActivityPathMatch,
  handleGetMyActivity,
};

const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const {
  addDaysIso,
  companyDateKey,
  parseInstantMs,
  taskFitsWindow,
  windowMsFromRecord,
} = require("../common/shiftWindows");

const ACTION_ASSIGN = "ASSIGN";
const ACTION_POSTPONE = "POSTPONE";

const REASON_NOT_MARKED = "NOT_MARKED";
const REASON_WORKING = "WORKING";
const REASON_LEAVE = "LEAVE";
const REASON_PLANNED_OFF = "PLANNED_OFF";
const REASON_HOLIDAY = "HOLIDAY";
const REASON_WEEKLY_OFF = "WEEKLY_OFF";
const REASON_ABSENT = "ABSENT";
const REASON_OUTSIDE_SHIFT = "OUTSIDE_SHIFT";

const NON_WORKING_REASONS = {
  Leave: REASON_LEAVE,
  PlannedOff: REASON_PLANNED_OFF,
  Holiday: REASON_HOLIDAY,
  WeeklyOff: REASON_WEEKLY_OFF,
  Absent: REASON_ABSENT,
};

function normalizeStatus(status) {
  return String(status || "").trim();
}

function decideScheduledAttendance({
  record,
  taskStartMs,
  taskEndMs,
  dateKey,
} = {}) {
  if (!record) {
    return {
      action: ACTION_ASSIGN,
      reason: REASON_NOT_MARKED,
      attendanceStatus: "NOT_MARKED",
    };
  }
  const status = normalizeStatus(record.status);
  if (!status) {
    return {
      action: ACTION_ASSIGN,
      reason: REASON_NOT_MARKED,
      attendanceStatus: "NOT_MARKED",
    };
  }
  const nonWorking = NON_WORKING_REASONS[status];
  if (nonWorking) {
    return {
      action: ACTION_POSTPONE,
      reason: nonWorking,
      attendanceStatus: status,
    };
  }
  if (status !== "Working") {
    return {
      action: ACTION_POSTPONE,
      reason: REASON_OUTSIDE_SHIFT,
      attendanceStatus: status,
    };
  }
  const window = windowMsFromRecord(record, dateKey || record.date || record.SK);
  if (!window) {
    return {
      action: ACTION_POSTPONE,
      reason: REASON_OUTSIDE_SHIFT,
      attendanceStatus: status,
    };
  }
  if (taskFitsWindow(taskStartMs, taskEndMs, window.startMs, window.endMs)) {
    return {
      action: ACTION_ASSIGN,
      reason: REASON_WORKING,
      attendanceStatus: status,
    };
  }
  return {
    action: ACTION_POSTPONE,
    reason: REASON_OUTSIDE_SHIFT,
    attendanceStatus: status,
  };
}

async function loadAttendanceRecord(ddb, attendanceTable, email, dateKey) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!ddb || !attendanceTable || !normalized || !dateKey) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: attendanceTable,
      Key: { PK: normalized, SK: dateKey },
    })
  );
  return res.Item || null;
}

function alreadyAssignedState(task) {
  return String(task?.assignmentState || "").toUpperCase() === "ASSIGNED";
}

function taskEvaluationRange(task) {
  const startMs = parseInstantMs(task?.startDate);
  const dueMs = parseInstantMs(task?.dueDate);
  const durationMs =
    Number.isFinite(startMs) && Number.isFinite(dueMs) ? dueMs - startMs : 0;
  const scheduledMs = parseInstantMs(task?.scheduledAssignAt);
  // Assigned employees keep start/due; leftover pending are checked on the
  // current scheduledAssignAt clock using the same duration.
  if (alreadyAssignedState(task) && Number.isFinite(scheduledMs)) {
    return { startMs: scheduledMs, endMs: scheduledMs + durationMs };
  }
  return { startMs, endMs: dueMs };
}

function attendanceDateKeyForTask(task) {
  const ms = parseInstantMs(task?.scheduledAssignAt);
  if (!Number.isFinite(ms)) return null;
  return companyDateKey(new Date(ms));
}

function nextScheduleFields(task, { moveTaskDates } = {}) {
  const scheduledAssignAt = addDaysIso(task?.scheduledAssignAt, 1);
  if (!moveTaskDates) {
    return {
      scheduledAssignAt,
      startDate: task?.startDate,
      dueDate: task?.dueDate,
    };
  }
  return {
    scheduledAssignAt,
    startDate: addDaysIso(task?.startDate, 1),
    dueDate: addDaysIso(task?.dueDate, 1),
  };
}

async function attendanceDecisionForEmployee({
  ddb,
  attendanceTable,
  email,
  task,
} = {}) {
  const dateKey = attendanceDateKeyForTask(task);
  const range = taskEvaluationRange(task);
  const record = await loadAttendanceRecord(
    ddb,
    attendanceTable,
    email,
    dateKey
  );
  return {
    ...decideScheduledAttendance({
      record,
      taskStartMs: range.startMs,
      taskEndMs: range.endMs,
      dateKey,
    }),
    email,
    dateKey,
    record,
  };
}

module.exports = {
  ACTION_ASSIGN,
  ACTION_POSTPONE,
  REASON_NOT_MARKED,
  REASON_WORKING,
  REASON_LEAVE,
  REASON_PLANNED_OFF,
  REASON_HOLIDAY,
  REASON_WEEKLY_OFF,
  REASON_ABSENT,
  REASON_OUTSIDE_SHIFT,
  NON_WORKING_REASONS,
  decideScheduledAttendance,
  loadAttendanceRecord,
  alreadyAssignedState,
  taskEvaluationRange,
  attendanceDateKeyForTask,
  nextScheduleFields,
  attendanceDecisionForEmployee,
};

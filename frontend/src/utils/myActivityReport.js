import {
  addDaysToKey,
  attendanceCompliance,
  companyTodayKey,
  COMPLIANCE,
} from "./attendanceCompliance";
import { getWeeklyDisplayStatus } from "../components/WeeklyAttendanceHistory";
import { getTaskZone } from "./taskStatus";

export { addDaysToKey, companyTodayKey };

export const EMPTY_ATTENDANCE_METRICS = {
  present: 0,
  onTime: 0,
  late: 0,
  leave: 0,
  weekOff: 0,
  notMarked: 0,
};

export const EMPTY_TASK_METRICS = {
  assigned: 0,
  completed: 0,
  underReview: 0,
  redZone: 0,
};

function weekdayIndex(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday-start company week, same convention as Attendance. */
export function startOfWeekKey(key) {
  const day = weekdayIndex(key);
  const diff = day === 0 ? -6 : 1 - day;
  return addDaysToKey(key, diff);
}

export function currentWeekStartKey(now = new Date()) {
  return startOfWeekKey(companyTodayKey(now));
}

export function weekDateKeys(weekStart) {
  const monday = startOfWeekKey(weekStart);
  return Array.from({ length: 7 }, (_, i) => addDaysToKey(monday, i));
}

export function weekEndKey(weekStart) {
  return addDaysToKey(startOfWeekKey(weekStart), 6);
}

export function formatWeekRange(weekStart) {
  const mondayKey = startOfWeekKey(weekStart);
  const endKey = addDaysToKey(mondayKey, 6);
  const opts = {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  };
  const start = new Date(`${mondayKey}T12:00:00Z`);
  const end = new Date(`${endKey}T12:00:00Z`);
  return `${start.toLocaleDateString("en-GB", opts)} – ${end.toLocaleDateString(
    "en-GB",
    opts
  )}`;
}

export function indexAttendanceByDate(rows) {
  const list = Array.isArray(rows)
    ? rows
    : Array.isArray(rows?.attendance)
      ? rows.attendance
      : [];
  const byDate = {};
  for (const item of list) {
    const key = item?.date || item?.SK;
    if (key) byDate[key] = item;
  }
  return byDate;
}

function activityAttendanceStatus(record) {
  const display = getWeeklyDisplayStatus(record);
  if (display === "Present") return "present";
  if (display === "Leave") return "leave";
  if (display === "Planned Off" || display === "Weekly Off") return "weekOff";
  return "notMarked";
}

export function summarizeAttendanceWeek({
  weekStart,
  recordsByDate = {},
  todayKey,
} = {}) {
  const keys = weekDateKeys(weekStart);
  const metrics = { ...EMPTY_ATTENDANCE_METRICS };
  const today = todayKey || companyTodayKey();

  keys.forEach((dateKey) => {
    const record = recordsByDate[dateKey] || null;
    const status = activityAttendanceStatus(record);
    if (status === "present") {
      metrics.present += 1;
      const compliance = attendanceCompliance({
        dateKey,
        todayKey: today,
        record,
      });
      if (compliance.status === COMPLIANCE.ON_TIME) metrics.onTime += 1;
      if (compliance.status === COMPLIANCE.LATE) metrics.late += 1;
      return;
    }
    if (status === "leave") {
      metrics.leave += 1;
      return;
    }
    if (status === "weekOff") {
      metrics.weekOff += 1;
      return;
    }
    metrics.notMarked += 1;
  });

  return { ...metrics, daysEvaluated: keys.length };
}

export function companyDateKeyFromValue(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) {
    return new Date(ms).toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });
  }
  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return dateOnly ? dateOnly[1] : null;
}

function isCancelledStatus(status) {
  return String(status || "").toUpperCase() === "CANCELLED";
}

function employeeAssignment(task) {
  const mine = task?.myAssignment;
  if (!mine || mine.removed) return null;
  if (isCancelledStatus(mine.status)) return null;
  return mine;
}

function taskWorkWindow(task, assignment) {
  const start =
    companyDateKeyFromValue(task?.startDate) ||
    companyDateKeyFromValue(assignment?.startDate);
  const due =
    companyDateKeyFromValue(task?.dueDate) ||
    companyDateKeyFromValue(assignment?.dueDate);
  if (start || due) {
    let windowStart = start || due;
    let windowEnd = due || start;
    if (windowStart > windowEnd) {
      const swap = windowStart;
      windowStart = windowEnd;
      windowEnd = swap;
    }
    return { start: windowStart, end: windowEnd };
  }
  const assigned =
    companyDateKeyFromValue(assignment?.assignedAt) ||
    companyDateKeyFromValue(task?.assignedAt);
  if (!assigned) return null;
  return { start: assigned, end: assigned };
}

export function taskOverlapsWeek(task, assignment, weekStart, weekEnd) {
  const window = taskWorkWindow(task, assignment);
  if (!window) return false;
  return window.start <= weekEnd && window.end >= weekStart;
}

function assignmentCompletedInWeek(assignment, weekStart, weekEnd) {
  const key =
    companyDateKeyFromValue(assignment?.completedDate) ||
    companyDateKeyFromValue(assignment?.completedAt);
  if (!key) return false;
  return key >= weekStart && key <= weekEnd;
}

/**
 * Assigned = this employee's non-removed assignment whose start/due window
 * overlaps the Monday–Sunday week. Falls back to assignedAt when dates are missing.
 */
export function summarizeTaskWeek({ tasks = [], weekStart } = {}) {
  const monday = startOfWeekKey(weekStart);
  const sunday = addDaysToKey(monday, 6);
  const metrics = { ...EMPTY_TASK_METRICS };

  (Array.isArray(tasks) ? tasks : []).forEach((task) => {
    if (isCancelledStatus(task?.status)) return;
    const mine = employeeAssignment(task);
    if (!mine) return;

    const overlaps = taskOverlapsWeek(task, mine, monday, sunday);
    if (overlaps) {
      metrics.assigned += 1;
      if (String(mine.status || "").toUpperCase() === "REVIEW") {
        metrics.underReview += 1;
      }
      if (String(getTaskZone(task) || "").toUpperCase() === "RED") {
        metrics.redZone += 1;
      }
    }
    if (assignmentCompletedInWeek(mine, monday, sunday)) {
      metrics.completed += 1;
    }
  });

  return metrics;
}

import { getAssignmentZone, priorityLabel } from "./taskStatus";
import {
  addDaysToKey,
  companyDateKeyFromValue,
  companyTodayKey,
  startOfWeekKey,
  summarizeAttendanceWeek,
  taskOverlapsWeek,
  weekEndKey,
} from "./myActivityReport";

export const EMPTY_WORKLOAD_METRICS = {
  assigned: 0,
  high: 0,
  critical: 0,
  medium: 0,
  low: 0,
  highCritical: 0,
};

export const EMPTY_WORK_METRICS = {
  completed: 0,
  underReview: 0,
  redZone: 0,
  highPriorityRed: 0,
};

function isCancelledStatus(status) {
  return String(status || "").toUpperCase() === "CANCELLED";
}

export function eligibleEmployeeAssignment(task, assignment) {
  if (!assignment || assignment.removed) return null;
  if (isCancelledStatus(assignment.status)) return null;
  if (isCancelledStatus(task?.status)) return null;
  return assignment;
}

/**
 * HIGH stays High. CRITICAL stays Critical.
 * URGENT follows existing priorityLabel() → Critical (legacy).
 * URGENT is never counted as High.
 */
export function priorityBucket(priority) {
  const raw = String(priority || "").trim().toUpperCase();
  if (raw === "HIGH") return "high";
  if (raw === "LOW") return "low";
  if (raw === "MEDIUM") return "medium";
  if (raw === "CRITICAL" || raw === "URGENT") return "critical";
  const label = String(priorityLabel(priority) || "").toLowerCase();
  if (label === "critical") return "critical";
  if (label === "high") return "high";
  if (label === "medium") return "medium";
  if (label === "low") return "low";
  return null;
}

function assignmentCompletedInWeek(assignment, weekStart, weekEnd) {
  const key =
    companyDateKeyFromValue(assignment?.completedDate) ||
    companyDateKeyFromValue(assignment?.completedAt);
  if (!key) return false;
  return key >= weekStart && key <= weekEnd;
}

function assignmentEffectiveZone(task, assignment) {
  return String(
    getAssignmentZone(assignment, task?.dueDate) || ""
  ).toUpperCase();
}

export function summarizeEmployeeWorkloadWeek({
  tasks = [],
  weekStart,
  getAssignment,
} = {}) {
  const monday = startOfWeekKey(weekStart);
  const sunday = addDaysToKey(monday, 6);
  const metrics = { ...EMPTY_WORKLOAD_METRICS };

  (Array.isArray(tasks) ? tasks : []).forEach((task) => {
    const assignment = eligibleEmployeeAssignment(task, getAssignment?.(task));
    if (!assignment) return;
    if (!taskOverlapsWeek(task, assignment, monday, sunday)) return;
    metrics.assigned += 1;
    const bucket = priorityBucket(task.priority);
    if (bucket === "high") metrics.high += 1;
    else if (bucket === "critical") metrics.critical += 1;
    else if (bucket === "medium") metrics.medium += 1;
    else if (bucket === "low") metrics.low += 1;
  });

  metrics.highCritical = metrics.high + metrics.critical;
  return metrics;
}

export function summarizeEmployeeWorkWeek({
  tasks = [],
  weekStart,
  getAssignment,
} = {}) {
  const monday = startOfWeekKey(weekStart);
  const sunday = addDaysToKey(monday, 6);
  const metrics = { ...EMPTY_WORK_METRICS };

  (Array.isArray(tasks) ? tasks : []).forEach((task) => {
    const assignment = eligibleEmployeeAssignment(task, getAssignment?.(task));
    if (!assignment) return;
    const overlaps = taskOverlapsWeek(task, assignment, monday, sunday);
    if (overlaps) {
      if (String(assignment.status || "").toUpperCase() === "REVIEW") {
        metrics.underReview += 1;
      }
      if (assignmentEffectiveZone(task, assignment) === "RED") {
        metrics.redZone += 1;
        if (String(task.priority || "").toUpperCase() === "HIGH") {
          metrics.highPriorityRed += 1;
        }
      }
    }
    if (assignmentCompletedInWeek(assignment, monday, sunday)) {
      metrics.completed += 1;
    }
  });

  return metrics;
}

export function previousCompletedWeekStarts(
  selectedWeekStart,
  todayKey,
  count = 4
) {
  const today = todayKey || companyTodayKey();
  const starts = [];
  let cursor = addDaysToKey(startOfWeekKey(selectedWeekStart), -7);
  let guard = 0;
  while (starts.length < count && guard < 26) {
    const sunday = addDaysToKey(cursor, 6);
    if (sunday < today) starts.push(cursor);
    cursor = addDaysToKey(cursor, -7);
    guard += 1;
  }
  return starts;
}

export function trendRangeForSelectedWeek(selectedWeekStart, todayKey) {
  const selected = startOfWeekKey(selectedWeekStart);
  const previous = previousCompletedWeekStarts(selected, todayKey, 4);
  const oldest = previous[previous.length - 1] || selected;
  return {
    selected,
    previous,
    rangeStart: oldest,
    rangeEnd: weekEndKey(selected),
  };
}

export function averageOf(values) {
  const nums = (values || []).filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

export function trendPercentHint(current, average) {
  if (average == null || !Number.isFinite(average)) return null;
  if (!Number.isFinite(current)) return null;
  if (average === 0) return "vs 4-week average";
  const pct = Math.round(((current - average) / average) * 100);
  if (!Number.isFinite(pct) || pct === 0) return "vs 4-week average";
  const arrow = pct > 0 ? "↑" : "↓";
  return `${arrow} ${Math.abs(pct)}% vs 4-week average`;
}

export function buildEmployeeActivityTrend({
  selectedWeekStart,
  recordsByDate,
  tasks,
  getAssignment,
  todayKey,
} = {}) {
  const today = todayKey || companyTodayKey();
  const previous = previousCompletedWeekStarts(selectedWeekStart, today, 4);
  if (previous.length !== 4) {
    return { ready: false, previous, averages: null };
  }
  const attendanceWeeks = previous.map((weekStart) =>
    summarizeAttendanceWeek({ weekStart, recordsByDate, todayKey: today })
  );
  const workloadWeeks = previous.map((weekStart) =>
    summarizeEmployeeWorkloadWeek({ tasks, weekStart, getAssignment })
  );
  const workWeeks = previous.map((weekStart) =>
    summarizeEmployeeWorkWeek({ tasks, weekStart, getAssignment })
  );
  return {
    ready: true,
    previous,
    averages: {
      present: averageOf(attendanceWeeks.map((w) => w.present)),
      onTime: averageOf(attendanceWeeks.map((w) => w.onTime)),
      late: averageOf(attendanceWeeks.map((w) => w.late)),
      assigned: averageOf(workloadWeeks.map((w) => w.assigned)),
      high: averageOf(workloadWeeks.map((w) => w.high)),
      critical: averageOf(workloadWeeks.map((w) => w.critical)),
      highCritical: averageOf(workloadWeeks.map((w) => w.highCritical)),
      completed: averageOf(workWeeks.map((w) => w.completed)),
    },
  };
}

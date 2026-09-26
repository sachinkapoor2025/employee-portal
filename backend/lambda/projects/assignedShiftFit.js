const {
  WORK_PERIODS,
  expectedWindow,
  activeShiftDateKey,
  loadCurrentAssignedShift,
} = require("../attendance/assignedShift");
const { companyDateKey, parseInstantMs, taskFitsWindow } = require("../common/shiftWindows");
const { taskEvaluationRange } = require("./scheduledAttendance");

const ASSIGNED_SHIFT_FIT = {
  FIT: "FIT",
  SHIFT_CONFLICT: "SHIFT_CONFLICT",
  NO_SHIFT: "NO_SHIFT",
};

function parseMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return parseInstantMs(value);
}

function summarizeAssignment(assignment) {
  if (!assignment) return null;
  return {
    shiftId: assignment.shiftId || null,
    name: assignment.name || null,
    startTime: assignment.startTime || null,
    endTime: assignment.endTime || null,
    crossesMidnight: !!assignment.crossesMidnight,
  };
}

function fitResult(result, extras = {}) {
  return {
    result,
    assignment: extras.assignment || null,
    shiftDateKey: extras.shiftDateKey || null,
    window: extras.window || null,
  };
}

function noShiftResult() {
  return fitResult(ASSIGNED_SHIFT_FIT.NO_SHIFT);
}

function conflictResult(extras = {}) {
  return fitResult(ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT, extras);
}

/**
 * Complete-interval containment against the employee's CURRENT assigned shift.
 * Does not use graceMinutes or hardcoded SHIFT_TIMES.
 */
function evaluateAssignedShiftFit({
  assignment,
  taskStart,
  taskEnd,
  evaluatedAt,
} = {}) {
  if (!assignment) return noShiftResult();

  const taskStartMs = parseMs(taskStart);
  const taskEndMs = parseMs(taskEnd);
  const assignmentSummary = summarizeAssignment(assignment);
  if (!assignment.startTime || !assignment.endTime) {
    return conflictResult({ assignment: assignmentSummary });
  }

  const evaluatedAtMs = parseMs(evaluatedAt) ?? taskStartMs;
  if (!Number.isFinite(evaluatedAtMs) || !Number.isFinite(taskStartMs) || !Number.isFinite(taskEndMs)) {
    return conflictResult({ assignment: assignmentSummary });
  }

  const dateKey = companyDateKey(new Date(evaluatedAtMs));
  const shiftDateKey = activeShiftDateKey(assignment, dateKey, evaluatedAtMs);
  const window = expectedWindow(assignment, shiftDateKey, WORK_PERIODS.FULL_DAY);
  if (!window) {
    return conflictResult({ assignment: assignmentSummary, shiftDateKey });
  }

  const extras = { assignment: assignmentSummary, shiftDateKey, window };
  if (!taskFitsWindow(taskStartMs, taskEndMs, window.startMs, window.endMs)) {
    return conflictResult(extras);
  }
  return fitResult(ASSIGNED_SHIFT_FIT.FIT, extras);
}

async function assignedShiftFit(ddb, tableName, { email, taskStart, taskEnd, evaluatedAt } = {}) {
  const assignment = await loadCurrentAssignedShift(ddb, tableName, email);
  if (!assignment) return noShiftResult();
  return evaluateAssignedShiftFit({
    assignment,
    taskStart,
    taskEnd,
    evaluatedAt,
  });
}

function normalizeFitEmail(email) {
  return String(email || "")
    .replace(/^USER#/i, "")
    .trim()
    .toLowerCase();
}

function uniqueFitEmails(list) {
  const seen = new Set();
  const out = [];
  for (const value of list || []) {
    const email = normalizeFitEmail(value);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function sameInstant(left, right) {
  const leftMs = parseMs(left);
  const rightMs = parseMs(right);
  if (Number.isFinite(leftMs) || Number.isFinite(rightMs)) {
    return leftMs === rightMs;
  }
  return String(left || "") === String(right || "");
}

function sameEmailSet(left, right) {
  return uniqueFitEmails(left).join("\0") === uniqueFitEmails(right).join("\0");
}

function putChangesAssignedShiftFit({
  currentEmails,
  nextEmails,
  currentStart,
  nextStart,
  currentDue,
  nextDue,
  currentScheduledAssignAt,
  nextScheduledAssignAt,
} = {}) {
  if (!sameEmailSet(currentEmails, nextEmails)) return true;
  if (!sameInstant(currentStart, nextStart)) return true;
  if (!sameInstant(currentDue, nextDue)) return true;
  if (!sameInstant(currentScheduledAssignAt, nextScheduledAssignAt)) return true;
  return false;
}

function shiftFitConflictBody(conflicts = []) {
  const first = conflicts[0] || {};
  const email = first.email || "";
  if (first.result === ASSIGNED_SHIFT_FIT.NO_SHIFT) {
    return {
      error: email
        ? `${email} does not have an assigned shift.`
        : "Employee does not have an assigned shift.",
      code: ASSIGNED_SHIFT_FIT.NO_SHIFT,
      email: email || null,
      conflicts,
    };
  }
  return {
    error: email
      ? `Task time does not fit the assigned shift for ${email}.`
      : "Task time does not fit the assigned shift.",
    code: ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT,
    email: email || null,
    conflicts,
  };
}

async function validateAssigneesAssignedShiftFit(
  ddb,
  tableName,
  { emails, startDate, dueDate, scheduledAssignAt, assignmentState } = {}
) {
  const list = uniqueFitEmails(emails);
  if (!list.length) return { ok: true, conflicts: [] };
  const range = taskEvaluationRange({
    startDate,
    dueDate,
    scheduledAssignAt,
    assignmentState,
  });
  const conflicts = [];
  for (const email of list) {
    const fit = await assignedShiftFit(ddb, tableName, {
      email,
      taskStart: range.startMs,
      taskEnd: range.endMs,
      evaluatedAt: scheduledAssignAt || range.startMs,
    });
    if (fit.result !== ASSIGNED_SHIFT_FIT.FIT) {
      conflicts.push({
        email,
        result: fit.result,
        assignment: fit.assignment,
        shiftDateKey: fit.shiftDateKey,
      });
    }
  }
  return { ok: conflicts.length === 0, conflicts };
}

module.exports = {
  ASSIGNED_SHIFT_FIT,
  evaluateAssignedShiftFit,
  assignedShiftFit,
  putChangesAssignedShiftFit,
  shiftFitConflictBody,
  validateAssigneesAssignedShiftFit,
};

const escalation = require("./escalation");
const {
  ACTION_POSTPONE,
  REASON_LEAVE,
  REASON_WEEKLY_OFF,
  REASON_HOLIDAY,
  REASON_PLANNED_OFF,
  REASON_ABSENT,
  attendanceDecisionForEmployee,
  nextScheduleFields,
} = require("./scheduledAttendance");
const { validateAssigneesAssignedShiftFit } = require("./assignedShiftFit");
const { notifyScheduledPostponement } = require("./taskScheduledPostponeNotify");
const { notifyScheduledShiftConflicts } = require("./taskScheduledShiftConflictNotify");

const MAX_ASSIGNMENT_POSTPONEMENTS = 30;

const CALENDAR_POSTPONE_REASONS = new Set([
  REASON_LEAVE,
  REASON_WEEKLY_OFF,
  REASON_HOLIDAY,
  REASON_PLANNED_OFF,
  REASON_ABSENT,
]);

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

function uniqueReasons(list) {
  const seen = new Set();
  const out = [];
  for (const value of list || []) {
    const reason = String(value || "").trim();
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    out.push(reason);
  }
  return out;
}

function isCalendarPostpone(reason) {
  return CALENDAR_POSTPONE_REASONS.has(String(reason || "").trim());
}

function evaluationTask(task) {
  return {
    ...task,
    scheduledAssignAt: task.scheduledAssignAt || task.startDate,
  };
}

async function advanceCalendarPostponements({
  ddb,
  attendanceTable,
  emails,
  startDate,
  dueDate,
  scheduledAssignAt,
  moveTaskDates = true,
  maxPostponements = MAX_ASSIGNMENT_POSTPONEMENTS,
} = {}) {
  const list = uniqueEmails(emails);
  let current = {
    startDate,
    dueDate,
    scheduledAssignAt: scheduledAssignAt || startDate,
  };
  const steps = [];
  const attendanceStatusByEmail = {};
  const reasons = [];

  for (let i = 0; i < maxPostponements; i += 1) {
    if (!list.length) break;
    const evalTask = evaluationTask(current);
    const decisions = [];
    for (const email of list) {
      const decision = await attendanceDecisionForEmployee({
        ddb,
        attendanceTable,
        email,
        task: evalTask,
      });
      attendanceStatusByEmail[email] = decision.attendanceStatus;
      decisions.push(decision);
    }
    const calendar = decisions.filter(
      (row) =>
        row.action === ACTION_POSTPONE && isCalendarPostpone(row.reason)
    );
    if (!calendar.length || calendar.length < list.length) break;

    const next = nextScheduleFields(evalTask, { moveTaskDates });
    const stepReasons = uniqueReasons(calendar.map((row) => row.reason));
    const stepStatus = {};
    for (const row of calendar) {
      if (row.email) stepStatus[row.email] = row.attendanceStatus;
    }
    steps.push({
      previousStart: current.startDate,
      previousDue: current.dueDate,
      previousScheduledAssignAt: current.scheduledAssignAt,
      nextStart: next.startDate,
      nextDue: next.dueDate,
      nextScheduledAssignAt: next.scheduledAssignAt,
      reasons: stepReasons,
      attendanceStatusByEmail: stepStatus,
    });
    reasons.push(...stepReasons);
    current = {
      startDate: next.startDate,
      dueDate: next.dueDate,
      scheduledAssignAt: next.scheduledAssignAt,
    };
  }

  return {
    startDate: current.startDate,
    dueDate: current.dueDate,
    scheduledAssignAt: current.scheduledAssignAt,
    steps,
    postponementCount: steps.length,
    reasons: uniqueReasons(reasons),
    attendanceStatusByEmail,
  };
}

async function planAssignmentSchedule({
  ddb,
  tableName,
  attendanceTable,
  emails,
  startDate,
  dueDate,
  scheduledAssignAt,
  moveTaskDates = true,
} = {}) {
  const list = uniqueEmails(emails);
  const advanced = await advanceCalendarPostponements({
    ddb,
    attendanceTable,
    emails: list,
    startDate,
    dueDate,
    scheduledAssignAt,
    moveTaskDates,
  });
  const persistScheduledAssignAt = scheduledAssignAt
    ? advanced.scheduledAssignAt
    : undefined;
  const fitCheck = await validateAssigneesAssignedShiftFit(ddb, tableName, {
    emails: list,
    startDate: advanced.startDate,
    dueDate: advanced.dueDate,
    scheduledAssignAt: persistScheduledAssignAt,
  });
  const firstStep = advanced.steps[0];
  const lastStep = advanced.steps[advanced.steps.length - 1];
  return {
    ok: fitCheck.ok,
    startDate: advanced.startDate,
    dueDate: advanced.dueDate,
    scheduledAssignAt: persistScheduledAssignAt,
    postponements: advanced.steps,
    postponementCount: advanced.postponementCount,
    reasons: advanced.reasons,
    attendanceStatusByEmail: advanced.attendanceStatusByEmail,
    previousStart: firstStep ? firstStep.previousStart : startDate,
    previousDue: firstStep ? firstStep.previousDue : dueDate,
    previousScheduledAssignAt: firstStep
      ? firstStep.previousScheduledAssignAt
      : scheduledAssignAt,
    nextStart: lastStep ? lastStep.nextStart : advanced.startDate,
    nextDue: lastStep ? lastStep.nextDue : advanced.dueDate,
    conflicts: fitCheck.conflicts || [],
  };
}

function applyPlanToTask(task, plan, { includeScheduledAssignAt = false } = {}) {
  const next = {
    ...task,
    startDate: plan.startDate,
    dueDate: plan.dueDate,
  };
  if (includeScheduledAssignAt && plan.scheduledAssignAt) {
    next.scheduledAssignAt = plan.scheduledAssignAt;
  }
  if (plan.postponementCount) {
    if (!next.originalStartDate) {
      next.originalStartDate = plan.previousStart;
      next.originalDueDate = plan.previousDue;
      if (plan.previousScheduledAssignAt) {
        next.originalScheduledAssignAt = plan.previousScheduledAssignAt;
      }
    }
    next.postponementCount =
      Number(task.postponementCount || 0) + plan.postponementCount;
    next.lastPostponementReason = plan.reasons.join(",") || "UNAVAILABLE";
    next.lastPostponementAt = new Date().toISOString();
    next.lastAttendanceStatusByEmail = plan.attendanceStatusByEmail;
  }
  return next;
}

function fitMapFromConflicts(conflicts) {
  const map = {};
  for (const row of conflicts || []) {
    const email = escalation.normalizeEmail(row?.email);
    if (!email || !row.result) continue;
    map[email] = row.result;
  }
  return map;
}

async function notifyAssignmentPlanFailure({
  ddb,
  accessTable,
  tableName,
  task = {},
  plan,
  extraRecipients = [],
  listAccessRows,
} = {}) {
  if (!plan || plan.ok) return { skipped: true };
  return notifyScheduledShiftConflicts({
    ddb,
    accessTable,
    tableName,
    task: {
      ...task,
      startDate: plan.startDate || task.startDate,
      dueDate: plan.dueDate || task.dueDate,
    },
    conflictEmails: (plan.conflicts || []).map((row) => row.email),
    fitByEmail: fitMapFromConflicts(plan.conflicts),
    extraRecipients,
    listAccessRows,
  });
}

async function notifyAssignmentPlanPostponement({
  ddb,
  accessTable,
  task,
  emails,
  plan,
  extraRecipients = [],
  listAccessRows,
} = {}) {
  if (!plan?.postponementCount) return { skipped: true };
  return notifyScheduledPostponement({
    ddb,
    accessTable,
    task,
    postponedEmails: emails,
    previousStart: plan.previousStart,
    previousDue: plan.previousDue,
    previousScheduledAssignAt: plan.previousScheduledAssignAt,
    nextStart: plan.nextStart,
    nextDue: plan.nextDue,
    reasons: plan.reasons,
    attendanceStatusByEmail: plan.attendanceStatusByEmail,
    postponementCount: plan.postponementCount,
    includeEmployees: true,
    extraRecipients,
    listAccessRows,
  });
}

module.exports = {
  MAX_ASSIGNMENT_POSTPONEMENTS,
  CALENDAR_POSTPONE_REASONS,
  isCalendarPostpone,
  uniqueEmails,
  advanceCalendarPostponements,
  planAssignmentSchedule,
  applyPlanToTask,
  notifyAssignmentPlanFailure,
  notifyAssignmentPlanPostponement,
};

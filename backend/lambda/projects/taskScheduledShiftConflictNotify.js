const { dispatchNotification } = require("../common/notify");
const { listPortalAdminEmails } = require("./taskImportAssignNotify");
const { loadCurrentAssignedShift } = require("../attendance/assignedShift");
const { notifyFromAddress, notifyFromName } = require("./notifyFrom");
const { taskEvaluationRange } = require("./scheduledAttendance");
const { ASSIGNED_SHIFT_FIT } = require("./assignedShiftFit");
const escalation = require("./escalation");

const TYPE_SHIFT_CONFLICT = "TASK_SHIFT_CONFLICT";
const TYPE_SHIFT_CONFLICT_EMAIL = "TASK_SHIFT_CONFLICT_EMAIL";

function shiftConflictNotifyKey(taskId, email, result, startDate, dueDate) {
  return `${taskId}#${escalation.normalizeEmail(email)}#${result || ""}#${startDate || ""}#${dueDate || ""}#shift-conflict`;
}

function shiftConflictEmailKey(taskId, email, result, startDate, dueDate) {
  return `${shiftConflictNotifyKey(taskId, email, result, startDate, dueDate)}-email`;
}

function portalBaseUrl() {
  return String(process.env.PORTAL_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function adminTaskUrl(taskId) {
  const base = portalBaseUrl();
  const id = String(taskId || "").trim();
  if (!base || !id) return "";
  return `${base}/admin/tasks/${encodeURIComponent(id)}`;
}

function safeLine(raw, fallback = "") {
  return String(raw || fallback)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatCompanyInstant(iso) {
  const raw = String(iso || "").trim();
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.COMPANY_TIMEZONE || "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
  return `${formatted} IST`;
}

function uniqueList(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = safeLine(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function isoFromMs(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function formatShift(assignment) {
  if (!assignment || !assignment.startTime || !assignment.endTime) {
    return "none";
  }
  const name = safeLine(assignment.name);
  const window = `${assignment.startTime}–${assignment.endTime}`;
  return name ? `${name} (${window})` : window;
}

function conflictCopy({
  title,
  employee,
  result,
  shiftLabel,
  startIso,
  dueIso,
  taskId,
}) {
  const safeTitle = safeLine(title, "a task");
  const conflictType =
    result === ASSIGNED_SHIFT_FIT.NO_SHIFT
      ? ASSIGNED_SHIFT_FIT.NO_SHIFT
      : ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT;
  const subject = `Scheduled task shift conflict: ${safeTitle}`;
  const startLabel = formatCompanyInstant(startIso) || startIso || "—";
  const dueLabel = formatCompanyInstant(dueIso) || dueIso || "—";
  const lines = [
    `Task "${safeTitle}" was not assigned to ${safeLine(employee)}.`,
    `Conflict: ${conflictType}`,
    `Employee: ${safeLine(employee)}`,
    `Assigned shift: ${safeLine(shiftLabel, "none")}`,
    `Task time: ${startLabel} – ${dueLabel}`,
    "Action: Edit or reassign this task so the work fits the employee's assigned shift.",
  ];
  const portal = adminTaskUrl(taskId);
  if (portal) lines.push(`Portal: ${portal}`);
  const text = lines.join("\n");
  const html = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  return {
    title: subject,
    subject,
    text,
    html,
    inAppTitle: `Shift conflict: ${safeTitle}`,
    inAppMessage: `${safeLine(employee)} was not assigned "${safeTitle}" (${conflictType}).`,
  };
}

async function sendChannel(ddb, payload) {
  try {
    return await dispatchNotification(ddb, payload);
  } catch (err) {
    console.error(
      "TASK_SCHEDULED_SHIFT_CONFLICT_NOTIFY_ERROR",
      JSON.stringify({
        type: payload?.type || null,
        email: payload?.email || null,
      })
    );
    console.error(err);
    return { skipped: true, status: "FAILED", error: err?.name || "NOTIFY_ERROR" };
  }
}

async function notifyScheduledShiftConflicts({
  ddb,
  accessTable,
  tableName = process.env.WORK_TABLE,
  task = {},
  conflictEmails = [],
  fitByEmail = {},
  listAccessRows,
} = {}) {
  const taskId = task.taskId;
  const emails = uniqueList(
    (conflictEmails || []).map((email) => escalation.normalizeEmail(email))
  ).filter((email) => {
    const result = fitByEmail[email];
    return (
      result === ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT ||
      result === ASSIGNED_SHIFT_FIT.NO_SHIFT
    );
  });
  if (!ddb || !taskId || !emails.length) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }

  let recipients = [];
  try {
    recipients = uniqueList(
      await listPortalAdminEmails({
        ddb,
        accessTable,
        listAccessRows,
      })
    );
  } catch (err) {
    console.error(
      "TASK_SCHEDULED_SHIFT_CONFLICT_RECIPIENT_ERROR",
      JSON.stringify({ taskId })
    );
    console.error(err);
    return { skipped: true, reason: "RECIPIENT_LOOKUP_FAILED" };
  }
  if (!recipients.length) {
    return { skipped: true, reason: "NO_ADMINS" };
  }

  const range = taskEvaluationRange(task);
  const startIso = isoFromMs(range.startMs) || task.startDate || "";
  const dueIso = isoFromMs(range.endMs) || task.dueDate || "";
  const from = notifyFromAddress();
  const fromName = notifyFromName();
  const results = [];

  for (const employee of emails) {
    const result =
      fitByEmail[employee] === ASSIGNED_SHIFT_FIT.NO_SHIFT
        ? ASSIGNED_SHIFT_FIT.NO_SHIFT
        : ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT;
    const assignment = await loadCurrentAssignedShift(ddb, tableName, employee);
    const copy = conflictCopy({
      title: task.title,
      employee,
      result,
      shiftLabel: formatShift(assignment),
      startIso,
      dueIso,
      taskId,
    });
    const inAppKey = shiftConflictNotifyKey(
      taskId,
      employee,
      result,
      task.startDate,
      task.dueDate
    );
    const emailKey = shiftConflictEmailKey(
      taskId,
      employee,
      result,
      task.startDate,
      task.dueDate
    );
    for (const adminEmail of recipients) {
      if (adminEmail === employee) continue;
      results.push(
        await sendChannel(ddb, {
          email: adminEmail,
          type: TYPE_SHIFT_CONFLICT,
          title: copy.inAppTitle,
          subject: copy.subject,
          message: copy.inAppMessage,
          html: copy.html,
          reason: TYPE_SHIFT_CONFLICT,
          dedupKey: `${inAppKey}#${adminEmail}`,
          extra: {
            taskId,
            employee,
            conflict: result,
          },
          channel: "inapp",
          emailEnabled: false,
          inAppEnabled: true,
          inAppSk: `NOTIFY#${TYPE_SHIFT_CONFLICT}#${inAppKey}#${adminEmail}`,
        })
      );
      results.push(
        await sendChannel(ddb, {
          email: adminEmail,
          type: TYPE_SHIFT_CONFLICT_EMAIL,
          title: copy.title,
          subject: copy.subject,
          message: copy.text,
          html: copy.html,
          reason: TYPE_SHIFT_CONFLICT_EMAIL,
          extra: {
            taskId,
            employee,
            conflict: result,
          },
          dedupKey: `${emailKey}#${adminEmail}`,
          channel: "email",
          emailEnabled: true,
          inAppEnabled: false,
          from,
          fromName,
        })
      );
    }
  }

  return { skipped: false, results, recipients, employees: emails };
}

module.exports = {
  TYPE_SHIFT_CONFLICT,
  TYPE_SHIFT_CONFLICT_EMAIL,
  shiftConflictNotifyKey,
  shiftConflictEmailKey,
  conflictCopy,
  notifyScheduledShiftConflicts,
};

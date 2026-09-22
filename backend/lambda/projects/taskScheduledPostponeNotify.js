const { dispatchNotification } = require("../common/notify");
const { listSuperAdminEmails } = require("./taskImportAssignNotify");
const { notifyFromAddress, notifyFromName } = require("./notifyFrom");
const { companyDateKey } = require("../common/shiftWindows");
const escalation = require("./escalation");

const TYPE_SCHEDULED_POSTPONED_EMAIL = "TASK_SCHEDULED_POSTPONED_EMAIL";

function postponedNotifyKey(taskId, previousScheduledAssignAt) {
  return `${taskId}#${previousScheduledAssignAt || ""}#postponed`;
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

function postponementCopy({
  title,
  employees,
  previousStart,
  previousDue,
  nextStart,
  nextDue,
  reason,
  attendanceStatus,
  postponementCount,
  dateKey,
}) {
  const safeTitle = safeLine(title, "a task");
  const people = uniqueList(employees);
  const peopleLine = people.length ? people.join(", ") : "unassigned employees";
  const reasons = uniqueList(Array.isArray(reason) ? reason : [reason]);
  const statuses = uniqueList(
    Array.isArray(attendanceStatus) ? attendanceStatus : [attendanceStatus]
  );
  const subject = `Scheduled task postponed: ${safeTitle}`;
  const lines = [
    `Task "${safeTitle}" was postponed by 24 hours.`,
    `Employee(s): ${peopleLine}`,
    `Previous scheduled start: ${formatCompanyInstant(previousStart) || previousStart || "—"}`,
    `Previous deadline: ${formatCompanyInstant(previousDue) || previousDue || "—"}`,
    `New scheduled start: ${formatCompanyInstant(nextStart) || nextStart || "—"}`,
    `New deadline: ${formatCompanyInstant(nextDue) || nextDue || "—"}`,
    `Reason: ${reasons.join(", ") || "UNAVAILABLE"}`,
    `Attendance status: ${statuses.join(", ") || "—"}`,
    `Postponement count: ${Number(postponementCount || 0) || 1}`,
  ];
  if (dateKey) lines.push(`Attendance date: ${dateKey}`);
  const text = lines.join("\n");
  const html = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  return { title: subject, subject, text, html };
}

async function sendChannel(ddb, payload) {
  try {
    return await dispatchNotification(ddb, payload);
  } catch (err) {
    console.error(
      "TASK_SCHEDULED_POSTPONE_NOTIFY_ERROR",
      JSON.stringify({
        type: payload?.type || null,
        email: payload?.email || null,
      })
    );
    console.error(err);
    return { skipped: true, status: "FAILED", error: err?.name || "NOTIFY_ERROR" };
  }
}

async function notifyScheduledPostponement({
  ddb,
  accessTable,
  task = {},
  postponedEmails = [],
  previousStart,
  previousDue,
  previousScheduledAssignAt,
  nextStart,
  nextDue,
  reasons = [],
  attendanceStatusByEmail = {},
  postponementCount,
  listAccessRows,
} = {}) {
  const taskId = task.taskId;
  const emails = uniqueList(
    (postponedEmails || []).map((email) => escalation.normalizeEmail(email))
  );
  if (!ddb || !taskId || !emails.length) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }

  let superAdmins = [];
  try {
    superAdmins = await listSuperAdminEmails({
      ddb,
      accessTable,
      listAccessRows,
    });
  } catch (err) {
    console.error(
      "TASK_SCHEDULED_POSTPONE_RECIPIENT_ERROR",
      JSON.stringify({ taskId })
    );
    console.error(err);
    return { skipped: true, reason: "RECIPIENT_LOOKUP_FAILED" };
  }

  const recipients = uniqueList(superAdmins);
  if (!recipients.length) {
    return { skipped: true, reason: "NO_SUPER_ADMINS" };
  }

  const statuses = uniqueList(
    emails.map((email) => attendanceStatusByEmail[email]).filter(Boolean)
  );
  const copy = postponementCopy({
    title: task.title,
    employees: emails,
    previousStart: previousStart || task.startDate,
    previousDue: previousDue || task.dueDate,
    nextStart,
    nextDue,
    reason: reasons,
    attendanceStatus: statuses,
    postponementCount,
    dateKey: companyDateKey(previousScheduledAssignAt || task.scheduledAssignAt),
  });
  const from = notifyFromAddress();
  const fromName = notifyFromName();
  const dedupKey = postponedNotifyKey(taskId, previousScheduledAssignAt);
  const results = [];
  for (const adminEmail of recipients) {
    results.push(
      await sendChannel(ddb, {
        email: adminEmail,
        type: TYPE_SCHEDULED_POSTPONED_EMAIL,
        title: copy.title,
        subject: copy.subject,
        message: copy.text,
        html: copy.html,
        reason: TYPE_SCHEDULED_POSTPONED_EMAIL,
        dedupKey,
        extra: {
          taskId,
          postponedEmails: emails,
          postponementCount,
        },
        channel: "email",
        emailEnabled: true,
        inAppEnabled: false,
        from,
        fromName,
      })
    );
  }
  return { skipped: false, results, recipients };
}

module.exports = {
  TYPE_SCHEDULED_POSTPONED_EMAIL,
  postponedNotifyKey,
  postponementCopy,
  notifyScheduledPostponement,
};

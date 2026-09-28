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

function postponementReasonLabel(reason) {
  const code = String(reason || "").trim().toUpperCase();
  if (code === "WEEKLY_OFF") return "Week Off";
  if (code === "LEAVE") return "Approved Leave";
  if (code === "HOLIDAY") return "Holiday";
  if (code === "PLANNED_OFF") return "Planned Off";
  if (code === "ABSENT") return "Absent";
  return safeLine(reason, "UNAVAILABLE");
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
  taskId,
}) {
  const safeTitle = safeLine(title, "a task");
  const people = uniqueList(employees);
  const peopleLine = people.length ? people.join(", ") : "unassigned employees";
  const reasons = uniqueList(
    (Array.isArray(reason) ? reason : [reason]).map(postponementReasonLabel)
  );
  const statuses = uniqueList(
    Array.isArray(attendanceStatus) ? attendanceStatus : [attendanceStatus]
  );
  const subject = `Task Schedule Postponed: ${safeTitle}`;
  const lines = [
    `Task "${safeTitle}" was postponed by 24 hours.`,
    `Employee(s): ${peopleLine}`,
    `Task: ${safeTitle}`,
    `Reason: ${reasons.join(", ") || "UNAVAILABLE"}`,
    `Previous schedule: ${formatCompanyInstant(previousStart) || previousStart || "—"} → ${formatCompanyInstant(previousDue) || previousDue || "—"}`,
    `Updated schedule: ${formatCompanyInstant(nextStart) || nextStart || "—"} → ${formatCompanyInstant(nextDue) || nextDue || "—"}`,
    `Postponed by: 24 hours`,
    `Attendance status: ${statuses.join(", ") || "—"}`,
    `Postponement count: ${Number(postponementCount || 0) || 1}`,
  ];
  if (dateKey) lines.push(`Attendance date: ${dateKey}`);
  const portal = adminTaskUrl(taskId);
  if (portal) lines.push(`Task link: ${portal}`);
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
  includeEmployees = false,
  extraRecipients = [],
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

  const recipients = uniqueList([
    ...superAdmins,
    ...(includeEmployees ? emails : []),
    ...(extraRecipients || []),
  ]);
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
    taskId,
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
        dedupKey: `${dedupKey}#${adminEmail}`,
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
  postponementReasonLabel,
  notifyScheduledPostponement,
};

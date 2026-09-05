const TZ = () => process.env.COMPANY_TIMEZONE || "Asia/Kolkata";

function formatWhen(value, timeZone = TZ()) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function redZoneStartedMs(deadline, redZoneStartedAt) {
  const fromRed = Date.parse(redZoneStartedAt);
  if (Number.isFinite(fromRed)) return fromRed;
  const deadlineMs = Date.parse(deadline);
  if (Number.isFinite(deadlineMs)) return deadlineMs + 24 * 60 * 60 * 1000;
  return NaN;
}

function optionalText(value) {
  const text = String(value || "").trim();
  return text || "";
}

function textField(label, value) {
  const text = optionalText(value);
  if (!text) return "";
  return `${label}:\n${text}\n\n`;
}

function htmlRow(label, value) {
  const text = optionalText(value);
  if (!text) return "";
  return `<tr>
      <td style="padding:8px 0;color:#6b7280;vertical-align:top;width:160px">${escapeHtml(label)}</td>
      <td style="padding:8px 0;color:#111827;font-weight:600;white-space:pre-wrap">${escapeHtml(text)}</td>
    </tr>`;
}

function redAdminNotifyCopy({
  employeeName,
  employeeEmail,
  title,
  projectName,
  status,
  deadline,
  redZoneStartedAt,
  overdueLabel,
  priority,
  description,
  viewTaskUrl,
  timeZone = TZ(),
}) {
  const taskName = String(title || "Untitled task").trim() || "Untitled task";
  const person = String(employeeName || "").trim() || "Unknown employee";
  const deadlineLabel = formatWhen(deadline, timeZone);
  const redStartedMs = redZoneStartedMs(deadline, redZoneStartedAt);
  const redStartedLabel = Number.isFinite(redStartedMs)
    ? formatWhen(new Date(redStartedMs).toISOString(), timeZone)
    : "";
  const subject = `🔴 Task Entered Red Zone – Action Required: ${taskName}`;
  const intro =
    "A task assignment has remained incomplete for 24 hours after its original deadline and has now entered the Red Zone.";
  const action =
    "This assignment has not been completed within the required deadline. Please review the task and take the necessary action.";
  const link = optionalText(viewTaskUrl);

  const message =
    `🔴 TASK ENTERED RED ZONE\n\n` +
    `${intro}\n\n` +
    `TASK DETAILS\n\n` +
    `Task:\n${taskName}\n\n` +
    textField("Project", projectName) +
    `Assigned To:\n${person}\n\n` +
    textField("Employee Email", employeeEmail) +
    textField("Current Status", status) +
    `Original Deadline:\n${deadlineLabel}\n\n` +
    (redStartedLabel ? `Red Zone Started:\n${redStartedLabel}\n\n` : "") +
    textField("Overdue", overdueLabel) +
    textField("Priority", priority) +
    textField("Description", description) +
    `ACTION REQUIRED\n\n${action}` +
    (link ? `\n\nView Task:\n${link}` : "");

  const html =
    `<div style="font-family:Arial,sans-serif;color:#111827;max-width:640px">` +
    `<div style="background:#991b1b;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">` +
    `<h1 style="margin:0;font-size:20px">🔴 TASK ENTERED RED ZONE</h1>` +
    `</div>` +
    `<div style="border:1px solid #fecaca;border-top:none;padding:20px;border-radius:0 0 8px 8px">` +
    `<p style="margin:0 0 16px;color:#4b5563;line-height:1.5">${escapeHtml(intro)}</p>` +
    `<h2 style="margin:0 0 12px;font-size:14px;letter-spacing:0.04em;color:#991b1b">TASK DETAILS</h2>` +
    `<table style="width:100%;border-collapse:collapse;font-size:14px">` +
    htmlRow("Task", taskName) +
    htmlRow("Project", projectName) +
    htmlRow("Assigned To", person) +
    htmlRow("Employee Email", employeeEmail) +
    htmlRow("Current Status", status) +
    htmlRow("Original Deadline", deadlineLabel) +
    htmlRow("Red Zone Started", redStartedLabel) +
    htmlRow("Overdue", overdueLabel) +
    htmlRow("Priority", priority) +
    htmlRow("Description", description) +
    `</table>` +
    `<h2 style="margin:20px 0 8px;font-size:14px;letter-spacing:0.04em;color:#991b1b">ACTION REQUIRED</h2>` +
    `<p style="margin:0 0 16px;color:#4b5563;line-height:1.5">${escapeHtml(action)}</p>` +
    (link
      ? `<p style="margin:0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#991b1b;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:700">VIEW TASK</a></p>`
      : "") +
    `</div></div>`;

  return {
    type: "TASK_RED_ADMIN",
    title: subject,
    subject,
    message,
    html,
  };
}

function zoneNotifyCopy({
  orange,
  title,
  deadline,
  zoneStartedAt,
  timeZone = TZ(),
}) {
  const name = String(title || "Untitled task").trim() || "Untitled task";
  const deadlineLabel = formatWhen(deadline, timeZone);
  const startedLabel = formatWhen(zoneStartedAt || deadline, timeZone);
  if (orange) {
    return {
      type: "TASK_ORANGE",
      category: "TASK_MOVED_TO_ORANGE",
      zone: "ORANGE",
      title: "⚠️ Task moved to Orange Zone",
      message:
        `Your task "${name}" has passed its deadline and has moved to the Orange Zone.\n\n` +
        `Deadline: ${deadlineLabel}\n` +
        `Orange Zone started: ${startedLabel}`,
    };
  }
  return {
    type: "TASK_RED",
    category: "TASK_MOVED_TO_RED",
    zone: "RED",
    title: "🚨 Task moved to Red Zone",
    message:
      `Your task "${name}" has not been completed within the 24-hour Orange Zone period and has now moved to the Red Zone.\n\n` +
      `Deadline: ${deadlineLabel}\n` +
      `Red Zone started: ${startedLabel}`,
  };
}

module.exports = { formatWhen, zoneNotifyCopy, redAdminNotifyCopy };

const escalation = require("./escalation");
const { buildProfessionalEmail } = require("../common/emailLayout");

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

function orangePeriodLabel() {
  if (escalation.ORANGE_MS === escalation.DAY_MS) return "24-hour";
  return escalation.formatDuration(escalation.ORANGE_MS);
}

function redZoneStartedMs(deadline, redZoneStartedAt) {
  const fromRed = Date.parse(redZoneStartedAt);
  if (Number.isFinite(fromRed)) return fromRed;
  const deadlineMs = Date.parse(deadline);
  if (Number.isFinite(deadlineMs)) return deadlineMs + escalation.ORANGE_MS;
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
    `A task assignment has remained incomplete for ${orangePeriodLabel()} after its original deadline and has now entered the Red Zone.`;
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

  const html = buildProfessionalEmail({
    variant: "urgent",
    title: "🔴 TASK ENTERED RED ZONE",
    intro,
    sections: [
      {
        heading: "TASK DETAILS",
        rows: [
          { label: "Task", value: taskName },
          { label: "Project", value: projectName },
          { label: "Assigned To", value: person },
          { label: "Employee Email", value: employeeEmail },
          { label: "Current Status", value: status },
          { label: "Original Deadline", value: deadlineLabel },
          { label: "Red Zone Started", value: redStartedLabel },
          { label: "Overdue", value: overdueLabel },
          { label: "Priority", value: priority },
          { label: "Description", value: description },
        ],
      },
      {
        heading: "ACTION REQUIRED",
        body: action,
      },
    ],
    cta: link ? { href: link, label: "VIEW TASK" } : undefined,
  });

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
      `Your task "${name}" has not been completed within the ${orangePeriodLabel()} Orange Zone period and has now moved to the Red Zone.\n\n` +
      `Deadline: ${deadlineLabel}\n` +
      `Red Zone started: ${startedLabel}`,
  };
}

module.exports = { formatWhen, zoneNotifyCopy, redAdminNotifyCopy };

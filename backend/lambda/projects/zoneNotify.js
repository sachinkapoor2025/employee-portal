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

module.exports = { formatWhen, zoneNotifyCopy };

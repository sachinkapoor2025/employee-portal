const DEFAULT_TZ = "Asia/Kolkata";
const LOOKBACK_DAYS = 21;

const EXCUSED_STATUSES = new Set([
  "leave",
  "plannedoff",
  "planned_off",
  "weeklyoff",
  "weekly_off",
  "holiday",
]);

const PRESENT_SESSIONS = new Set(["active", "checked out", "present"]);

function dateKeyInTimeZone(date, timeZone = DEFAULT_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDaysToKey(dateKey, delta) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + delta));
  const yyyy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function weekdayFromKey(dateKey) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isWeekend(dateKey) {
  const day = weekdayFromKey(dateKey);
  return day === 0 || day === 6;
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "");
}

function isExcusedStatus(status) {
  return EXCUSED_STATUSES.has(normalizeStatus(status));
}

function isPresent(record) {
  if (!record) return false;
  if (record.checkInTime) return true;
  if (PRESENT_SESSIONS.has(String(record.sessionStatus || "").trim().toLowerCase())) {
    return true;
  }
  return normalizeStatus(record.status) === "working";
}

function overlayStatusForDate(dateKey, leaves) {
  for (const leave of leaves || []) {
    const from = leave.fromDate || leave.startDate;
    const to = leave.toDate || leave.endDate || from;
    if (!from || !to) continue;
    const planned =
      leave.status === "PLANNED_OFF" ||
      leave.category === "PLANNED_OFF" ||
      String(leave.type || "").toUpperCase() === "PLANNED_OFF";
    const approved = String(leave.status || "").toUpperCase() === "APPROVED";
    if (!planned && !approved) continue;
    if (dateKey >= from && dateKey <= to) {
      return planned ? "PlannedOff" : "Leave";
    }
  }
  return null;
}

function isRequiredWorkingDay(dateKey, record, leaves) {
  const overlay = overlayStatusForDate(dateKey, leaves);
  if (overlay) return false;
  if (record && isExcusedStatus(record.status)) return false;
  if (isWeekend(dateKey) && !isPresent(record)) return false;
  return true;
}

function isMissedRequiredDay(dateKey, record, leaves) {
  if (!isRequiredWorkingDay(dateKey, record, leaves)) return false;
  return !isPresent(record);
}

/**
 * Trailing streak of missed required working days ending at yesterday (IST).
 * Returns the streak (oldest first) when it has at least `minMisses` days.
 */
function findMissedWorkingStreak({
  todayKey,
  recordsByDate = {},
  leaves = [],
  minMisses = 2,
  lookbackDays = LOOKBACK_DAYS,
  notBeforeKey = "",
}) {
  const yesterday = addDaysToKey(todayKey, -1);
  const start = addDaysToKey(yesterday, -(lookbackDays - 1));
  const required = [];
  for (let key = start; key <= yesterday; key = addDaysToKey(key, 1)) {
    if (notBeforeKey && key < notBeforeKey) continue;
    const record = recordsByDate[key] || null;
    if (isRequiredWorkingDay(key, record, leaves)) {
      required.push({ date: key, record, missed: isMissedRequiredDay(key, record, leaves) });
    }
  }

  const streak = [];
  for (let i = required.length - 1; i >= 0; i -= 1) {
    if (!required[i].missed) break;
    streak.unshift(required[i].date);
  }

  if (streak.length < minMisses) {
    return { shouldNotify: false, streak, missedDays: [] };
  }

  return {
    shouldNotify: true,
    streak,
    missedDays: streak.slice(-minMisses),
    eventKey: streak[0],
  };
}

function attendanceEmail({ employeeName, missedDays, portalUrl }) {
  const days = missedDays.join(" and ");
  const name = employeeName || "Employee";
  const subject = "Attendance reminder: 2 required working days not marked";
  const message = [
    `Dear ${name},`,
    "",
    `Our records show that you have not marked attendance for 2 consecutive required working days (${days}).`,
    "",
    "Please log in to the DGV Portal and mark your attendance for the missed working days as soon as possible.",
    "If you were on approved leave or planned off, you can ignore this message once that leave is recorded.",
    "",
    portalUrl ? `Portal: ${portalUrl}` : "",
    "",
    "Regards,",
    "DGV Portal",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return { subject, message };
}

function documentEmail({ employeeName, documents, portalUrl }) {
  const name = employeeName || "Employee";
  const list = documents.map((d) => `- ${d.label}${d.note ? ` (${d.note})` : ""}`).join("\n");
  const subject = "Action required: please upload your documents";
  const message = [
    `Dear ${name},`,
    "",
    "The following required document(s) still need your action in the DGV Portal:",
    "",
    list,
    "",
    "Please open the Documents page, upload the file(s), and complete any pending resubmission.",
    portalUrl ? `Portal: ${portalUrl}` : "",
    "",
    "Regards,",
    "DGV Portal",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return { subject, message };
}

function trainingEmail({ employeeName, titles, portalUrl }) {
  const name = employeeName || "Employee";
  const list = titles.map((t) => `- ${t}`).join("\n");
  const subject = "Training reminder: assigned training is still pending";
  const message = [
    `Dear ${name},`,
    "",
    "You have assigned training that is still incomplete:",
    "",
    list,
    "",
    "Please log in to the DGV Portal Training page and complete the pending material.",
    portalUrl ? `Portal: ${portalUrl}` : "",
    "",
    "Regards,",
    "DGV Portal",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return { subject, message };
}

module.exports = {
  DEFAULT_TZ,
  LOOKBACK_DAYS,
  dateKeyInTimeZone,
  addDaysToKey,
  weekdayFromKey,
  isWeekend,
  isPresent,
  isExcusedStatus,
  isRequiredWorkingDay,
  isMissedRequiredDay,
  overlayStatusForDate,
  findMissedWorkingStreak,
  attendanceEmail,
  documentEmail,
  trainingEmail,
};

const COMPANY_TZ = process.env.COMPANY_TIMEZONE || "Asia/Kolkata";
const COMPANY_OFFSET = process.env.COMPANY_TZ_OFFSET || "+05:30";
const DAY_MS = 24 * 60 * 60 * 1000;

const SHIFT_TIMES = {
  "Full Day": {
    "Morning Shift": { in: "11:00", out: "20:00" },
    "Afternoon Shift": { in: "14:00", out: "23:00" },
    "Evening Shift": { in: "17:00", out: "23:00" },
  },
  "Half Day": {
    "Morning Shift": { in: "11:00", out: "15:30" },
    "Afternoon Shift": { in: "14:00", out: "18:30" },
    "Evening Shift": { in: "17:00", out: "20:30" },
  },
};

function companyDateTimeIso(dateKey, hhmm) {
  if (!dateKey || !hhmm) return null;
  const d = new Date(`${dateKey}T${hhmm}:00${COMPANY_OFFSET}`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function resolveShiftTimes(dayType, shift, dateKey) {
  const mapping = SHIFT_TIMES[dayType]?.[shift];
  if (!mapping) return null;
  const checkInTime = companyDateTimeIso(dateKey, mapping.in);
  const checkOutTime = companyDateTimeIso(dateKey, mapping.out);
  if (!checkInTime || !checkOutTime) return null;
  return { checkInTime, checkOutTime };
}

function companyDateKey(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: COMPANY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const companyTodayKey = companyDateKey;

function parseInstantMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function addDaysIso(iso, days = 1) {
  const ms = parseInstantMs(iso);
  if (!Number.isFinite(ms)) return iso || null;
  return new Date(ms + days * DAY_MS).toISOString();
}

function isSameCompanyDay(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  const startKey = companyDateKey(new Date(startMs));
  const endKey = companyDateKey(new Date(endMs));
  return Boolean(startKey) && startKey === endKey;
}

function taskFitsWindow(taskStartMs, taskEndMs, windowStartMs, windowEndMs) {
  if (
    !Number.isFinite(taskStartMs) ||
    !Number.isFinite(taskEndMs) ||
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(windowEndMs)
  ) {
    return false;
  }
  return taskStartMs >= windowStartMs && taskEndMs <= windowEndMs;
}

function windowMsFromRecord(record, dateKey) {
  const key = dateKey || record?.date || record?.SK;
  const fromShift = resolveShiftTimes(record?.dayType, record?.shift, key);
  if (fromShift) {
    return {
      startMs: parseInstantMs(fromShift.checkInTime),
      endMs: parseInstantMs(fromShift.checkOutTime),
    };
  }
  const startMs = parseInstantMs(record?.checkInTime);
  const endMs = parseInstantMs(record?.checkOutTime);
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    return { startMs, endMs };
  }
  return null;
}

module.exports = {
  COMPANY_TZ,
  COMPANY_OFFSET,
  DAY_MS,
  SHIFT_TIMES,
  companyDateTimeIso,
  resolveShiftTimes,
  companyDateKey,
  companyTodayKey,
  parseInstantMs,
  addDaysIso,
  isSameCompanyDay,
  taskFitsWindow,
  windowMsFromRecord,
};

const COMPANY_TZ = "Asia/Kolkata";
const COMPANY_OFFSET = "+05:30";

export const COMPLIANCE = {
  ON_TIME: "ON TIME",
  LATE: "LATE",
  NOT_MARKED: "NOT MARKED",
  LEAVE: "LEAVE",
  WEEK_OFF: "WEEK OFF",
  HOLIDAY: "HOLIDAY",
  UPCOMING: "UPCOMING",
};

export function companyTodayKey(now = new Date()) {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: COMPANY_TZ });
}

export function addDaysToKey(key, days) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function padHm(hhmm) {
  const match = String(hhmm || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  return `${String(match[1]).padStart(2, "0")}:${match[2]}`;
}

export function companyDateTimeMs(dateKey, hhmm) {
  const clock = padHm(hhmm);
  if (!dateKey || !clock) return null;
  const ms = Date.parse(`${dateKey}T${clock}:00${COMPANY_OFFSET}`);
  return Number.isFinite(ms) ? ms : null;
}

export function formatClockHm(hhmm) {
  const ms = companyDateTimeMs("1970-01-01", hhmm);
  if (ms == null) return String(hhmm || "").trim() || "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: COMPANY_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
}

export function formatInstant(isoOrMs) {
  if (isoOrMs == null || isoOrMs === "") return "";
  const ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: COMPANY_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
}

export function shiftCrossesMidnight(shift) {
  if (!shift) return false;
  if (shift.crossesMidnight === true) return true;
  const start = padHm(shift.startTime);
  const end = padHm(shift.endTime);
  if (!start || !end) return false;
  return end <= start;
}

function graceMinutesOf(record, shift) {
  const fromRecord = Number(record?.graceMinutes);
  if (Number.isFinite(fromRecord) && fromRecord >= 0 && record?.graceMinutes != null) {
    return fromRecord;
  }
  const fromShift = Number(shift?.graceMinutes);
  if (Number.isFinite(fromShift) && fromShift >= 0) return fromShift;
  return 0;
}

export function shiftLabel(shift, record, options = {}) {
  const useAssignedName = options.useAssignedShiftName !== false;
  const name = String(
    record?.shiftName ||
      record?.shift ||
      (useAssignedName ? shift?.name : "") ||
      ""
  ).trim();
  const start = record?.expectedStartTime
    ? formatInstant(record.expectedStartTime)
    : formatClockHm(shift?.startTime);
  const end = record?.expectedEndTime
    ? formatInstant(record.expectedEndTime)
    : formatClockHm(shift?.endTime);
  if (name && start && end) return `${name} · ${start} – ${end}`;
  if (name) return name;
  if (start && end) return `${start} – ${end}`;
  return "";
}

export function markedAtMs(record) {
  const iso = record?.attendanceSubmittedAt || record?.submittedAt;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function expectedWindowFromRecordOrShift({
  dateKey,
  record,
  shift,
  nowMs,
} = {}) {
  const grace = graceMinutesOf(record, shift);
  const startFromRecord = Date.parse(record?.expectedStartTime);
  if (Number.isFinite(startFromRecord)) {
    return {
      startMs: startFromRecord,
      expectedByMs: startFromRecord + grace * 60 * 1000,
      graceMinutes: grace,
    };
  }
  if (!shift?.startTime || !dateKey) return null;
  let key = dateKey;
  if (shiftCrossesMidnight(shift) && Number.isFinite(nowMs)) {
    const previousKey = addDaysToKey(dateKey, -1);
    const prevStart = companyDateTimeMs(previousKey, shift.startTime);
    const prevEnd = companyDateTimeMs(dateKey, shift.endTime);
    if (
      prevStart != null &&
      prevEnd != null &&
      nowMs >= prevStart &&
      nowMs < prevEnd
    ) {
      key = previousKey;
    }
  }
  const startMs = companyDateTimeMs(key, shift.startTime);
  if (startMs == null) return null;
  return {
    startMs,
    expectedByMs: startMs + grace * 60 * 1000,
    graceMinutes: grace,
  };
}

function overlayStatus(record, leaveLabel) {
  const leave = String(leaveLabel || "").trim();
  if (leave === "Planned Off" || leave === "WEEK OFF") return COMPLIANCE.WEEK_OFF;
  if (leave === "On Leave" || leave === "LEAVE" || leave === "Leave") {
    return COMPLIANCE.LEAVE;
  }
  const status = String(record?.status || "").trim();
  if (status === "PlannedOff" || status === "PLANNED_OFF" || status === "WeeklyOff") {
    return COMPLIANCE.WEEK_OFF;
  }
  if (status === "Leave") return COMPLIANCE.LEAVE;
  if (status === "Holiday") return COMPLIANCE.HOLIDAY;
  return null;
}

function isWorkingRecord(record) {
  if (!record) return false;
  const status = String(record.status || "").trim();
  if (status === "Working") return true;
  const session = String(record.sessionStatus || "").trim();
  return session === "Present" || session === "Active" || session === "Checked Out";
}

function lateMinutesFromTiming(record, grace) {
  const stored = Number(record?.lateMinutes);
  if (!Number.isFinite(stored) || stored < 0) return null;
  const delay = stored - Math.max(0, Number(grace) || 0);
  return Math.max(0, delay);
}

/**
 * Derived attendance-marking rule compliance. Not persisted.
 * lateMinutes is delay past (shift start + grace), not work duration.
 */
export function attendanceCompliance({
  dateKey,
  todayKey,
  record = null,
  leaveLabel = null,
  shift = null,
  nowMs = Date.now(),
  useAssignedShiftName = true,
} = {}) {
  const today = todayKey || companyTodayKey(new Date(nowMs));
  const overlay = overlayStatus(record, leaveLabel);
  const window = expectedWindowFromRecordOrShift({
    dateKey,
    record,
    shift,
    nowMs,
  });
  const expectedByMs = window?.expectedByMs ?? null;
  const markedMs = markedAtMs(record);
  const label = shiftLabel(shift, record, { useAssignedShiftName });

  const base = {
    status: COMPLIANCE.NOT_MARKED,
    markedAtMs: markedMs,
    expectedByMs,
    lateMinutes: null,
    shiftLabel: label,
    graceMinutes: window?.graceMinutes ?? graceMinutesOf(record, shift),
  };

  if (overlay) {
    return { ...base, status: overlay, lateMinutes: null };
  }

  if (dateKey && today && dateKey > today) {
    return { ...base, status: COMPLIANCE.UPCOMING, lateMinutes: null };
  }

  if (isWorkingRecord(record)) {
    if (markedMs != null && expectedByMs != null) {
      if (markedMs <= expectedByMs) {
        return { ...base, status: COMPLIANCE.ON_TIME, lateMinutes: null };
      }
      return {
        ...base,
        status: COMPLIANCE.LATE,
        lateMinutes: Math.max(0, Math.floor((markedMs - expectedByMs) / 60000)),
      };
    }
    const timing = String(record?.timingStatus || "").trim();
    if (timing === "BEFORE_SHIFT" || timing === "WITHIN_GRACE") {
      return { ...base, status: COMPLIANCE.ON_TIME, lateMinutes: null };
    }
    if (timing === "LATE") {
      return {
        ...base,
        status: COMPLIANCE.LATE,
        lateMinutes: lateMinutesFromTiming(record, window?.graceMinutes),
      };
    }
    return { ...base, status: COMPLIANCE.ON_TIME, lateMinutes: null };
  }

  if (record?.status) {
    return base;
  }

  return { ...base, status: COMPLIANCE.NOT_MARKED };
}

export function lateByLabel(lateMinutes) {
  if (lateMinutes == null || lateMinutes < 0) return "";
  return `${lateMinutes} min`;
}

const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const {
  SHIFT_TIMES,
  companyDateTimeIso,
} = require("../common/shiftWindows");

const CURRENT_SHIFT_SK = "SHIFT#CURRENT";
const TIME_SOURCE_EXPECTED_WINDOW = "EXPECTED_WINDOW";
const HM_RE = /^\d{2}:\d{2}$/;
const GRACE_MAX = 24 * 60;

const WORK_PERIODS = {
  FULL_DAY: "FULL_DAY",
  FIRST_HALF: "FIRST_HALF",
  SECOND_HALF: "SECOND_HALF",
};

const TIMING_STATUS = {
  BEFORE_SHIFT: "BEFORE_SHIFT",
  WITHIN_GRACE: "WITHIN_GRACE",
  LATE: "LATE",
};

const WORK_PERIOD_ALIASES = {
  FULL_DAY: WORK_PERIODS.FULL_DAY,
  "Full Day": WORK_PERIODS.FULL_DAY,
  FIRST_HALF: WORK_PERIODS.FIRST_HALF,
  "First Half": WORK_PERIODS.FIRST_HALF,
  SECOND_HALF: WORK_PERIODS.SECOND_HALF,
  "Second Half": WORK_PERIODS.SECOND_HALF,
  // Current UI still sends Half Day; treat as first half until Phase 2 UI.
  "Half Day": WORK_PERIODS.FIRST_HALF,
};

function normalizeEmail(email) {
  return String(email || "")
    .replace(/^USER#/i, "")
    .trim()
    .toLowerCase();
}

function addDaysToKey(key, days) {
  const [y, m, d] = String(key)
    .split("-")
    .map((part) => Number(part));
  if (!y || !m || !d) return key;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function resolveWorkPeriod(entry) {
  const raw = String(entry?.workPeriod || entry?.dayType || "").trim();
  return WORK_PERIOD_ALIASES[raw] || null;
}

function normalizeHm(value) {
  const text = String(value || "").trim();
  if (/^\d{2}:\d{2}:\d{2}$/.test(text)) return text.slice(0, 5);
  return text;
}

function isValidHm(value) {
  if (!HM_RE.test(value)) return false;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return hour <= 23 && minute <= 59;
}

function assignmentHalfDayEnabled(assignment) {
  return assignment?.halfDayEnabled === true;
}

function readHalfPeriod(half) {
  if (!half || typeof half !== "object" || Array.isArray(half)) return null;
  const startTime = normalizeHm(half.startTime);
  const endTime = normalizeHm(half.endTime);
  if (!isValidHm(startTime) || !isValidHm(endTime) || startTime === endTime) {
    return null;
  }
  const raw = half.graceMinutes;
  const grace = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(grace) || grace < 0 || grace > GRACE_MAX) return null;
  return {
    startTime,
    endTime,
    graceMinutes: Math.round(grace),
  };
}

function workPeriodEligibility(assignment, workPeriod) {
  if (workPeriod === WORK_PERIODS.FULL_DAY) return { ok: true };
  if (workPeriod === WORK_PERIODS.FIRST_HALF) {
    if (!assignmentHalfDayEnabled(assignment)) {
      return {
        ok: false,
        error: "The assigned shift does not allow First Half attendance.",
      };
    }
    if (!readHalfPeriod(assignment?.firstHalf)) {
      return {
        ok: false,
        error: "The assigned shift does not have a valid first half configuration.",
      };
    }
    return { ok: true };
  }
  if (workPeriod === WORK_PERIODS.SECOND_HALF) {
    if (!assignmentHalfDayEnabled(assignment)) {
      return {
        ok: false,
        error: "The assigned shift does not allow Second Half attendance.",
      };
    }
    if (!readHalfPeriod(assignment?.secondHalf)) {
      return {
        ok: false,
        error: "The assigned shift does not have a valid second half configuration.",
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    error: "Please select Full Day, First Half, or Second Half.",
  };
}

function assignmentCrossesMidnight(assignment) {
  if (assignment?.crossesMidnight != null) return !!assignment.crossesMidnight;
  const startTime = String(assignment?.startTime || "");
  const endTime = String(assignment?.endTime || "");
  if (!startTime || !endTime) return false;
  return endTime <= startTime;
}

function clockWindow(dateKey, startTime, endTime) {
  const start = normalizeHm(startTime);
  const end = normalizeHm(endTime);
  if (!dateKey || !isValidHm(start) || !isValidHm(end) || start === end) return null;
  const crosses = end <= start;
  const startIso = companyDateTimeIso(dateKey, start);
  const endIso = companyDateTimeIso(
    crosses ? addDaysToKey(dateKey, 1) : dateKey,
    end
  );
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  return { startIso, endIso, startMs, endMs, crossesMidnight: crosses };
}

function fullShiftWindow(assignment, dateKey) {
  const startTime = String(assignment?.startTime || "").trim();
  const endTime = String(assignment?.endTime || "").trim();
  if (!dateKey || !startTime || !endTime) return null;
  const crosses = assignmentCrossesMidnight(assignment);
  const startIso = companyDateTimeIso(dateKey, startTime);
  const endIso = companyDateTimeIso(
    crosses ? addDaysToKey(dateKey, 1) : dateKey,
    endTime
  );
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  return { startIso, endIso, startMs, endMs, crossesMidnight: crosses };
}

function periodWindowForDate(assignment, period, dateKey) {
  const full = fullShiftWindow(assignment, dateKey);
  if (!full || !period) return null;
  const fullCrosses = assignmentCrossesMidnight(assignment);
  const halfCrosses = period.endTime <= period.startTime;
  if (halfCrosses && !fullCrosses) return null;
  const keys = halfCrosses
    ? [dateKey]
    : fullCrosses
      ? [dateKey, addDaysToKey(dateKey, 1)]
      : [dateKey];
  for (const key of keys) {
    const win = clockWindow(key, period.startTime, period.endTime);
    if (
      win &&
      win.startMs >= full.startMs &&
      win.endMs <= full.endMs
    ) {
      return win;
    }
  }
  return null;
}

function expectedWindow(assignment, dateKey, workPeriod) {
  if (workPeriod === WORK_PERIODS.FULL_DAY) {
    return fullShiftWindow(assignment, dateKey);
  }
  if (workPeriod === WORK_PERIODS.FIRST_HALF) {
    if (!assignmentHalfDayEnabled(assignment)) return null;
    const half = readHalfPeriod(assignment.firstHalf);
    return half ? periodWindowForDate(assignment, half, dateKey) : null;
  }
  if (workPeriod === WORK_PERIODS.SECOND_HALF) {
    if (!assignmentHalfDayEnabled(assignment)) return null;
    const half = readHalfPeriod(assignment.secondHalf);
    return half ? periodWindowForDate(assignment, half, dateKey) : null;
  }
  return null;
}

function graceMinutesForWorkPeriod(assignment, workPeriod) {
  if (workPeriod === WORK_PERIODS.FIRST_HALF) {
    const half = readHalfPeriod(assignment?.firstHalf);
    return half ? half.graceMinutes : 0;
  }
  if (workPeriod === WORK_PERIODS.SECOND_HALF) {
    const half = readHalfPeriod(assignment?.secondHalf);
    return half ? half.graceMinutes : 0;
  }
  return Math.max(0, Number(assignment?.graceMinutes) || 0);
}

/**
 * After midnight, company today is the morning date. An overnight shift
 * 22:00–06:00 that started the previous evening is still the active window.
 */
function activeShiftDateKey(assignment, dateKey, submittedMs) {
  if (!dateKey || !assignmentCrossesMidnight(assignment)) return dateKey;
  const submitted = Number(submittedMs);
  if (!Number.isFinite(submitted)) return dateKey;
  const previousKey = addDaysToKey(dateKey, -1);
  const previousWindow = fullShiftWindow(assignment, previousKey);
  if (
    previousWindow &&
    submitted >= previousWindow.startMs &&
    submitted < previousWindow.endMs
  ) {
    return previousKey;
  }
  return dateKey;
}

function classifyTiming({ submittedMs, shiftStartMs, graceMinutes }) {
  const submitted = Number(submittedMs);
  const start = Number(shiftStartMs);
  if (!Number.isFinite(submitted) || !Number.isFinite(start)) {
    return { timingStatus: null, lateMinutes: null };
  }
  const graceMs = Math.max(0, Number(graceMinutes) || 0) * 60 * 1000;
  const lateMinutes = Math.floor((submitted - start) / 60000);
  if (submitted < start) {
    return { timingStatus: TIMING_STATUS.BEFORE_SHIFT, lateMinutes: 0 };
  }
  if (submitted <= start + graceMs) {
    return {
      timingStatus: TIMING_STATUS.WITHIN_GRACE,
      lateMinutes: Math.max(0, lateMinutes),
    };
  }
  return {
    timingStatus: TIMING_STATUS.LATE,
    lateMinutes: Math.max(0, lateMinutes),
  };
}

function compatibilityDayType(workPeriod) {
  return workPeriod === WORK_PERIODS.FULL_DAY ? "Full Day" : "Half Day";
}

function compatibilityShiftName(assignment) {
  const name = String(assignment?.name || "").trim();
  if (!name) return null;
  if (SHIFT_TIMES["Full Day"]?.[name] || SHIFT_TIMES["Half Day"]?.[name]) {
    return name;
  }
  return name;
}

/**
 * Working-day snapshot. checkInTime/checkOutTime are the expected window so
 * scheduledAttendance.windowMsFromRecord can still fall back to stored times
 * when dayType+shift are not SHIFT_TIMES keys. They are not actual punches
 * and checkOutTime is not a checkout.
 */
function buildWorkingAttendanceShift(assignment, { dateKey, workPeriod, submittedMs }) {
  const shiftDateKey = activeShiftDateKey(assignment, dateKey, submittedMs);
  const window = expectedWindow(assignment, shiftDateKey, workPeriod);
  if (!window) return null;
  const graceMinutes = graceMinutesForWorkPeriod(assignment, workPeriod);
  const timing = classifyTiming({
    submittedMs,
    shiftStartMs: window.startMs,
    graceMinutes,
  });
  const shiftName = compatibilityShiftName(assignment);
  return {
    shiftId: assignment?.shiftId || null,
    shiftName: String(assignment?.name || "").trim() || null,
    expectedStartTime: window.startIso,
    expectedEndTime: window.endIso,
    graceMinutes,
    crossesMidnight: assignmentCrossesMidnight(assignment),
    workPeriod,
    timeSource: TIME_SOURCE_EXPECTED_WINDOW,
    attendanceSubmittedAt: new Date(submittedMs).toISOString(),
    timingStatus: timing.timingStatus,
    lateMinutes: timing.lateMinutes,
    dayType: compatibilityDayType(workPeriod),
    shift: shiftName,
    checkInTime: window.startIso,
    checkOutTime: window.endIso,
  };
}

async function loadCurrentAssignedShift(ddb, tableName, email) {
  const normalized = normalizeEmail(email);
  if (!ddb || !tableName || !normalized) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: `USER#${normalized}`, SK: CURRENT_SHIFT_SK },
    })
  );
  return res.Item || null;
}

module.exports = {
  CURRENT_SHIFT_SK,
  TIME_SOURCE_EXPECTED_WINDOW,
  WORK_PERIODS,
  TIMING_STATUS,
  resolveWorkPeriod,
  assignmentHalfDayEnabled,
  workPeriodEligibility,
  assignmentCrossesMidnight,
  expectedWindow,
  activeShiftDateKey,
  classifyTiming,
  compatibilityDayType,
  buildWorkingAttendanceShift,
  loadCurrentAssignedShift,
};

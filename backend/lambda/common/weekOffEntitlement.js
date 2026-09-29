const {
  GetCommand,
  QueryCommand,
  DeleteCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { addDaysToKey, companyDateKey } = require("./shiftWindows");

const WEEK_OFF_ENTITLEMENT = 1;
const WEEK_OFF_EXHAUSTED_MESSAGE =
  "Week Off exhausted for this week. Please apply for Leave instead.";
const WEEK_OFF_ONE_DATE_MESSAGE = "Week Off must be exactly one calendar date.";
const CLAIM_SK_PREFIX = "WEEKOFF#";

function normalizeEmail(email) {
  return String(email || "")
    .replace(/^USER#/i, "")
    .trim()
    .toLowerCase();
}

function isValidDateKey(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(key || ""));
}

function weekdayIndex(key) {
  const [y, m, d] = String(key || "")
    .split("-")
    .map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function getCompanyWeekRange(dateKey) {
  const key = String(dateKey || "").trim();
  if (!isValidDateKey(key)) return { weekStart: null, weekEnd: null };
  const day = weekdayIndex(key);
  if (day == null) return { weekStart: null, weekEnd: null };
  const diff = day === 0 ? -6 : 1 - day;
  const weekStart = addDaysToKey(key, diff);
  const weekEnd = addDaysToKey(weekStart, 6);
  return { weekStart, weekEnd };
}

function eachDateKey(fromDate, toDate) {
  const start = String(fromDate || "").trim();
  const end = String(toDate || fromDate || "").trim();
  if (!isValidDateKey(start) || !isValidDateKey(end) || start > end) return [];
  const keys = [];
  let current = start;
  while (current <= end) {
    keys.push(current);
    const next = addDaysToKey(current, 1);
    if (!next || next <= current) break;
    current = next;
  }
  return keys;
}

function leaveDateRange(item) {
  const from = String(item?.fromDate || item?.startDate || "").trim();
  const to = String(item?.toDate || item?.endDate || from).trim();
  return { from, to };
}

function leaveCoversDate(item, dateKey) {
  const { from, to } = leaveDateRange(item);
  if (!isValidDateKey(from) || !isValidDateKey(to) || !isValidDateKey(dateKey)) {
    return false;
  }
  return dateKey >= from && dateKey <= to;
}

function leaveOverlapsRange(item, fromKey, toKey) {
  const { from, to } = leaveDateRange(item);
  if (!isValidDateKey(from) || !isValidDateKey(to)) return false;
  if (!isValidDateKey(fromKey) || !isValidDateKey(toKey)) return false;
  return from <= toKey && to >= fromKey;
}

function isCancelledStatus(status) {
  return String(status || "").toUpperCase() === "CANCELLED";
}

function isPlannedOffLeave(item) {
  if (!item || isCancelledStatus(item.status)) return false;
  const status = String(item.status || "").toUpperCase();
  const category = String(item.category || "").toUpperCase();
  const type = String(item.type || "").toUpperCase();
  return status === "PLANNED_OFF" || category === "PLANNED_OFF" || type === "PLANNED_OFF";
}

function isConfirmedApprovedLeave(item) {
  if (!item || isCancelledStatus(item.status) || isPlannedOffLeave(item)) return false;
  return String(item.status || "").toUpperCase() === "APPROVED";
}

function isAttendanceWeekOff(item) {
  const status = String(item?.status || "").trim();
  return status === "WeeklyOff" || status === "PlannedOff";
}

function weekOffClaimSk(weekStart) {
  return `${CLAIM_SK_PREFIX}${weekStart}`;
}

function validateSingleWeekOffDate(fromDate, toDate) {
  const from = String(fromDate || "").trim();
  const to = String(toDate || from).trim();
  if (!isValidDateKey(from) || !isValidDateKey(to)) {
    return WEEK_OFF_ONE_DATE_MESSAGE;
  }
  if (from !== to) return WEEK_OFF_ONE_DATE_MESSAGE;
  return null;
}

function emptyWeekOffState(weekStart, weekEnd) {
  return {
    weekStart: weekStart || null,
    weekEnd: weekEnd || null,
    weekOffEntitlement: WEEK_OFF_ENTITLEMENT,
    weekOffUsed: 0,
    weekOffAvailable: WEEK_OFF_ENTITLEMENT,
    leaveUsed: 0,
    balance: WEEK_OFF_ENTITLEMENT,
    usedDate: null,
    usedSource: null,
  };
}

function buildWeekOffState({ weekStart, weekEnd, weekOffUsed, leaveUsed, usedDate, usedSource }) {
  const used = weekOffUsed ? 1 : 0;
  const leaveDays = Number(leaveUsed) || 0;
  return {
    weekStart,
    weekEnd,
    weekOffEntitlement: WEEK_OFF_ENTITLEMENT,
    weekOffUsed: used,
    weekOffAvailable: used ? 0 : 1,
    leaveUsed: leaveDays,
    balance: WEEK_OFF_ENTITLEMENT - used - leaveDays,
    usedDate: used ? usedDate || null : null,
    usedSource: used ? usedSource || null : null,
  };
}

function usedWeekOffFromRecords({ leaves = [], attendance = [], claim = null, weekStart, weekEnd }) {
  if (claim && Number(claim.weekOffUsed) !== 0) {
    return {
      used: true,
      usedDate: claim.date || null,
      usedSource: claim.source || null,
    };
  }

  for (const item of Array.isArray(leaves) ? leaves : []) {
    if (!isPlannedOffLeave(item)) continue;
    if (!leaveOverlapsRange(item, weekStart, weekEnd)) continue;
    const { from } = leaveDateRange(item);
    const date =
      from >= weekStart && from <= weekEnd
        ? from
        : eachDateKey(weekStart, weekEnd).find((key) => leaveCoversDate(item, key)) || from;
    return { used: true, usedDate: date, usedSource: "PLANNED_OFF" };
  }

  for (const item of Array.isArray(attendance) ? attendance : []) {
    const date = String(item?.date || item?.SK || "").trim();
    if (!isValidDateKey(date) || date < weekStart || date > weekEnd) continue;
    if (String(item.SK || "").startsWith(CLAIM_SK_PREFIX)) continue;
    if (!isAttendanceWeekOff(item)) continue;
    const source =
      String(item.status || "").trim() === "WeeklyOff" ? "WeeklyOff" : "PLANNED_OFF";
    return { used: true, usedDate: date, usedSource: source };
  }

  return { used: false, usedDate: null, usedSource: null };
}

function confirmedLeaveDaysInWeek(leaves, weekStart, weekEnd) {
  const dates = new Set();
  for (const item of Array.isArray(leaves) ? leaves : []) {
    if (!isConfirmedApprovedLeave(item)) continue;
    for (const date of eachDateKey(weekStart, weekEnd)) {
      if (leaveCoversDate(item, date)) dates.add(date);
    }
  }
  return dates.size;
}

function overlappingWeekOffDate(leaves, attendance, fromDate, toDate) {
  for (const date of eachDateKey(fromDate, toDate)) {
    for (const item of Array.isArray(leaves) ? leaves : []) {
      if (isPlannedOffLeave(item) && leaveCoversDate(item, date)) return date;
    }
    for (const item of Array.isArray(attendance) ? attendance : []) {
      const key = String(item?.date || item?.SK || "").trim();
      if (key === date && isAttendanceWeekOff(item)) return date;
    }
  }
  return null;
}

function overlappingApprovedLeaveDate(leaves, dateKey) {
  for (const item of Array.isArray(leaves) ? leaves : []) {
    if (isConfirmedApprovedLeave(item) && leaveCoversDate(item, dateKey)) return dateKey;
  }
  return null;
}

async function queryUserLeaves(ddb, email) {
  if (!ddb || !process.env.WORK_TABLE || !email) return [];
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": `USER#${email}`,
        ":sk": "LEAVE#",
      },
    })
  );
  return res.Items || [];
}

async function queryAttendanceRange(ddb, email, fromDate, toDate) {
  if (!ddb || !process.env.ATTENDANCE_TABLE || !email) return [];
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.ATTENDANCE_TABLE,
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":pk": email,
        ":start": fromDate,
        ":end": toDate,
      },
    })
  );
  return res.Items || [];
}

async function getWeekOffClaim(ddb, email, weekStart) {
  if (!ddb || !process.env.ATTENDANCE_TABLE || !email || !weekStart) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.ATTENDANCE_TABLE,
      Key: { PK: email, SK: weekOffClaimSk(weekStart) },
    })
  );
  return res.Item || null;
}

async function loadWeekOffInputs(ddb, email, weekStart, weekEnd) {
  const [leaves, attendance, claim] = await Promise.all([
    queryUserLeaves(ddb, email),
    queryAttendanceRange(ddb, email, weekStart, weekEnd),
    getWeekOffClaim(ddb, email, weekStart),
  ]);
  return { leaves, attendance, claim };
}

async function hasWeekOffUsedInCompanyWeek(ddb, email, weekStart, weekEnd) {
  const normalized = normalizeEmail(email);
  if (!normalized || !weekStart || !weekEnd) {
    return { used: false, usedDate: null, usedSource: null };
  }
  const inputs = await loadWeekOffInputs(ddb, normalized, weekStart, weekEnd);
  return usedWeekOffFromRecords({ ...inputs, weekStart, weekEnd });
}

async function getWeekOffWeekState(ddb, email, dateOrWeekStart, now = new Date()) {
  const normalized = normalizeEmail(email);
  const raw = String(dateOrWeekStart || "").trim();
  const fallback = companyDateKey(now);
  const { weekStart, weekEnd } = getCompanyWeekRange(raw || fallback);
  if (!normalized || !weekStart || !weekEnd) {
    return emptyWeekOffState(weekStart, weekEnd);
  }
  const inputs = await loadWeekOffInputs(ddb, normalized, weekStart, weekEnd);
  const used = usedWeekOffFromRecords({ ...inputs, weekStart, weekEnd });
  const leaveUsed = confirmedLeaveDaysInWeek(inputs.leaves, weekStart, weekEnd);
  return buildWeekOffState({
    weekStart,
    weekEnd,
    weekOffUsed: used.used,
    leaveUsed,
    usedDate: used.usedDate,
    usedSource: used.usedSource,
  });
}

async function leaveConflictsWithWeekOff(ddb, email, fromDate, toDate) {
  const normalized = normalizeEmail(email);
  const dates = eachDateKey(fromDate, toDate);
  if (!normalized || dates.length === 0) return null;
  const from = dates[0];
  const to = dates[dates.length - 1];
  const [leaves, attendance] = await Promise.all([
    queryUserLeaves(ddb, normalized),
    queryAttendanceRange(ddb, normalized, from, to),
  ]);
  const conflictDate = overlappingWeekOffDate(leaves, attendance, from, to);
  if (!conflictDate) return null;
  return `Leave cannot overlap an existing Week Off on ${conflictDate}.`;
}

async function weekOffConflictsWithLeave(ddb, email, dateKey) {
  const normalized = normalizeEmail(email);
  if (!normalized || !isValidDateKey(dateKey)) return null;
  const leaves = await queryUserLeaves(ddb, normalized);
  const conflictDate = overlappingApprovedLeaveDate(leaves, dateKey);
  if (!conflictDate) return null;
  return `Week Off cannot overlap existing leave on ${conflictDate}.`;
}

function isTransactionConflict(err) {
  if (!err) return false;
  const name = String(err.name || err.code || err.Code || "");
  if (name === "TransactionCanceledException" || name === "ConditionalCheckFailedException") {
    return true;
  }
  const reasons = err.CancellationReasons || err.cancellationReasons;
  return (
    Array.isArray(reasons) &&
    reasons.some((reason) => String(reason?.Code || "") === "ConditionalCheckFailed")
  );
}

function claimItem({ email, dateKey, source, leaveId, nowIso }) {
  const { weekStart, weekEnd } = getCompanyWeekRange(dateKey);
  return {
    PK: email,
    SK: weekOffClaimSk(weekStart),
    email,
    weekStart,
    weekEnd,
    date: dateKey,
    source,
    leaveId: leaveId || null,
    weekOffUsed: 1,
    createdAt: nowIso,
  };
}

async function consumeWeekOffEntitlement(ddb, { email, dateKey, source, leaveId, extraPuts, nowIso }) {
  const normalized = normalizeEmail(email);
  const date = String(dateKey || "").trim();
  if (!normalized || !isValidDateKey(date)) {
    throw new Error(WEEK_OFF_ONE_DATE_MESSAGE);
  }
  const { weekStart, weekEnd } = getCompanyWeekRange(date);
  const used = await hasWeekOffUsedInCompanyWeek(ddb, normalized, weekStart, weekEnd);
  if (used.used) {
    const error = new Error(WEEK_OFF_EXHAUSTED_MESSAGE);
    error.statusCode = 409;
    error.code = "WEEK_OFF_EXHAUSTED";
    throw error;
  }

  const transactItems = [
    {
      Put: {
        TableName: process.env.ATTENDANCE_TABLE,
        Item: claimItem({
          email: normalized,
          dateKey: date,
          source,
          leaveId,
          nowIso: nowIso || new Date().toISOString(),
        }),
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    ...(Array.isArray(extraPuts) ? extraPuts : []),
  ];

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (isTransactionConflict(err)) {
      const reasons = err.CancellationReasons || err.cancellationReasons || [];
      const claimFailed = String(reasons[0]?.Code || "") === "ConditionalCheckFailed";
      if (claimFailed || reasons.length === 0) {
        const error = new Error(WEEK_OFF_EXHAUSTED_MESSAGE);
        error.statusCode = 409;
        error.code = "WEEK_OFF_EXHAUSTED";
        throw error;
      }
      const extraFailed = reasons
        .slice(1)
        .some((reason) => String(reason?.Code || "") === "ConditionalCheckFailed");
      if (extraFailed) {
        const error = new Error("ConditionalCheckFailedException");
        error.name = "ConditionalCheckFailedException";
        error.code = "ConditionalCheckFailedException";
        throw error;
      }
    }
    throw err;
  }
}

async function releaseWeekOffClaim(ddb, email, dateKey, leaveId) {
  const normalized = normalizeEmail(email);
  const date = String(dateKey || "").trim();
  if (!ddb || !process.env.ATTENDANCE_TABLE || !normalized || !isValidDateKey(date)) {
    return;
  }
  const { weekStart } = getCompanyWeekRange(date);
  const claim = await getWeekOffClaim(ddb, normalized, weekStart);
  if (!claim) return;
  if (leaveId && claim.leaveId && claim.leaveId !== leaveId) return;
  if (claim.date && claim.date !== date && !leaveId) return;
  await ddb.send(
    new DeleteCommand({
      TableName: process.env.ATTENDANCE_TABLE,
      Key: { PK: normalized, SK: weekOffClaimSk(weekStart) },
    })
  );
}

module.exports = {
  WEEK_OFF_ENTITLEMENT,
  WEEK_OFF_EXHAUSTED_MESSAGE,
  WEEK_OFF_ONE_DATE_MESSAGE,
  CLAIM_SK_PREFIX,
  getCompanyWeekRange,
  eachDateKey,
  validateSingleWeekOffDate,
  usedWeekOffFromRecords,
  confirmedLeaveDaysInWeek,
  overlappingWeekOffDate,
  overlappingApprovedLeaveDate,
  hasWeekOffUsedInCompanyWeek,
  getWeekOffWeekState,
  leaveConflictsWithWeekOff,
  weekOffConflictsWithLeave,
  consumeWeekOffEntitlement,
  releaseWeekOffClaim,
  isTransactionConflict,
  weekOffClaimSk,
  isPlannedOffLeave,
  isConfirmedApprovedLeave,
  buildWeekOffState,
  emptyWeekOffState,
};

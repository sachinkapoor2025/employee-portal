import { addDaysToKey } from "./attendanceCompliance";

function leaveDateRange(row) {
  const from = String(row?.fromDate || row?.startDate || "").trim();
  const to = String(row?.toDate || row?.endDate || from).trim();
  return { from, to };
}

function coversIstDate(row, dateKey) {
  const key = String(dateKey || "").trim();
  const { from, to } = leaveDateRange(row);
  if (!key || !from || !to) return false;
  return from <= key && to >= key;
}

function todayExcludedStatus(status) {
  const s = String(status || "").toUpperCase();
  return s === "REJECTED" || s === "CANCELLED";
}

function emailKey(value) {
  return String(value || "").trim().toLowerCase();
}

export const WEEK_OFF_SOURCE_LEAVE = "Week Off";
export const WEEK_OFF_SOURCE_ATTENDANCE = "Attendance";

export function isTodayLeave(row, todayKey) {
  if (!row || todayExcludedStatus(row.status)) return false;
  return coversIstDate(row, todayKey);
}

export function isHistoryLeave(row, todayKey) {
  return !isTodayLeave(row, todayKey);
}

export function splitLeaveViews(rows, todayKey) {
  const today = [];
  const history = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isTodayLeave(row, todayKey)) today.push(row);
    else history.push(row);
  }
  return { today, history };
}

export function isWeeklyOffAttendance(row) {
  return String(row?.status || "").trim() === "WeeklyOff";
}

export function attendanceCompanyDate(row) {
  return String(row?.date || row?.SK || "").trim();
}

function weekOffDedupKey(email, dateKey) {
  return `${emailKey(email)}|${String(dateKey || "").trim()}`;
}

export function toAttendanceWeekOffRow(row, dateKey) {
  const date = String(dateKey || attendanceCompanyDate(row) || "").trim();
  const email = emailKey(row?.email || row?.PK);
  return {
    leaveId: `attendance:${email}:${date}`,
    email,
    fromDate: date,
    toDate: date,
    days: 1,
    reason: row?.reason || "",
    emergencyReason: row?.emergencyReason || "",
    submittedAt: row?.submittedAt || row?.createdAt || null,
    createdAt: row?.createdAt || row?.submittedAt || null,
    employeeName: row?.employeeName || "",
    status: row?.status || "WeeklyOff",
    source: WEEK_OFF_SOURCE_ATTENDANCE,
  };
}

export function mergeTodayWeekOffRows(leaveWeekOffRows, attendanceRows, todayKey) {
  const key = String(todayKey || "").trim();
  const merged = [];
  const seen = new Set();

  for (const row of Array.isArray(leaveWeekOffRows) ? leaveWeekOffRows : []) {
    const email = emailKey(row?.email);
    if (!email || !key) continue;
    const dedup = weekOffDedupKey(email, key);
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    merged.push({
      ...row,
      email,
      source: row?.source || WEEK_OFF_SOURCE_LEAVE,
    });
  }

  for (const row of Array.isArray(attendanceRows) ? attendanceRows : []) {
    if (!isWeeklyOffAttendance(row)) continue;
    const date = attendanceCompanyDate(row);
    if (!key || date !== key) continue;
    const mapped = toAttendanceWeekOffRow(row, date);
    if (!mapped.email) continue;
    const dedup = weekOffDedupKey(mapped.email, key);
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    merged.push(mapped);
  }

  return merged;
}

export function uniqueEmployeeCount(rows) {
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const email = emailKey(row?.email);
    if (email) seen.add(email);
  }
  return seen.size;
}

function isPlannedOffRow(row) {
  return (
    row?.category === "PLANNED_OFF" ||
    row?.status === "PLANNED_OFF" ||
    row?.type === "PLANNED_OFF"
  );
}

export function isPendingLeaveStatus(status) {
  const s = String(status || "").toUpperCase();
  return s === "PENDING" || s === "PENDING_APPROVAL";
}

export function isConfirmedLeaveRow(row) {
  if (!row || isPlannedOffRow(row) || isPendingLeaveStatus(row.status)) return false;
  return String(row.status || "").toUpperCase() === "APPROVED";
}

export function todayTimeOffSummaryCounts({ weekOffRows, todayLeaveRows }) {
  const leaveRows = Array.isArray(todayLeaveRows) ? todayLeaveRows : [];
  return {
    weekOff: uniqueEmployeeCount(weekOffRows),
    onLeave: uniqueEmployeeCount(leaveRows.filter(isConfirmedLeaveRow)),
    pending: uniqueEmployeeCount(leaveRows.filter((row) => isPendingLeaveStatus(row.status))),
  };
}

export function historyDefaultFromKey(todayKey) {
  return addDaysToKey(String(todayKey || "").trim(), -29);
}

export function iterateCompanyDateKeys(fromKey, toKey) {
  const start = String(fromKey || "").trim();
  const end = String(toKey || "").trim();
  if (!start || !end || start > end) return [];
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

export function mergeHistoryWeekOffRows(leaveRows, attendanceRows, fromKey, toKey) {
  const leaveWeekOffs = (Array.isArray(leaveRows) ? leaveRows : []).filter(isPlannedOffRow);
  const merged = [];
  for (const dateKey of iterateCompanyDateKeys(fromKey, toKey)) {
    merged.push(
      ...mergeTodayWeekOffRows(
        leaveWeekOffs.filter((row) => coversIstDate(row, dateKey)),
        attendanceRows,
        dateKey
      )
    );
  }
  return merged;
}

export function matchesEmployeeSearch(row, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const email = emailKey(row?.email);
  const name = String(row?.employeeName || "").trim().toLowerCase();
  return email.includes(q) || name.includes(q);
}

export function leaveOverlapsCompanyRange(row, fromKey, toKey) {
  const from = String(fromKey || "").trim();
  const to = String(toKey || "").trim();
  const range = leaveDateRange(row);
  if (!from || !to || !range.from || !range.to) return false;
  return range.from <= to && range.to >= from;
}

export function matchesLeaveStatusFilter(row, statusFilter) {
  const filter = String(statusFilter || "ALL").toUpperCase();
  if (!filter || filter === "ALL") return true;
  if (filter === "PENDING") return isPendingLeaveStatus(row.status);
  return String(row.status || "").toUpperCase() === filter;
}

export function filterHistoryLeaveRows(rows, { search, fromKey, toKey, status } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (isPlannedOffRow(row)) return false;
    if (!leaveOverlapsCompanyRange(row, fromKey, toKey)) return false;
    if (!matchesEmployeeSearch(row, search)) return false;
    if (!matchesLeaveStatusFilter(row, status)) return false;
    return true;
  });
}

export function filterHistoryWeekOffRows(rows, { search } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    matchesEmployeeSearch(row, search)
  );
}

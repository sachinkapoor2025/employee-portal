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

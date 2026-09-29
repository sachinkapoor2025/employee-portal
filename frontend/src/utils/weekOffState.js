import { addDaysToKey, startOfWeekKey } from "./myActivityReport";

export const WEEK_OFF_EXHAUSTED_MESSAGE =
  "Week Off exhausted for this week. Please apply for Leave instead.";

function formatShortDate(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ""))) return "";
  const [y, m, d] = String(key).split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatWeekOffRange(weekStart, weekEnd) {
  const raw = weekStart || weekEnd;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw || ""))) return "";
  const start = startOfWeekKey(raw);
  const end = weekEnd && /^\d{4}-\d{2}-\d{2}$/.test(weekEnd)
    ? weekEnd
    : addDaysToKey(start, 6);
  const startLabel = formatShortDate(start);
  const endLabel = formatShortDate(end);
  if (!startLabel || !endLabel) return "";
  return `${startLabel} – ${endLabel}`;
}

export function weekOffDisplay(state) {
  if (!state || typeof state !== "object") {
    return {
      weekLabel: "This week",
      statusLabel: "Week Off: Available",
      detail: "1 day available",
      dashboardHint: "This week · Available",
      exhaustedMessage: WEEK_OFF_EXHAUSTED_MESSAGE,
      available: true,
      used: false,
      entitlement: 1,
      weekOffUsed: 0,
      weekOffUsedLabel: "0/1",
      leaveUsed: 0,
      balance: 1,
    };
  }
  const used = Number(state.weekOffUsed) === 1;
  const available = !used;
  const leaveUsed = Number(state?.leaveUsed) || 0;
  const entitlement = Number(state?.weekOffEntitlement) === 0 ? 0 : 1;
  const weekOffUsed = used ? 1 : 0;
  const balance =
    state?.balance == null ? entitlement - weekOffUsed - leaveUsed : Number(state.balance);
  const range = formatWeekOffRange(state?.weekStart, state?.weekEnd);
  return {
    weekLabel: range ? `This week: ${range}` : "This week",
    statusLabel: used ? "Week Off: Used" : "Week Off: Available",
    detail: used
      ? "You have already used your Week Off for this week."
      : "1 day available",
    dashboardHint: used ? "This week · Used" : "This week · Available",
    exhaustedMessage: WEEK_OFF_EXHAUSTED_MESSAGE,
    available,
    used,
    entitlement,
    weekOffUsed,
    weekOffUsedLabel: `${weekOffUsed}/1`,
    leaveUsed,
    balance,
  };
}

export const HOURS_INVALID = "Hours must be a positive number.";
export const PLANNED_REQUIRED_TO_START =
  "Enter planned hours before starting this task.";
export const PLANNED_HELPER =
  "Total hours you expect to spend on this task, excluding lunch and breaks.";
export const ACTUAL_REQUIRED =
  "Enter the total actual hours you spent on this task.";
export const ACTUAL_HELPER =
  "Manually enter the total hours you actually spent on this task. Do not include lunch or breaks.";

function roundHours(value) {
  return Math.round(value * 100) / 100;
}

export function parseRequiredHours(raw) {
  if (raw == null) return { ok: false, error: HOURS_INVALID };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) {
      return { ok: false, error: HOURS_INVALID };
    }
    return { ok: true, value: roundHours(raw) };
  }
  const text = String(raw).trim();
  if (!text) return { ok: false, error: HOURS_INVALID };
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { ok: false, error: HOURS_INVALID };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: HOURS_INVALID };
  }
  return { ok: true, value: roundHours(n) };
}

export function formatHours(raw) {
  if (raw == null || raw === "") return "—";
  const parsed = parseRequiredHours(raw);
  if (!parsed.ok) return "—";
  const n = parsed.value;
  return `${n} ${n === 1 ? "hour" : "hours"}`;
}

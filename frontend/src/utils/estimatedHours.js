import {
  formatStoredHoursAsHhMm,
  parseHhMmInput,
} from "./durationHours";

export const ESTIMATED_HOURS_HELPER =
  "Expected total effort to complete this task, excluding lunch and breaks.";

export const ESTIMATED_HOURS_REQUIRED =
  "Enter estimated hours as HH:MM (for example 02:30).";
export const ESTIMATED_HOURS_INVALID =
  "Enter estimated hours as HH:MM (for example 02:30).";

export function parseEstimatedHours(raw) {
  if (raw == null || String(raw).trim() === "") {
    return { ok: false, error: ESTIMATED_HOURS_REQUIRED };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) {
      return { ok: false, error: ESTIMATED_HOURS_INVALID };
    }
    return { ok: true, value: Math.round(raw * 100) / 100 };
  }
  const text = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { ok: false, error: ESTIMATED_HOURS_INVALID };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: ESTIMATED_HOURS_INVALID };
  }
  return { ok: true, value: Math.round(n * 100) / 100 };
}

export function parseEstimatedHoursInput(raw) {
  const parsed = parseHhMmInput(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      empty: Boolean(parsed.empty),
      error: parsed.error || ESTIMATED_HOURS_INVALID,
    };
  }
  return { ok: true, value: parsed.value };
}

export function formatEstimatedHours(raw) {
  if (raw == null || String(raw).trim() === "") return "—";
  return formatStoredHoursAsHhMm(raw);
}

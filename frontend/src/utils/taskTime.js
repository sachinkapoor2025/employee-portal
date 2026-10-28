import {
  formatStoredHoursAsHhMm,
  parseHhMmInput,
  parseStoredHours,
  prepareDurationSubmit,
} from "./durationHours";

export {
  HH_MM_HELPER,
  HH_MM_PLACEHOLDER,
  HH_MM_INVALID,
} from "./durationHours";

export const HOURS_INVALID =
  "Enter time as HH:MM (for example 02:30).";
export const PLANNED_REQUIRED_TO_START =
  "Enter planned hours before starting this task.";
export const PLANNED_HELPER =
  "Total hours you expect to spend on this task, excluding lunch and breaks.";
export const ACTUAL_REQUIRED =
  "Enter the total actual hours you spent on this task.";
export const ACTUAL_HELPER =
  "Manually enter the total hours you actually spent on this task. Do not include lunch or breaks.";

export function parseRequiredHours(raw) {
  const parsed = parseStoredHours(raw);
  if (!parsed.ok) return { ok: false, error: HOURS_INVALID };
  return { ok: true, value: parsed.value };
}

export function parseHoursInput(raw) {
  const parsed = parseHhMmInput(raw);
  if (parsed.ok) return parsed;
  return {
    ok: false,
    empty: Boolean(parsed.empty),
    error: parsed.empty ? HOURS_INVALID : parsed.error,
  };
}

/** Normalize HH:MM, then parse. Submit handlers must use this, not the raw state. */
export function prepareHoursSubmit(raw) {
  const prepared = prepareDurationSubmit(raw);
  if (prepared.ok) return prepared;
  return {
    ok: false,
    normalized: prepared.normalized,
    empty: Boolean(prepared.empty),
    error: prepared.empty ? HOURS_INVALID : prepared.error,
  };
}

export function parseOptionalHoursInput(raw) {
  const parsed = parseHoursInput(raw);
  if (parsed.empty) return { ok: true, value: null, empty: true };
  return parsed;
}

export function formatHours(raw) {
  return formatStoredHoursAsHhMm(raw);
}

export const HH_MM_PLACEHOLDER = "HH:MM";
export const HH_MM_HELPER =
  "Enter time as HH:MM. Examples: 00:30 = 30 minutes, 01:00 = 1 hour, 02:30 = 2 hours 30 minutes, 08:00 = 8 hours, 24:30 = 24 hours 30 minutes.";
export const HH_MM_INVALID =
  "Enter time as HH:MM (for example 02:30).";
export const HH_MM_POSITIVE = "Time must be greater than 00:00.";

const HH_MM_RE = /^(\d{1,4}):([0-5]\d)$/;
const NEGATIVE_HH_MM_RE = /^-/;

export function roundHours(value) {
  return Math.round(value * 100) / 100;
}

export function padHours(hours) {
  return String(Math.max(0, Math.floor(Number(hours) || 0))).padStart(2, "0");
}

export function padMinutes(minutes) {
  const n = Math.max(0, Math.min(59, Math.floor(Number(minutes) || 0)));
  return String(n).padStart(2, "0");
}

export function formatHhMm(hours, minutes) {
  return `${padHours(hours)}:${padMinutes(minutes)}`;
}

export function storedHoursToMinutes(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 60);
}

export function minutesToStoredHours(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return null;
  return roundHours(totalMinutes / 60);
}

export function hoursToHhMm(hours) {
  const totalMinutes = storedHoursToMinutes(hours);
  if (totalMinutes == null) return "";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return formatHhMm(h, m);
}

/**
 * Apply the same padding the hour field applies on blur.
 * `2:3` becomes `02:03`. `8:` becomes `08:00`.
 * Values the blur path does not accept, such as minutes above 59, stay invalid.
 */
export function normalizeHhMmInput(raw) {
  if (raw == null) return "";
  const text = String(raw).trim();
  if (!text) return "";
  if (NEGATIVE_HH_MM_RE.test(text)) return text;
  const match = text.match(/^(\d{0,4}):(\d{0,2})$/);
  if (!match) return text;
  const hoursPart = match[1];
  const minutesPart = match[2];
  if (hoursPart === "" && minutesPart === "") return "";
  const mins = minutesPart === "" ? 0 : Number(minutesPart);
  const hours = hoursPart === "" ? "00" : padHours(hoursPart);
  if (!Number.isFinite(mins) || mins > 59) {
    return `${hours}:${minutesPart || "00"}`;
  }
  return `${hours}:${padMinutes(mins)}`;
}

export function prepareDurationSubmit(raw) {
  const normalized = normalizeHhMmInput(raw);
  const parsed = parseHhMmInput(normalized);
  if (parsed.ok) return { ok: true, normalized, value: parsed.value };
  return {
    ok: false,
    normalized,
    empty: Boolean(parsed.empty),
    error: parsed.error,
  };
}

export function parseHhMmInput(raw) {
  if (raw == null) return { ok: false, empty: true, error: HH_MM_INVALID };
  const text = String(raw).trim();
  if (!text) return { ok: false, empty: true, error: HH_MM_INVALID };
  if (NEGATIVE_HH_MM_RE.test(text)) {
    return { ok: false, empty: false, error: HH_MM_INVALID };
  }
  const match = text.match(HH_MM_RE);
  if (!match) return { ok: false, empty: false, error: HH_MM_INVALID };
  const totalMinutes = Number(match[1]) * 60 + Number(match[2]);
  const value = minutesToStoredHours(totalMinutes);
  if (value == null || value <= 0) {
    return { ok: false, empty: false, error: HH_MM_POSITIVE };
  }
  return { ok: true, value };
}

export function parseStoredHours(raw) {
  if (raw == null || raw === "") return { ok: false };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return { ok: false };
    return { ok: true, value: roundHours(raw) };
  }
  const text = String(raw).trim();
  if (!text) return { ok: false };
  if (HH_MM_RE.test(text) || NEGATIVE_HH_MM_RE.test(text)) {
    return parseHhMmInput(text);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false };
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  return { ok: true, value: roundHours(n) };
}

export function formatStoredHoursAsHhMm(raw) {
  const parsed = parseStoredHours(raw);
  if (!parsed.ok) return "—";
  return hoursToHhMm(parsed.value) || "—";
}

export function splitDurationParts(value) {
  const text = String(value || "").trim();
  if (!text) return { hours: 0, minutes: 0, empty: true };
  const match = text.match(/^(\d{0,4}):(\d{0,2})$/);
  if (!match) return { hours: 0, minutes: 0, empty: true };
  return {
    hours: Number(match[1] || 0),
    minutes: Number(match[2] || 0),
    empty: false,
  };
}

export function stepDuration(value, unit, delta) {
  const parts = splitDurationParts(value);
  let hours = parts.hours;
  let minutes = Math.min(59, parts.minutes);
  if (unit === "hours") {
    hours = Math.max(0, hours + delta);
  } else {
    const total = Math.max(0, hours * 60 + minutes + delta);
    hours = Math.floor(total / 60);
    minutes = total % 60;
  }
  return formatHhMm(hours, minutes);
}

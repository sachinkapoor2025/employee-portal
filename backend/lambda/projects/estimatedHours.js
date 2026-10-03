const ESTIMATED_HOURS_INVALID =
  "Estimated hours must be a positive number.";

function roundEstimatedHours(value) {
  return Math.round(value * 100) / 100;
}

function parseEstimatedHours(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) {
      return { ok: false, error: ESTIMATED_HOURS_INVALID };
    }
    return { ok: true, value: roundEstimatedHours(raw) };
  }
  const text = String(raw).trim();
  if (!text) return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { ok: false, error: ESTIMATED_HOURS_INVALID };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: ESTIMATED_HOURS_INVALID };
  }
  return { ok: true, value: roundEstimatedHours(n) };
}

module.exports = {
  ESTIMATED_HOURS_INVALID,
  parseEstimatedHours,
};

const ESTIMATED_HOURS_REQUIRED = "Estimated hours are required.";
const ESTIMATED_HOURS_INVALID =
  "Estimated hours must be a positive number.";

function roundEstimatedHours(value) {
  return Math.round(value * 100) / 100;
}

function isBlankEstimatedHours(raw) {
  if (raw == null) return true;
  if (typeof raw === "string" && !String(raw).trim()) return true;
  return false;
}

function parseEstimatedHours(raw) {
  if (isBlankEstimatedHours(raw)) {
    return { ok: false, error: ESTIMATED_HOURS_REQUIRED };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) {
      return { ok: false, error: ESTIMATED_HOURS_INVALID };
    }
    return { ok: true, value: roundEstimatedHours(raw) };
  }
  const text = String(raw).trim();
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
  ESTIMATED_HOURS_REQUIRED,
  ESTIMATED_HOURS_INVALID,
  parseEstimatedHours,
};

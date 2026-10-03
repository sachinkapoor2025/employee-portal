const HOURS_INVALID = "Hours must be a positive number.";
const PLANNED_REQUIRED_TO_START =
  "Enter planned hours before starting this task.";
const PLANNED_LOCKED = "Planned hours cannot be changed after the task has started.";
const ACTUALS_REQUIRED_TO_REVIEW =
  "Enter the total actual hours you spent on this task.";

function roundHours(value) {
  return Math.round(value * 100) / 100;
}

function parseRequiredHours(raw) {
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

function assignmentPlanLocked(assignment) {
  const status = String(assignment?.status || "").toUpperCase();
  return status !== "TODO" && status !== "BACKLOG";
}

module.exports = {
  HOURS_INVALID,
  PLANNED_REQUIRED_TO_START,
  PLANNED_LOCKED,
  ACTUALS_REQUIRED_TO_REVIEW,
  parseRequiredHours,
  assignmentPlanLocked,
};

export function moneyUsd(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export function hoursLabel(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return String(n);
}

export const LEGACY_BASELINE_NOTE =
  "Current-rate baseline. Not a historically verified rate.";

export function costingBasisNote(row) {
  if (!row) return "";
  if (row.legacyBaseline) return LEGACY_BASELINE_NOTE;
  if (row.costStatus === "MISSING_RATE") {
    return "No applicable rate is stored, so there is no confirmed cost.";
  }
  if (row.costStatus === "MISSING_COST_RECORD") {
    if (row.reason === "SUBMISSION_NOT_FINALIZED") {
      return "Submission is not finalized, so there is no confirmed cost.";
    }
    if (row.reason === "SUBMISSION_RETURNED") {
      return "The earlier submission was returned and is not a confirmed cost.";
    }
    return "No confirmed cost record is stored.";
  }
  return "";
}

export function costStatusLabel(status) {
  const key = String(status || "").toUpperCase();
  if (key === "COSTED") return "Costed";
  if (key === "MISSING_RATE") return "Missing rate";
  if (key === "MISSING_COST_RECORD") return "Missing cost record";
  if (key === "UNPRICED_LEGACY") return "Unpriced legacy";
  if (key === "PENDING_REVIEW") return "Pending review";
  if (key === "SUPERSEDED") return "Reassigned";
  if (key === "OPEN") return "In progress";
  return key || "—";
}

export function rateSourceLabel(source) {
  const key = String(source || "").toUpperCase();
  if (key === "EMPLOYEE") return "Employee-specific";
  if (key === "DESIGNATION") return "Designation";
  return source || "—";
}

export function formatReportDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isFinite(d.getTime())) {
    return d.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return String(value);
}

export function companyDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export function addDaysToKey(key, days) {
  const [year, month, day] = String(key).split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day + Number(days || 0));
  const next = new Date(utc);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, "0");
  const d = String(next.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function defaultCostingRange() {
  const to = companyDateKey();
  return { from: addDaysToKey(to, -29), to };
}

export const INCOMPLETE_COSTING_TOTALS =
  "These totals are incomplete and are not a complete or authoritative cost for this report window.";

export const INCOMPLETE_REPORT_TITLE =
  "Incomplete report — totals are not authoritative.";

export const INCOMPLETE_REPORT_DETAIL =
  "This report did not collect all eligible records. Displayed figures must not be used as complete project or employee costs.";

export const INCOMPLETE_TOTAL_DISPLAY = "Incomplete — not authoritative";

export const PARTIAL_COLLECTED_AMOUNT_LABEL =
  "Partial collected amount — not a complete total";

export function isCostingTruncated(data) {
  return data?.truncated === true;
}

/** Keep truncation while paging; never treat a later page as a complete report. */
export function withPersistedTruncation(previous, next, { paged = false } = {}) {
  if (!next || typeof next !== "object") return next;
  if (paged && previous?.truncated === true) {
    return { ...next, truncated: true };
  }
  return next;
}

export function confirmedCostHeadline(truncated, confirmedCostUsd) {
  if (truncated === true) return INCOMPLETE_TOTAL_DISPLAY;
  return moneyUsd(confirmedCostUsd);
}

export function assignmentRowKey(row) {
  return `${row?.taskId || ""}:${String(row?.email || "").toLowerCase()}`;
}

export function mergeCostingPages(previous, next, { reset = false } = {}) {
  const incoming = Array.isArray(next) ? next : [];
  if (reset || !Array.isArray(previous) || !previous.length) {
    return [...incoming];
  }
  const seen = new Set(previous.map(assignmentRowKey));
  const merged = [...previous];
  for (const row of incoming) {
    const key = assignmentRowKey(row);
    if (!key || key === ":" || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

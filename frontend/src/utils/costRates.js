const RATE_INVALID =
  "Hourly rate must be a finite positive number in USD with at most two decimal places.";

export function isBlankRateInput(raw) {
  return raw == null || String(raw).trim() === "";
}

export function parseUsdRateInput(raw) {
  if (isBlankRateInput(raw)) return { ok: true, value: null };
  const text = String(raw).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: RATE_INVALID };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: RATE_INVALID };
  }
  return { ok: true, value: n };
}

export function formatUsdRate(rate) {
  if (rate == null || rate === "") return "";
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `$${n.toFixed(2)}`;
}

export function displayRateOrUnset(rate) {
  const formatted = formatUsdRate(rate);
  return formatted || "Not configured";
}

export function rateSourceLabel(source) {
  const s = String(source || "").toUpperCase();
  if (s === "EMPLOYEE") return "Employee";
  if (s === "DESIGNATION") return "Designation";
  return "Not configured";
}

export function resolvedPreviewLine(resolvedSide) {
  const source = rateSourceLabel(resolvedSide?.source);
  if (!resolvedSide?.rate) {
    return { text: "Not configured", source };
  }
  return { text: formatUsdRate(resolvedSide.rate), source };
}

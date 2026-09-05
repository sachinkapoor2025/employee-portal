function companyOffset() {
  return process.env.COMPANY_TZ_OFFSET || "+05:30";
}

function parseExpiresAt(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ms = Date.parse(`${raw}T23:59:59${companyOffset()}`);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function isExpired(item, nowMs = Date.now()) {
  const ms = parseExpiresAt(item?.expiresAt);
  if (!Number.isFinite(ms)) return false;
  return nowMs >= ms;
}

function announcementStatus(item, nowMs = Date.now()) {
  if (item?.active === false) return "INACTIVE";
  if (!item?.expiresAt) return "NO_EXPIRY";
  return isExpired(item, nowMs) ? "EXPIRED" : "ACTIVE";
}

function isPubliclyVisible(item, nowMs = Date.now()) {
  if (!item || item.active === false) return false;
  return !isExpired(item, nowMs);
}

function displayNameFromEmail(email) {
  const local = String(email || "").split("@")[0] || "";
  const name = local
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return name || String(email || "").trim();
}

function nameFromClaims(claims = {}) {
  const combined = `${claims.given_name || ""} ${claims.family_name || ""}`.trim();
  if (combined) return combined;
  const name = String(claims.name || "").trim();
  if (name && !name.includes("@")) return name;
  return "";
}

function pickPersonName(...candidates) {
  for (const value of candidates) {
    const name = String(value || "").trim();
    if (name && !name.includes("@")) return name;
  }
  return "";
}

function resolveAuthorName({ profileName, claimsName, email } = {}) {
  return (
    pickPersonName(profileName, claimsName) ||
    displayNameFromEmail(email) ||
    String(email || "").trim()
  );
}

function withAnnouncementStatus(item, nowMs = Date.now()) {
  const createdByName =
    pickPersonName(item?.createdByName) ||
    displayNameFromEmail(item?.createdBy) ||
    item?.createdBy ||
    "";
  const updatedByName =
    pickPersonName(item?.updatedByName) ||
    (item?.updatedBy ? displayNameFromEmail(item.updatedBy) : "") ||
    createdByName;
  return {
    ...item,
    createdByName,
    updatedByName,
    status: announcementStatus(item, nowMs),
    expired: isExpired(item, nowMs),
  };
}

module.exports = {
  parseExpiresAt,
  isExpired,
  announcementStatus,
  isPubliclyVisible,
  withAnnouncementStatus,
  displayNameFromEmail,
  nameFromClaims,
  resolveAuthorName,
};

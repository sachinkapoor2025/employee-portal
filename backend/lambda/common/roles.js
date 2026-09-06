/**
 * Portal role model (stored on UserAccess.role).
 * Cognito groups remain Admin | Employee for JWT isAdmin checks.
 */

const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  MANAGER: "MANAGER",
  EMPLOYEE: "EMPLOYEE",
  /** @deprecated legacy alias — treat as EMPLOYEE */
  USER: "USER",
};

const ADMIN_PORTAL_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.MANAGER,
]);

function normalizeRole(role) {
  const r = String(role || "").trim().toUpperCase();
  if (r === "USER") return ROLES.EMPLOYEE;
  if (Object.values(ROLES).includes(r) && r !== "USER") return r;
  return ROLES.EMPLOYEE;
}

function isAdminPortalRole(role) {
  return ADMIN_PORTAL_ROLES.has(normalizeRole(role));
}

/** Documents project writes + browsing another user's Personal folder. */
function canManageProjectDocuments(role) {
  const r = normalizeRole(role);
  return r === ROLES.SUPER_ADMIN || r === ROLES.ADMIN;
}

/** Cognito group name for a portal role */
function cognitoGroupForRole(role) {
  return isAdminPortalRole(role) ? "Admin" : "Employee";
}

/** Access API gate value: ADMIN | USER (keeps existing frontend redirects) */
function accessGateForRole(role) {
  return isAdminPortalRole(role) ? "ADMIN" : "USER";
}

function isValidAssignableRole(role) {
  const r = normalizeRole(role);
  return (
    r === ROLES.SUPER_ADMIN ||
    r === ROLES.ADMIN ||
    r === ROLES.MANAGER ||
    r === ROLES.EMPLOYEE
  );
}

/** Active portal administrators from UserAccess rows (no hardcoded emails). */
function activeAdminEmailsFromAccess(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const email = String(row.email || row.PK || "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    if (String(row.status || "").toUpperCase() !== "ACTIVE") continue;
    if (!isAdminPortalRole(row.role)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

module.exports = {
  ROLES,
  ADMIN_PORTAL_ROLES,
  normalizeRole,
  isAdminPortalRole,
  canManageProjectDocuments,
  cognitoGroupForRole,
  accessGateForRole,
  isValidAssignableRole,
  activeAdminEmailsFromAccess,
};

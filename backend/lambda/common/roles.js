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

function isSuperAdminRole(role) {
  return normalizeRole(role) === ROLES.SUPER_ADMIN;
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

/** Activate / deactivate (ACTIVE ↔ BLOCKED) and permanent delete. */
function canManageUserAccessLifecycle(actorRole) {
  return isSuperAdminRole(actorRole);
}

/**
 * SUPER_ADMIN may assign any valid portal role.
 * ADMIN/MANAGER/EMPLOYEE keep existing role-management except SUPER_ADMIN.
 */
function canAssignPortalRole(actorRole, targetRole) {
  if (!isValidAssignableRole(targetRole)) return false;
  if (isSuperAdminRole(targetRole) && !isSuperAdminRole(actorRole)) return false;
  return true;
}

function activeEmailsFromAccess(rows = [], rolePredicate) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const email = String(row.email || row.PK || "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    if (String(row.status || "").toUpperCase() !== "ACTIVE") continue;
    if (!rolePredicate(row.role)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** Active portal administrators from UserAccess rows (no hardcoded emails). */
function activeAdminEmailsFromAccess(rows = []) {
  return activeEmailsFromAccess(rows, isAdminPortalRole);
}

function isAdminOrSuperAdminRole(role) {
  const r = normalizeRole(role);
  return r === ROLES.SUPER_ADMIN || r === ROLES.ADMIN;
}

/** Active SUPER_ADMIN emails only (excludes ADMIN/MANAGER and inactive users). */
function activeSuperAdminEmailsFromAccess(rows = []) {
  return activeEmailsFromAccess(rows, isSuperAdminRole);
}

/** Active ADMIN + SUPER_ADMIN emails (excludes MANAGER and inactive users). */
function activeCompletionAdminEmailsFromAccess(rows = []) {
  return activeEmailsFromAccess(rows, isAdminOrSuperAdminRole);
}

module.exports = {
  ROLES,
  ADMIN_PORTAL_ROLES,
  normalizeRole,
  isAdminPortalRole,
  isSuperAdminRole,
  canManageProjectDocuments,
  cognitoGroupForRole,
  accessGateForRole,
  isValidAssignableRole,
  canManageUserAccessLifecycle,
  canAssignPortalRole,
  activeAdminEmailsFromAccess,
  activeSuperAdminEmailsFromAccess,
  activeCompletionAdminEmailsFromAccess,
};

/**
 * Frontend role helpers (mirrors backend/lambda/common/roles.js).
 */

export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  MANAGER: "MANAGER",
  EMPLOYEE: "EMPLOYEE",
};

export const ROLE_OPTIONS = [
  { value: ROLES.SUPER_ADMIN, label: "Super Admin" },
  { value: ROLES.ADMIN, label: "Admin" },
  { value: ROLES.MANAGER, label: "Manager" },
  { value: ROLES.EMPLOYEE, label: "Employee" },
];

export function normalizeRole(role) {
  const r = String(role || "").trim().toUpperCase();
  if (r === "USER") return ROLES.EMPLOYEE;
  if (Object.values(ROLES).includes(r)) return r;
  return ROLES.EMPLOYEE;
}

export function isSuperAdminRole(role) {
  return normalizeRole(role) === ROLES.SUPER_ADMIN;
}

export function isAdminPortalRole(role) {
  const r = normalizeRole(role);
  return (
    r === ROLES.SUPER_ADMIN || r === ROLES.ADMIN || r === ROLES.MANAGER
  );
}

/** Documents project writes: Admin / Super Admin only — not Manager. */
export function canManageProjectDocuments(role) {
  const r = normalizeRole(role);
  return r === ROLES.SUPER_ADMIN || r === ROLES.ADMIN;
}

/** Activate / deactivate and permanent delete: Super Admin only. */
export function canManageUserAccessLifecycle(role) {
  return isSuperAdminRole(role);
}

/** ADMIN may still assign ADMIN/MANAGER/EMPLOYEE; SUPER_ADMIN grant is Super Admin only. */
export function canAssignPortalRole(actorRole, targetRole) {
  if (normalizeRole(targetRole) === ROLES.SUPER_ADMIN && !isSuperAdminRole(actorRole)) {
    return false;
  }
  return true;
}

export function roleOptionsForActor(actorRole, currentRole) {
  if (isSuperAdminRole(actorRole)) return ROLE_OPTIONS;
  const current = normalizeRole(currentRole);
  return ROLE_OPTIONS.filter(
    (o) => o.value !== ROLES.SUPER_ADMIN || o.value === current
  );
}

/** Live UserAccess.role for the logged-in actor, with optional session fallback. */
export function resolveActorRoleFromUsers(users, currentEmail, fallbackRole = "") {
  const email = String(currentEmail || "").trim().toLowerCase();
  if (email) {
    const me = (users || []).find(
      (u) => String(u.email || "").toLowerCase() === email
    );
    if (me?.role) return me.role;
  }
  return fallbackRole || "";
}

export function manageUsersMenuFlags(actorRole, user, currentEmail) {
  const canLifecycle = canManageUserAccessLifecycle(actorRole);
  const status = String(user?.status || "");
  const target = String(user?.email || "").toLowerCase();
  const self = String(currentEmail || "").toLowerCase();
  return {
    showDeactivate: canLifecycle && status === "ACTIVE",
    showActivate: canLifecycle && status !== "ACTIVE",
    showDelete: canLifecycle && Boolean(target) && target !== self,
  };
}

export function roleLabel(role) {
  const r = normalizeRole(role);
  const found = ROLE_OPTIONS.find((o) => o.value === r);
  return found?.label || r;
}

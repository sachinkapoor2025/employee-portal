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

export function roleLabel(role) {
  const r = normalizeRole(role);
  const found = ROLE_OPTIONS.find((o) => o.value === r);
  return found?.label || r;
}

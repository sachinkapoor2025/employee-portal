import {
  ROLES,
  canManageUserAccessLifecycle,
  canAssignPortalRole,
  roleOptionsForActor,
} from "./roles";

test("ADMIN cannot activate, deactivate, or delete users", () => {
  expect(canManageUserAccessLifecycle(ROLES.ADMIN)).toBe(false);
});

test("SUPER_ADMIN can activate, deactivate, and delete users", () => {
  expect(canManageUserAccessLifecycle(ROLES.SUPER_ADMIN)).toBe(true);
});

test("ADMIN cannot promote a user or themselves to SUPER_ADMIN", () => {
  expect(canAssignPortalRole(ROLES.ADMIN, ROLES.SUPER_ADMIN)).toBe(false);
  expect(canAssignPortalRole(ROLES.ADMIN, ROLES.ADMIN)).toBe(true);
  expect(canAssignPortalRole(ROLES.ADMIN, ROLES.MANAGER)).toBe(true);
  expect(canAssignPortalRole(ROLES.ADMIN, ROLES.EMPLOYEE)).toBe(true);
  expect(
    roleOptionsForActor(ROLES.ADMIN, ROLES.EMPLOYEE).some(
      (o) => o.value === ROLES.SUPER_ADMIN
    )
  ).toBe(false);
});

test("SUPER_ADMIN can assign the SUPER_ADMIN role", () => {
  expect(canAssignPortalRole(ROLES.SUPER_ADMIN, ROLES.SUPER_ADMIN)).toBe(true);
  expect(
    roleOptionsForActor(ROLES.SUPER_ADMIN, ROLES.EMPLOYEE).some(
      (o) => o.value === ROLES.SUPER_ADMIN
    )
  ).toBe(true);
});

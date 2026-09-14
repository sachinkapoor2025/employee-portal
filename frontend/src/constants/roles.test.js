import {
  ROLES,
  canManageUserAccessLifecycle,
  canAssignPortalRole,
  roleOptionsForActor,
  resolveActorRoleFromUsers,
  manageUsersMenuFlags,
} from "./roles";

test("stale or missing portalRole still uses live SUPER_ADMIN UserAccess role", () => {
  const users = [
    { email: "boss@mydgv.com", role: "SUPER_ADMIN", status: "ACTIVE" },
    { email: "doer@mydgv.com", role: "EMPLOYEE", status: "ACTIVE" },
  ];
  expect(
    resolveActorRoleFromUsers(users, "boss@mydgv.com", "ADMIN")
  ).toBe(ROLES.SUPER_ADMIN);
  expect(resolveActorRoleFromUsers(users, "boss@mydgv.com", "")).toBe(
    ROLES.SUPER_ADMIN
  );
  expect(
    canManageUserAccessLifecycle(
      resolveActorRoleFromUsers(users, "boss@mydgv.com", "ADMIN")
    )
  ).toBe(true);
});

test("SUPER_ADMIN sees Deactivate for ACTIVE users", () => {
  const actorRole = resolveActorRoleFromUsers(
    [{ email: "boss@mydgv.com", role: "SUPER_ADMIN" }],
    "boss@mydgv.com",
    "ADMIN"
  );
  const flags = manageUsersMenuFlags(
    actorRole,
    { email: "doer@mydgv.com", status: "ACTIVE" },
    "boss@mydgv.com"
  );
  expect(flags.showDeactivate).toBe(true);
  expect(flags.showActivate).toBe(false);
});

test("SUPER_ADMIN sees Activate for BLOCKED users", () => {
  const actorRole = resolveActorRoleFromUsers(
    [{ email: "boss@mydgv.com", role: "SUPER_ADMIN" }],
    "boss@mydgv.com",
    ""
  );
  const flags = manageUsersMenuFlags(
    actorRole,
    { email: "blocked@mydgv.com", status: "BLOCKED" },
    "boss@mydgv.com"
  );
  expect(flags.showActivate).toBe(true);
  expect(flags.showDeactivate).toBe(false);
});

test("SUPER_ADMIN sees Delete for other users, not self", () => {
  const actorRole = resolveActorRoleFromUsers(
    [{ email: "boss@mydgv.com", role: "SUPER_ADMIN" }],
    "boss@mydgv.com",
    "ADMIN"
  );
  expect(
    manageUsersMenuFlags(
      actorRole,
      { email: "doer@mydgv.com", status: "ACTIVE" },
      "boss@mydgv.com"
    ).showDelete
  ).toBe(true);
  expect(
    manageUsersMenuFlags(
      actorRole,
      { email: "boss@mydgv.com", status: "ACTIVE" },
      "boss@mydgv.com"
    ).showDelete
  ).toBe(false);
});

test("ADMIN does not see Deactivate, Activate, or Delete", () => {
  const actorRole = resolveActorRoleFromUsers(
    [{ email: "admin@mydgv.com", role: "ADMIN", status: "ACTIVE" }],
    "admin@mydgv.com",
    "ADMIN"
  );
  const active = manageUsersMenuFlags(
    actorRole,
    { email: "doer@mydgv.com", status: "ACTIVE" },
    "admin@mydgv.com"
  );
  const blocked = manageUsersMenuFlags(
    actorRole,
    { email: "blocked@mydgv.com", status: "BLOCKED" },
    "admin@mydgv.com"
  );
  expect(active.showDeactivate).toBe(false);
  expect(blocked.showActivate).toBe(false);
  expect(active.showDelete).toBe(false);
  expect(canManageUserAccessLifecycle(actorRole)).toBe(false);
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
  const actorRole = resolveActorRoleFromUsers(
    [{ email: "boss@mydgv.com", role: "SUPER_ADMIN" }],
    "boss@mydgv.com",
    "ADMIN"
  );
  expect(canAssignPortalRole(actorRole, ROLES.SUPER_ADMIN)).toBe(true);
  expect(
    roleOptionsForActor(actorRole, ROLES.EMPLOYEE).some(
      (o) => o.value === ROLES.SUPER_ADMIN
    )
  ).toBe(true);
});

test("ADMIN does not see SUPER_ADMIN in role options", () => {
  const actorRole = resolveActorRoleFromUsers(
    [{ email: "admin@mydgv.com", role: "ADMIN" }],
    "admin@mydgv.com",
    "ADMIN"
  );
  expect(
    roleOptionsForActor(actorRole, ROLES.EMPLOYEE).some(
      (o) => o.value === ROLES.SUPER_ADMIN
    )
  ).toBe(false);
});

const assert = require("assert");
const {
  ACCESS_OPEN,
  ACCESS_RESTRICTED,
  VISIBILITY_ASSIGNED_ONLY,
  VISIBILITY_ALL_PROJECT_TASKS,
  projectAccessMode,
  isRestrictedProject,
  normalizeEmail,
  projectMemberKeys,
  projectAdminKeys,
  isActiveRegularMemberItem,
  isActiveProjectAdminItem,
  isEligibleProjectAdmin,
  projectAdminTaskVisibility,
  canAccessRestrictedProject,
  isProjectDeleting,
  isUsableProject,
  DELETION_DELETING,
} = require("./projectAccess");

const PROJECT_ID = "proj-1";
const OTHER_PROJECT = "proj-2";
const ADMIN_EMAIL = "admin@mydgv.com";
const SUPER_EMAIL = "super@mydgv.com";
const MGR_EMAIL = "mgr@mydgv.com";
const EMP_EMAIL = "rahul@mydgv.com";

const restrictedProject = {
  projectId: PROJECT_ID,
  accessMode: "RESTRICTED",
  createdBy: SUPER_EMAIL,
  lead: ADMIN_EMAIL,
  members: [EMP_EMAIL, ADMIN_EMAIL],
};

function memberItem(email, status = "ACTIVE", side = "project", projectId = PROJECT_ID) {
  const keys = projectMemberKeys(projectId, email);
  const pair = side === "user" ? keys.userSide : keys.projectSide;
  return { ...pair, type: "PROJECT_MEMBER", status, projectId, email };
}

function adminItem(email, status = "ACTIVE", side = "project", projectId = PROJECT_ID) {
  const keys = projectAdminKeys(projectId, email);
  const pair = side === "user" ? keys.userSide : keys.projectSide;
  return {
    ...pair,
    type: "PROJECT_ADMIN",
    status,
    projectId,
    email,
    taskVisibility: "ALL_PROJECT_TASKS",
  };
}

assert.strictEqual(projectAccessMode({}), ACCESS_OPEN);
assert.strictEqual(projectAccessMode({ accessMode: undefined }), ACCESS_OPEN);
assert.strictEqual(projectAccessMode(null), ACCESS_OPEN);
assert.strictEqual(projectAccessMode({ accessMode: "OPEN" }), ACCESS_OPEN);
assert.strictEqual(projectAccessMode({ accessMode: "open" }), ACCESS_OPEN);
assert.strictEqual(projectAccessMode({ accessMode: "RESTRICTED" }), ACCESS_RESTRICTED);
assert.strictEqual(projectAccessMode({ accessMode: "restricted" }), ACCESS_RESTRICTED);
assert.strictEqual(projectAccessMode({ accessMode: null }), ACCESS_OPEN);
assert.strictEqual(projectAccessMode({ accessMode: "" }), ACCESS_OPEN);
assert.strictEqual(projectAccessMode({ accessMode: "   " }), ACCESS_OPEN);
assert.strictEqual(projectAccessMode({ accessMode: "NOPE" }), ACCESS_OPEN);
assert.strictEqual(isRestrictedProject({ accessMode: "RESTRICTED" }), true);
assert.strictEqual(isRestrictedProject({}), false);
assert.strictEqual(isProjectDeleting(null), false);
assert.strictEqual(isProjectDeleting({ deletionStatus: DELETION_DELETING }), true);
assert.strictEqual(isProjectDeleting({ deletionStatus: "DELETED" }), true);
assert.strictEqual(isProjectDeleting({ deletionStatus: "nope" }), false);
assert.strictEqual(isUsableProject({ projectId: "p1", deletionStatus: "DELETING" }), false);
assert.strictEqual(isUsableProject({ projectId: "p1" }), true);
assert.strictEqual(isUsableProject({}), false);

const original = { accessMode: "RESTRICTED" };
projectAccessMode(original);
assert.strictEqual(original.accessMode, "RESTRICTED");

assert.strictEqual(normalizeEmail("  Admin@MyDGV.com  "), "admin@mydgv.com");
assert.strictEqual(normalizeEmail(""), "");
assert.deepStrictEqual(projectMemberKeys(PROJECT_ID, "  Admin@MyDGV.com "), {
  projectSide: { PK: "PROJECT#proj-1", SK: "MEMBER#admin@mydgv.com" },
  userSide: { PK: "USER#admin@mydgv.com", SK: "PROJECT_MEMBER#proj-1" },
});
assert.deepStrictEqual(projectAdminKeys(PROJECT_ID, "Admin@MyDGV.com"), {
  projectSide: { PK: "PROJECT#proj-1", SK: "PROJECT_ADMIN#admin@mydgv.com" },
  userSide: { PK: "USER#admin@mydgv.com", SK: "PROJECT_ADMIN#proj-1" },
});

assert.strictEqual(
  isEligibleProjectAdmin({ role: "ADMIN", status: "ACTIVE" }),
  true,
  "eligibility: active ADMIN"
);
assert.strictEqual(
  isEligibleProjectAdmin({ role: "SUPER_ADMIN", status: "ACTIVE" }),
  true,
  "eligibility: active SUPER_ADMIN"
);
assert.strictEqual(
  isEligibleProjectAdmin({ role: "MANAGER", status: "ACTIVE" }),
  false,
  "eligibility: MANAGER"
);
assert.strictEqual(
  isEligibleProjectAdmin({ role: "EMPLOYEE", status: "ACTIVE" }),
  false,
  "eligibility: EMPLOYEE"
);
assert.strictEqual(
  isEligibleProjectAdmin({ role: "ADMIN", status: "BLOCKED" }),
  false,
  "eligibility: blocked ADMIN"
);
assert.strictEqual(
  isEligibleProjectAdmin({ role: "ADMIN", status: "PENDING" }),
  false,
  "eligibility: pending ADMIN"
);
assert.strictEqual(
  isEligibleProjectAdmin({ role: "ADMIN", status: "ACTIVE", isAdmin: false }),
  true,
  "eligibility ignores Cognito isAdmin"
);
assert.strictEqual(isEligibleProjectAdmin(null), false, "eligibility: null UserAccess");
assert.strictEqual(
  isEligibleProjectAdmin({ role: "EMPLOYEE", status: "ACTIVE", isAdmin: true }),
  false,
  "eligibility: EMPLOYEE with Cognito isAdmin"
);
assert.strictEqual(
  isEligibleProjectAdmin({ role: "MANAGER", status: "ACTIVE", isAdmin: true }),
  false,
  "eligibility: MANAGER with Cognito isAdmin"
);
assert.strictEqual(
  isEligibleProjectAdmin({ role: "AUDITOR", status: "ACTIVE" }),
  false,
  "eligibility: unsupported role"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: SUPER_EMAIL,
    regularMemberItem: null,
    projectAdminItem: null,
  }),
  false,
  "restricted: Super Admin without membership or Project Admin assignment"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: EMP_EMAIL,
    regularMemberItem: memberItem(EMP_EMAIL),
    projectAdminItem: null,
  }),
  true,
  "restricted: active regular member"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: ADMIN_EMAIL,
    regularMemberItem: null,
    projectAdminItem: adminItem(ADMIN_EMAIL),
  }),
  true,
  "restricted: explicit Project Admin"
);

assert.strictEqual(
  isActiveProjectAdminItem(adminItem(ADMIN_EMAIL), PROJECT_ID, ADMIN_EMAIL),
  true
);
assert.strictEqual(
  isActiveRegularMemberItem(adminItem(ADMIN_EMAIL), PROJECT_ID, ADMIN_EMAIL),
  false,
  "Project Admin item is not regular membership"
);
assert.strictEqual(
  isActiveRegularMemberItem(memberItem(EMP_EMAIL), PROJECT_ID, EMP_EMAIL),
  true
);
assert.strictEqual(
  isActiveProjectAdminItem(memberItem(EMP_EMAIL), PROJECT_ID, EMP_EMAIL),
  false,
  "regular membership is not Project Admin"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: SUPER_EMAIL,
    regularMemberItem: null,
    projectAdminItem: null,
  }),
  false,
  "restricted: createdBy alone"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: ADMIN_EMAIL,
    regularMemberItem: null,
    projectAdminItem: null,
  }),
  false,
  "restricted: lead alone"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: EMP_EMAIL,
    regularMemberItem: null,
    projectAdminItem: null,
  }),
  false,
  "restricted: legacy members[] alone"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: MGR_EMAIL,
    isAdmin: true,
    regularMemberItem: null,
    projectAdminItem: null,
  }),
  false,
  "restricted: Cognito isAdmin alone"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: { projectId: PROJECT_ID },
    email: EMP_EMAIL,
    regularMemberItem: memberItem(EMP_EMAIL),
  }),
  false,
  "OPEN project is not granted via restricted-access helper"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: EMP_EMAIL,
    regularMemberItem: memberItem(EMP_EMAIL, "REVOKED"),
  }),
  false,
  "revoked regular member"
);

assert.strictEqual(
  isActiveRegularMemberItem(memberItem(EMP_EMAIL, "ACTIVE", "user"), PROJECT_ID, EMP_EMAIL),
  true,
  "user-side MEMBER copy is valid"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: ADMIN_EMAIL,
    regularMemberItem: null,
    projectAdminItem: adminItem(ADMIN_EMAIL, "ACTIVE", "user"),
  }),
  true,
  "restricted: user-side PROJECT_ADMIN"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: ADMIN_EMAIL,
    projectAdminItem: adminItem(ADMIN_EMAIL, "REVOKED"),
  }),
  false,
  "revoked Project Admin"
);
{
  const missingStatusAdmin = adminItem(ADMIN_EMAIL);
  delete missingStatusAdmin.status;
  assert.strictEqual(
    isActiveProjectAdminItem(missingStatusAdmin, PROJECT_ID, ADMIN_EMAIL),
    false,
    "Project Admin missing status"
  );
}
assert.strictEqual(
  isActiveProjectAdminItem(adminItem(ADMIN_EMAIL, "BLOCKED"), PROJECT_ID, ADMIN_EMAIL),
  false,
  "Project Admin BLOCKED"
);
assert.strictEqual(
  isActiveProjectAdminItem(adminItem(ADMIN_EMAIL), PROJECT_ID, EMP_EMAIL),
  false,
  "Project Admin wrong email"
);
assert.strictEqual(
  isActiveProjectAdminItem(adminItem(ADMIN_EMAIL, "ACTIVE", "project", OTHER_PROJECT), PROJECT_ID, ADMIN_EMAIL),
  false,
  "Project Admin wrong project"
);
assert.strictEqual(
  isActiveProjectAdminItem(
    {
      PK: "PROJECT#proj-1",
      SK: "TASK#not-an-admin",
      type: "PROJECT_ADMIN",
      status: "ACTIVE",
      projectId: PROJECT_ID,
      email: ADMIN_EMAIL,
    },
    PROJECT_ID,
    ADMIN_EMAIL
  ),
  false,
  "Project Admin mismatched PK/SK"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: EMP_EMAIL,
    regularMemberItem: memberItem(EMP_EMAIL, "ACTIVE", "user"),
  }),
  true,
  "restricted: user-side PROJECT_MEMBER"
);
assert.strictEqual(
  isActiveRegularMemberItem(memberItem(EMP_EMAIL, "BLOCKED"), PROJECT_ID, EMP_EMAIL),
  false,
  "regular member BLOCKED"
);
{
  const missingStatusMember = memberItem(EMP_EMAIL);
  delete missingStatusMember.status;
  assert.strictEqual(
    isActiveRegularMemberItem(missingStatusMember, PROJECT_ID, EMP_EMAIL),
    false,
    "regular member missing status"
  );
}
assert.strictEqual(
  isActiveRegularMemberItem(memberItem(EMP_EMAIL), PROJECT_ID, ADMIN_EMAIL),
  false,
  "regular member wrong email"
);
assert.strictEqual(
  isActiveRegularMemberItem(memberItem(EMP_EMAIL, "ACTIVE", "project", OTHER_PROJECT), PROJECT_ID, EMP_EMAIL),
  false,
  "regular member wrong project"
);
assert.strictEqual(
  isActiveRegularMemberItem(
    {
      PK: "PROJECT#proj-1",
      SK: "TASK#not-a-member",
      type: "PROJECT_MEMBER",
      status: "ACTIVE",
      projectId: PROJECT_ID,
      email: EMP_EMAIL,
    },
    PROJECT_ID,
    EMP_EMAIL
  ),
  false,
  "regular member mismatched PK/SK"
);

assert.strictEqual(
  projectAdminTaskVisibility({}),
  VISIBILITY_ALL_PROJECT_TASKS,
  "missing taskVisibility uses create-time default"
);
assert.strictEqual(
  projectAdminTaskVisibility({ taskVisibility: null }),
  VISIBILITY_ALL_PROJECT_TASKS
);
assert.strictEqual(
  projectAdminTaskVisibility({ taskVisibility: "   " }),
  VISIBILITY_ALL_PROJECT_TASKS
);
assert.strictEqual(
  projectAdminTaskVisibility({ taskVisibility: "ASSIGNED_ONLY" }),
  VISIBILITY_ASSIGNED_ONLY
);
assert.strictEqual(
  projectAdminTaskVisibility({ taskVisibility: "assigned_only" }),
  VISIBILITY_ASSIGNED_ONLY
);
assert.strictEqual(
  projectAdminTaskVisibility({ taskVisibility: "ALL_PROJECT_TASKS" }),
  VISIBILITY_ALL_PROJECT_TASKS
);
assert.strictEqual(
  projectAdminTaskVisibility({ taskVisibility: "all_project_tasks" }),
  VISIBILITY_ALL_PROJECT_TASKS
);
assert.strictEqual(
  projectAdminTaskVisibility({ taskVisibility: "NOPE" }),
  VISIBILITY_ASSIGNED_ONLY,
  "invalid stored taskVisibility fails closed"
);

assert.strictEqual(
  canAccessRestrictedProject({
    project: restrictedProject,
    email: "",
    regularMemberItem: memberItem(EMP_EMAIL),
  }),
  false,
  "empty email rejected"
);
assert.strictEqual(
  canAccessRestrictedProject({
    project: { ...restrictedProject, projectId: "" },
    email: EMP_EMAIL,
    regularMemberItem: memberItem(EMP_EMAIL),
  }),
  false,
  "empty projectId rejected"
);
assert.strictEqual(isActiveRegularMemberItem(memberItem(EMP_EMAIL), "", EMP_EMAIL), false);
assert.strictEqual(isActiveProjectAdminItem(adminItem(ADMIN_EMAIL), PROJECT_ID, "  "), false);

assert.strictEqual(
  isActiveRegularMemberItem(
    {
      ...memberItem(EMP_EMAIL),
      type: "WRONG_TYPE",
    },
    PROJECT_ID,
    EMP_EMAIL
  ),
  true,
  "PK/SK are authoritative; type is not required"
);
assert.strictEqual(
  isActiveRegularMemberItem(
    {
      PK: "PROJECT#forged",
      SK: "MEMBER#forged@mydgv.com",
      type: "PROJECT_MEMBER",
      status: "ACTIVE",
      projectId: PROJECT_ID,
      email: EMP_EMAIL,
    },
    PROJECT_ID,
    EMP_EMAIL
  ),
  false,
  "claimed email/projectId attributes are not trusted without matching keys"
);

console.log("project access helper tests passed");

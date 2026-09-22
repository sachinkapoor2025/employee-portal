/**
 * Project ACL helpers (WorkTasks). Not wired to HTTP in Stage 2A.
 * Policy: docs/architecture/15-project-acl-stage1-plan.md
 */
const { isAdminOrSuperAdminRole } = require("../common/roles");
const { normalizeEmail } = require("./escalation");

const ACCESS_OPEN = "OPEN";
const ACCESS_RESTRICTED = "RESTRICTED";
const STATUS_ACTIVE = "ACTIVE";
const VISIBILITY_ASSIGNED_ONLY = "ASSIGNED_ONLY";
const VISIBILITY_ALL_PROJECT_TASKS = "ALL_PROJECT_TASKS";
const DELETION_DELETING = "DELETING";
const DELETION_DELETED = "DELETED";

function trimId(value) {
  return String(value || "").trim();
}

function isActiveAccessStatus(status) {
  return String(status || "").toUpperCase() === STATUS_ACTIVE;
}

/**
 * Missing, blank, null, or invalid accessMode is OPEN (legacy compatibility).
 * Does not mutate `project`.
 */
function projectAccessMode(project) {
  const raw = String(project == null ? "" : project.accessMode ?? "")
    .trim()
    .toUpperCase();
  if (raw === ACCESS_RESTRICTED) return ACCESS_RESTRICTED;
  return ACCESS_OPEN;
}

function isRestrictedProject(project) {
  return projectAccessMode(project) === ACCESS_RESTRICTED;
}

function isProjectDeleting(project) {
  if (!project) return false;
  const raw = String(project.deletionStatus || "").trim().toUpperCase();
  return raw === DELETION_DELETING || raw === DELETION_DELETED;
}

/**
 * Catalog item is present and not in deletion. Missing/null project is not
 * OPEN: callers must treat `project === null` as missing, not as {}.
 */
function isUsableProject(project) {
  return Boolean(project && trimId(project.projectId) && !isProjectDeleting(project));
}

function projectMemberKeys(projectId, email) {
  const id = trimId(projectId);
  const e = normalizeEmail(email);
  return {
    projectSide: { PK: `PROJECT#${id}`, SK: `MEMBER#${e}` },
    userSide: { PK: `USER#${e}`, SK: `PROJECT_MEMBER#${id}` },
  };
}

function projectAdminKeys(projectId, email) {
  const id = trimId(projectId);
  const e = normalizeEmail(email);
  return {
    projectSide: { PK: `PROJECT#${id}`, SK: `PROJECT_ADMIN#${e}` },
    userSide: { PK: `USER#${e}`, SK: `PROJECT_ADMIN#${id}` },
  };
}

/**
 * PK/SK are authoritative. `type` is not required (Stage 1 items include type,
 * but uniqueness is PK+SK). Stage 2C must GetItem using server-computed keys;
 * never trust client-supplied PK/SK.
 */
function itemMatchesKeys(item, keys) {
  if (!item || !keys) return false;
  const pk = String(item.PK || "");
  const sk = String(item.SK || "");
  return (
    (pk === keys.projectSide.PK && sk === keys.projectSide.SK) ||
    (pk === keys.userSide.PK && sk === keys.userSide.SK)
  );
}

function hasIdentity(projectId, email) {
  return Boolean(trimId(projectId) && normalizeEmail(email));
}

function isActiveRegularMemberItem(item, projectId, email) {
  if (!hasIdentity(projectId, email)) return false;
  if (!isActiveAccessStatus(item?.status)) return false;
  return itemMatchesKeys(item, projectMemberKeys(projectId, email));
}

function isActiveProjectAdminItem(item, projectId, email) {
  if (!hasIdentity(projectId, email)) return false;
  if (!isActiveAccessStatus(item?.status)) return false;
  return itemMatchesKeys(item, projectAdminKeys(projectId, email));
}

/**
 * Eligibility to be *assigned* as Project Admin (UserAccess), not assignment itself.
 * Cognito isAdmin is ignored.
 */
function isEligibleProjectAdmin(accessRow) {
  if (!accessRow || !isActiveAccessStatus(accessRow.status)) return false;
  return isAdminOrSuperAdminRole(accessRow.role);
}

/**
 * Stage 1: supported enums ASSIGNED_ONLY | ALL_PROJECT_TASKS.
 * Create-time default for a new Project Admin is ALL_PROJECT_TASKS.
 * Stage 1 does not define invalid stored values. Missing/blank uses the
 * create-time default. Non-empty invalid values fail closed to ASSIGNED_ONLY
 * so a corrupt item cannot silently widen task access.
 */
function projectAdminTaskVisibility(item) {
  const present = item == null ? undefined : item.taskVisibility;
  if (present == null || String(present).trim() === "") {
    return VISIBILITY_ALL_PROJECT_TASKS;
  }
  const raw = String(present).trim().toUpperCase();
  if (raw === VISIBILITY_ASSIGNED_ONLY) return VISIBILITY_ASSIGNED_ONLY;
  if (raw === VISIBILITY_ALL_PROJECT_TASKS) return VISIBILITY_ALL_PROJECT_TASKS;
  return VISIBILITY_ASSIGNED_ONLY;
}

/**
 * RESTRICTED access only. OPEN callers must use existing HTTP rules later.
 * Ignores Cognito isAdmin, createdBy, lead, and legacy members[].
 */
function canAccessRestrictedProject({
  project,
  email,
  regularMemberItem,
  projectAdminItem,
} = {}) {
  if (!isRestrictedProject(project)) return false;
  const id = trimId(project.projectId);
  const e = normalizeEmail(email);
  if (!id || !e) return false;
  if (isActiveRegularMemberItem(regularMemberItem, id, e)) return true;
  if (isActiveProjectAdminItem(projectAdminItem, id, e)) return true;
  return false;
}

module.exports = {
  ACCESS_OPEN,
  ACCESS_RESTRICTED,
  STATUS_ACTIVE,
  VISIBILITY_ASSIGNED_ONLY,
  VISIBILITY_ALL_PROJECT_TASKS,
  DELETION_DELETING,
  DELETION_DELETED,
  projectAccessMode,
  isRestrictedProject,
  isProjectDeleting,
  isUsableProject,
  normalizeEmail,
  projectMemberKeys,
  projectAdminKeys,
  isActiveRegularMemberItem,
  isActiveProjectAdminItem,
  isEligibleProjectAdmin,
  projectAdminTaskVisibility,
  canAccessRestrictedProject,
};

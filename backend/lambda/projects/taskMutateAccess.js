/**
 * Task mutation authorization (create/update/archive/comment).
 * OPEN: ACTIVE UserAccess ADMIN/SUPER_ADMIN or assignee.
 * RESTRICTED uses stored ACL (Project Admin / member).
 * Create persistence must go through putCreatedTaskRecords so the catalog
 * is ConditionChecked (not deleting, no deletion lock) in the same transaction.
 */
const escalation = require("./escalation");
const {
  isRestrictedProject,
  canAccessRestrictedProject,
  isActiveProjectAdminItem,
  isActiveRegularMemberItem,
  isUsableProject,
  isEligibleProjectAdmin,
  normalizeEmail,
} = require("./projectAccess");
const { getProjectMemberRecord } = require("./projectAccessPersist");
const {
  createCache,
  decideTaskRead,
  loadProjectAclContext,
} = require("./taskReadAccess");

const CODE_ASSIGNEE_NOT_MEMBER = "ASSIGNEE_NOT_MEMBER";
const ASSIGNEE_ONLY_FIELDS = new Set(["status", "assignmentEmail"]);

function accessActive(accessRow) {
  return String(accessRow?.status || "").toUpperCase() === "ACTIVE";
}

function restrictedCallerOk({
  user,
  project,
  regularMemberItem,
  projectAdminItem,
  accessRow,
}) {
  const email = normalizeEmail(user?.email);
  if (!email) return { allowed: false, projectAdmin: false, member: false };
  if (!accessActive(accessRow)) {
    return { allowed: false, projectAdmin: false, member: false };
  }
  const projectId = String(project?.projectId || "").trim();
  if (
    !canAccessRestrictedProject({
      project,
      email,
      regularMemberItem,
      projectAdminItem,
    })
  ) {
    return { allowed: false, projectAdmin: false, member: false };
  }
  return {
    allowed: true,
    projectAdmin: isActiveProjectAdminItem(projectAdminItem, projectId, email),
    member: isActiveRegularMemberItem(regularMemberItem, projectId, email),
  };
}

function decideTaskCreate({ user, project, projectAdminItem, accessRow } = {}) {
  const email = normalizeEmail(user?.email);
  if (!email) return { ok: true, allowed: false };
  if (!isUsableProject(project)) return { ok: true, allowed: false };

  if (!isRestrictedProject(project)) {
    return { ok: true, allowed: isEligibleProjectAdmin(accessRow) };
  }

  const gate = restrictedCallerOk({
    user,
    project,
    regularMemberItem: null,
    projectAdminItem,
    accessRow,
  });
  if (!gate.allowed || !gate.projectAdmin) {
    return { ok: true, allowed: false };
  }
  return { ok: true, allowed: true };
}

function decideTaskDelete({ user, project, projectAdminItem, accessRow } = {}) {
  return decideTaskCreate({ user, project, projectAdminItem, accessRow });
}

function decideTaskUpdate({
  user,
  task,
  project,
  regularMemberItem,
  projectAdminItem,
  accessRow,
} = {}) {
  const email = normalizeEmail(user?.email);
  if (!email) return { ok: true, allowed: false, mayAdminMutate: false };

  const assigned = escalation.taskAssignedTo(task, email);

  if (!isUsableProject(project)) {
    return { ok: true, allowed: false, mayAdminMutate: false };
  }

  if (!isRestrictedProject(project)) {
    if (isEligibleProjectAdmin(accessRow)) {
      return { ok: true, allowed: true, mayAdminMutate: true };
    }
    return { ok: true, allowed: assigned, mayAdminMutate: false };
  }

  const gate = restrictedCallerOk({
    user,
    project,
    regularMemberItem,
    projectAdminItem,
    accessRow,
  });
  if (!gate.allowed) {
    return { ok: true, allowed: false, mayAdminMutate: false };
  }
  if (gate.projectAdmin) {
    return { ok: true, allowed: true, mayAdminMutate: true };
  }
  return { ok: true, allowed: assigned, mayAdminMutate: false };
}

function decideCommentCreate(args) {
  const decision = decideTaskRead(args);
  return { ok: decision.ok, allowed: decision.allowed };
}

function isAssigneeOnlyUpdate(updates) {
  if (!updates || typeof updates !== "object") return true;
  return Object.keys(updates).every(
    (key) => updates[key] === undefined || ASSIGNEE_ONLY_FIELDS.has(key)
  );
}

async function authorizeWithProject({
  ddb,
  tableName,
  accessTable,
  user,
  projectId,
  task,
  cache,
  decide,
}) {
  const email = normalizeEmail(user?.email);
  if (!email) return { ok: true, allowed: false, mayAdminMutate: false };
  const loaded = await loadProjectAclContext({
    ddb,
    tableName,
    accessTable,
    email,
    projectId,
    cache: cache || createCache(),
  });
  if (!loaded.ok) return loaded;
  return {
    ...decide({
      user,
      task,
      project: loaded.project,
      regularMemberItem: loaded.regularMemberItem,
      projectAdminItem: loaded.projectAdminItem,
      accessRow: loaded.accessRow,
    }),
    project: loaded.project,
  };
}

async function authorizeTaskCreate(args) {
  return authorizeWithProject({
    ...args,
    projectId: args.projectId,
    decide: decideTaskCreate,
  });
}

async function authorizeTaskDelete(args) {
  return authorizeWithProject({
    ...args,
    projectId: String(args.task?.projectId || "").trim(),
    decide: decideTaskDelete,
  });
}

async function authorizeTaskUpdate(args) {
  return authorizeWithProject({
    ...args,
    projectId: String(args.task?.projectId || "").trim(),
    decide: decideTaskUpdate,
  });
}

async function authorizeCommentCreate(args) {
  return authorizeWithProject({
    ...args,
    projectId: String(args.task?.projectId || "").trim(),
    decide: (loaded) => decideCommentCreate(loaded),
  });
}

async function assertRestrictedAssigneesAreMembers({
  ddb,
  tableName,
  project,
  emails,
} = {}) {
  if (!isRestrictedProject(project)) return { ok: true, allowed: true };
  const projectId = String(project.projectId || "").trim();
  if (!projectId) return { ok: true, allowed: false, code: CODE_ASSIGNEE_NOT_MEMBER };
  for (const raw of emails || []) {
    const email = normalizeEmail(raw);
    if (!email) {
      return { ok: true, allowed: false, code: CODE_ASSIGNEE_NOT_MEMBER };
    }
    const rec = await getProjectMemberRecord(ddb, tableName, projectId, email);
    if (!rec.ok) return rec;
    if (!isActiveRegularMemberItem(rec.item, projectId, email)) {
      return { ok: true, allowed: false, code: CODE_ASSIGNEE_NOT_MEMBER };
    }
  }
  return { ok: true, allowed: true };
}

module.exports = {
  CODE_ASSIGNEE_NOT_MEMBER,
  decideTaskCreate,
  decideTaskDelete,
  decideTaskUpdate,
  decideCommentCreate,
  isAssigneeOnlyUpdate,
  authorizeTaskCreate,
  authorizeTaskDelete,
  authorizeTaskUpdate,
  authorizeCommentCreate,
  assertRestrictedAssigneesAreMembers,
};

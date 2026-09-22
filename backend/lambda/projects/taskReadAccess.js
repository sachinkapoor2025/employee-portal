/**
 * Task READ authorization. OPEN: ACTIVE UserAccess ADMIN/SUPER_ADMIN or assignee.
 * RESTRICTED requires active membership or Project Admin, then visibility.
 */
const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const escalation = require("./escalation");
const { getProject, isSafeTaskAttachmentKey } = require("./projectManage");
const {
  isRestrictedProject,
  canAccessRestrictedProject,
  isActiveProjectAdminItem,
  isActiveRegularMemberItem,
  projectAdminTaskVisibility,
  VISIBILITY_ALL_PROJECT_TASKS,
  isProjectDeleting,
  isUsableProject,
  isEligibleProjectAdmin,
  normalizeEmail,
} = require("./projectAccess");
const {
  getProjectMemberRecord,
  getProjectAdminRecord,
  REASON_DDB_ERROR,
} = require("./projectAccessPersist");

function createCache() {
  return { projects: Object.create(null), accessRow: undefined, accessLoaded: false };
}

function decideTaskRead({
  user,
  task,
  project,
  regularMemberItem,
  projectAdminItem,
  accessRow,
} = {}) {
  const email = normalizeEmail(user?.email);
  if (!email) return { ok: true, allowed: false };

  if (!isUsableProject(project)) return { ok: true, allowed: false };

  if (!isRestrictedProject(project)) {
    if (isEligibleProjectAdmin(accessRow)) return { ok: true, allowed: true };
    return { ok: true, allowed: escalation.taskAssignedTo(task, email) };
  }

  const accessActive = String(accessRow?.status || "").toUpperCase() === "ACTIVE";
  if (!accessActive) return { ok: true, allowed: false };

  const projectId = String(project.projectId || "").trim();
  if (
    !canAccessRestrictedProject({
      project,
      email,
      regularMemberItem,
      projectAdminItem,
    })
  ) {
    return { ok: true, allowed: false };
  }

  const admin = isActiveProjectAdminItem(projectAdminItem, projectId, email);
  const member = isActiveRegularMemberItem(regularMemberItem, projectId, email);
  const assigned = escalation.taskAssignedTo(task, email);
  if (admin) {
    const vis = projectAdminTaskVisibility(projectAdminItem);
    if (vis === VISIBILITY_ALL_PROJECT_TASKS) return { ok: true, allowed: true };
    return { ok: true, allowed: assigned };
  }
  if (member) return { ok: true, allowed: assigned };
  return { ok: true, allowed: false };
}

async function loadAccessRow(ddb, accessTable, email, cache) {
  if (cache.accessLoaded) return { ok: true, item: cache.accessRow };
  if (!accessTable) {
    cache.accessLoaded = true;
    cache.accessRow = null;
    return { ok: true, item: null };
  }
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: accessTable,
        Key: { PK: email, SK: email },
      })
    );
    cache.accessRow = res.Item || null;
    cache.accessLoaded = true;
    return { ok: true, item: cache.accessRow };
  } catch (err) {
    return { ok: false, reason: REASON_DDB_ERROR };
  }
}

async function loadProjectAclContext({
  ddb,
  tableName,
  accessTable,
  email,
  projectId,
  cache,
} = {}) {
  const store = cache || createCache();
  const id = String(projectId || "").trim();
  if (!id) {
    return {
      ok: true,
      project: null,
      regularMemberItem: null,
      projectAdminItem: null,
      accessRow: store.accessRow || null,
    };
  }
  if (!store.projects[id]) {
    if (!ddb || !tableName) {
      return { ok: false, reason: REASON_DDB_ERROR };
    }
    try {
      const found = await getProject(ddb, tableName, id);
      const project = isProjectDeleting(found) ? null : found || null;
      let regularMemberItem = null;
      let projectAdminItem = null;
      if (project) {
        const access = await loadAccessRow(ddb, accessTable, email, store);
        if (!access.ok) return access;
        if (isRestrictedProject(project)) {
          const member = await getProjectMemberRecord(ddb, tableName, id, email);
          if (!member.ok) return member;
          const admin = await getProjectAdminRecord(ddb, tableName, id, email);
          if (!admin.ok) return admin;
          regularMemberItem = member.item;
          projectAdminItem = admin.item;
        }
      }
      store.projects[id] = {
        project,
        regularMemberItem,
        projectAdminItem,
      };
    } catch (err) {
      return { ok: false, reason: REASON_DDB_ERROR };
    }
  }

  const loaded = store.projects[id];
  let accessRow = store.accessRow;
  if (loaded.project && !store.accessLoaded) {
    const access = await loadAccessRow(ddb, accessTable, email, store);
    if (!access.ok) return access;
    accessRow = access.item;
  }
  return {
    ok: true,
    project: loaded.project,
    regularMemberItem: loaded.regularMemberItem,
    projectAdminItem: loaded.projectAdminItem,
    accessRow: accessRow || null,
  };
}

async function authorizeTaskRead({
  ddb,
  tableName,
  accessTable,
  user,
  task,
  cache,
} = {}) {
  const store = cache || createCache();
  const email = normalizeEmail(user?.email);
  if (!email) return { ok: true, allowed: false };
  const projectId = String(task?.projectId || "").trim();
  const loaded = await loadProjectAclContext({
    ddb,
    tableName,
    accessTable,
    email,
    projectId,
    cache: store,
  });
  if (!loaded.ok) return loaded;
  return decideTaskRead({
    user,
    task,
    project: loaded.project,
    regularMemberItem: loaded.regularMemberItem,
    projectAdminItem: loaded.projectAdminItem,
    accessRow: loaded.accessRow,
  });
}

async function filterVisibleTasks({
  ddb,
  tableName,
  accessTable,
  user,
  tasks,
  cache,
} = {}) {
  const store = cache || createCache();
  const visible = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const decision = await authorizeTaskRead({
      ddb,
      tableName,
      accessTable,
      user,
      task,
      cache: store,
    });
    if (!decision.ok) return { ok: false, reason: decision.reason };
    if (decision.allowed) visible.push(task);
  }
  return { ok: true, tasks: visible };
}

function isOwnProfileObjectKey(objectKey, email) {
  const e = normalizeEmail(email);
  if (!e) return false;
  const key = String(objectKey || "").replace(/^\/+/, "");
  if (key.includes("..") || key.includes("\\") || key.includes("\0")) return false;
  const prefix = `profiles/${e}/`;
  return key.startsWith(prefix) && key.length > prefix.length;
}

async function authorizeAttachmentDownload({
  ddb,
  tableName,
  accessTable,
  user,
  task,
  taskId,
  objectKey,
  cache,
} = {}) {
  if (isOwnProfileObjectKey(objectKey, user?.email)) {
    return { ok: true, allowed: true };
  }
  if (!task) return { ok: true, allowed: false };
  const view = await authorizeTaskRead({
    ddb,
    tableName,
    accessTable,
    user,
    task,
    cache,
  });
  if (!view.ok || !view.allowed) return view;
  const id = String(task.taskId || taskId || "").trim();
  if (!isSafeTaskAttachmentKey(objectKey, id)) {
    return { ok: true, allowed: false };
  }
  return { ok: true, allowed: true };
}

function canViewTask(user, task, context) {
  if (!context || !Object.prototype.hasOwnProperty.call(context, "project")) {
    return false;
  }
  return decideTaskRead({
    user,
    task,
    project: context.project,
    regularMemberItem: context.regularMemberItem,
    projectAdminItem: context.projectAdminItem,
    accessRow: context.accessRow,
  }).allowed;
}

module.exports = {
  createCache,
  decideTaskRead,
  loadProjectAclContext,
  authorizeTaskRead,
  filterVisibleTasks,
  authorizeAttachmentDownload,
  isOwnProfileObjectKey,
  canViewTask,
};

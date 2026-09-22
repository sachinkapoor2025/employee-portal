/**
 * ACL for import, scheduled assignment, and related workflow side effects.
 * OPEN import/create uses ACTIVE UserAccess ADMIN/SUPER_ADMIN.
 * RESTRICTED uses stored project + Project Admin.
 */
const { QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { requireEligiblePortalAdmin } = require("./portalAdminAuth");
const {
  isRestrictedProject,
  isActiveProjectAdminItem,
  isActiveRegularMemberItem,
  isProjectDeleting,
  normalizeEmail,
} = require("./projectAccess");
const { getProjectMemberRecord, REASON_DDB_ERROR } = require("./projectAccessPersist");
const { getProject, listActiveProjects, isActiveProject } = require("./projectManage");
const {
  createCache,
  loadProjectAclContext,
  authorizeTaskRead,
} = require("./taskReadAccess");
const {
  decideTaskCreate,
  authorizeTaskCreate,
  assertRestrictedAssigneesAreMembers,
  CODE_ASSIGNEE_NOT_MEMBER,
} = require("./taskMutateAccess");

function projectIdOf(item) {
  return String(item?.projectId || "").trim() ||
    String(item?.SK || "").replace(/^PROJECT#/, "").trim();
}

async function listImportableProjects({
  ddb,
  tableName,
  accessTable,
  user,
  cache,
} = {}) {
  const email = normalizeEmail(user?.email);
  if (!email) return { ok: true, projects: [] };
  let items;
  try {
    items = await listActiveProjects(ddb, tableName);
  } catch (err) {
    return { ok: false, reason: REASON_DDB_ERROR };
  }
  const store = cache || createCache();
  const projects = [];
  for (const item of items || []) {
    if (!isActiveProject(item)) continue;
    const projectId = projectIdOf(item);
    if (!projectId) continue;
    const loaded = await loadProjectAclContext({
      ddb,
      tableName,
      accessTable,
      email,
      projectId,
      cache: store,
    });
    if (!loaded.ok) return loaded;
    const allowed = decideTaskCreate({
      user,
      project: loaded.project,
      projectAdminItem: loaded.projectAdminItem,
      accessRow: loaded.accessRow,
    }).allowed;
    if (!allowed) continue;
    projects.push({
      projectId,
      name: String(item.name || "").trim(),
    });
  }
  return { ok: true, projects };
}

async function applyImportAclToRows(rows, {
  ddb,
  tableName,
  accessTable,
  user,
  cache,
} = {}) {
  const store = cache || createCache();
  const next = [];
  for (const row of rows || []) {
    const projectId = String(row.projectId || row.values?.projectId || "").trim();
    if (!projectId) {
      const errors = [...(row.errors || [])];
      if (!errors.some((item) => item && item.field === "project")) {
        errors.push({
          field: "project",
          message:
            "Project does not exist. Create the project first or use an existing project name.",
        });
      }
      next.push({
        ...row,
        errors,
        status: "INVALID",
        projectId: null,
        projectName: null,
        values: { ...(row.values || {}), projectId: null },
      });
      continue;
    }
    const create = await authorizeTaskCreate({
      ddb,
      tableName,
      accessTable,
      user,
      projectId,
      cache: store,
    });
    if (!create.ok) return { ok: false, reason: create.reason };
    const errors = [...(row.errors || [])];
    if (!create.allowed) {
      errors.push({
        field: "project",
        message:
          "Project does not exist. Create the project first or use an existing project name.",
      });
      next.push({
        ...row,
        errors,
        status: "INVALID",
        projectId: null,
        projectName: null,
        values: { ...(row.values || {}), projectId: null },
      });
      continue;
    }
    const emails = (row.resolvedAssignees || []).map((item) => item.email);
    const members = await assertRestrictedAssigneesAreMembers({
      ddb,
      tableName,
      project: create.project,
      emails,
    });
    if (!members.ok) return members;
    if (!members.allowed) {
      for (const email of emails) {
        errors.push({
          field: "assigneeEmail",
          message: `Assignee ${email} is not an active project member.`,
          value: email,
        });
      }
      next.push({
        ...row,
        errors,
        status: "INVALID",
      });
      continue;
    }
    next.push(row);
  }
  return { ok: true, rows: next };
}

async function authorizeImportRowCreate({
  ddb,
  tableName,
  accessTable,
  user,
  projectId,
  emails,
  cache,
} = {}) {
  const create = await authorizeTaskCreate({
    ddb,
    tableName,
    accessTable,
    user,
    projectId,
    cache: cache || createCache(),
  });
  if (!create.ok) return create;
  if (!create.allowed) return { ok: true, allowed: false, project: create.project };
  const members = await assertRestrictedAssigneesAreMembers({
    ddb,
    tableName,
    project: create.project,
    emails,
  });
  if (!members.ok) return members;
  if (!members.allowed) {
    return {
      ok: true,
      allowed: false,
      code: CODE_ASSIGNEE_NOT_MEMBER,
      project: create.project,
    };
  }
  return { ok: true, allowed: true, project: create.project };
}

async function filterScheduledAssignees({
  ddb,
  tableName,
  task,
  emails,
} = {}) {
  const projectId = String(task?.projectId || "").trim();
  const list = (emails || []).map((email) => normalizeEmail(email)).filter(Boolean);
  if (!projectId) {
    return { ok: true, active: [], skipped: list, reason: "PROJECT_MISSING" };
  }
  let project;
  try {
    project = await getProject(ddb, tableName, projectId);
  } catch (err) {
    return { ok: false, reason: REASON_DDB_ERROR };
  }
  if (!project || isProjectDeleting(project)) {
    return { ok: true, active: [], skipped: list, reason: "PROJECT_MISSING" };
  }
  if (!isRestrictedProject(project)) {
    return { ok: true, active: list, skipped: [] };
  }
  const active = [];
  const skipped = [];
  for (const email of list) {
    const rec = await getProjectMemberRecord(ddb, tableName, projectId, email);
    if (!rec.ok) return rec;
    if (isActiveRegularMemberItem(rec.item, projectId, email)) active.push(email);
    else skipped.push(email);
  }
  return { ok: true, active, skipped, reason: "NOT_PROJECT_MEMBER" };
}

async function listActiveProjectAdminEmails(ddb, tableName, projectId) {
  const id = String(projectId || "").trim();
  if (!ddb || !tableName || !id) return { ok: true, emails: [] };
  try {
    const items = [];
    let lastKey;
    do {
      const res = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: {
            ":pk": `PROJECT#${id}`,
            ":sk": "PROJECT_ADMIN#",
          },
          ExclusiveStartKey: lastKey,
        })
      );
      items.push(...(res.Items || []));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    const emails = [];
    for (const item of items) {
      const email = normalizeEmail(item.email);
      if (isActiveProjectAdminItem(item, id, email)) emails.push(email);
    }
    return { ok: true, emails: [...new Set(emails)] };
  } catch (err) {
    return { ok: false, reason: REASON_DDB_ERROR };
  }
}

async function adminNotifyRecipientsForTask({
  ddb,
  tableName,
  projectId,
  fallbackEmails,
} = {}) {
  const id = String(projectId || "").trim();
  if (!id) return { ok: true, emails: [] };
  let project;
  try {
    project = await getProject(ddb, tableName, id);
  } catch (err) {
    return { ok: false, reason: REASON_DDB_ERROR };
  }
  if (!project || isProjectDeleting(project)) {
    return { ok: true, emails: [] };
  }
  if (!isRestrictedProject(project)) {
    return { ok: true, emails: fallbackEmails || [] };
  }
  return listActiveProjectAdminEmails(ddb, tableName, id);
}

async function resolveTimeEntryQueryEmail({
  user,
  requestedEmail,
  ddb,
  accessTable,
} = {}) {
  const self = normalizeEmail(user?.email);
  if (!self) {
    return { statusCode: 401, body: { error: "Unauthorized" } };
  }
  const requested = normalizeEmail(requestedEmail);
  if (!requested || requested === self) {
    return { ok: true, email: self };
  }
  const gate = await requireEligiblePortalAdmin({ user, ddb, accessTable });
  if (!gate.ok) {
    return { statusCode: gate.statusCode, body: gate.body };
  }
  return { ok: true, email: requested };
}

function importRowProjectId(row) {
  return String(row?.projectId || row?.values?.projectId || "").trim();
}

async function authorizeImportOperator({ user, ddb, accessTable } = {}) {
  return requireEligiblePortalAdmin({ user, ddb, accessTable });
}

async function authorizeImportBatchView({
  user,
  ddb,
  tableName,
  accessTable,
  rows,
  meta,
  cache,
} = {}) {
  const gate = await requireEligiblePortalAdmin({ user, ddb, accessTable });
  if (!gate.ok) return gate;
  const actor = normalizeEmail(user?.email);
  const owner = normalizeEmail(meta?.uploadedBy);
  const rowList = Array.isArray(rows) ? rows : [];
  // Unpreviewed / empty-row batches are owner-only. Do not treat missing
  // project IDs as OPEN. Completed batches with zero rows stay fail-closed
  // for non-owners.
  if (!rowList.length) {
    return { ok: true, allowed: Boolean(actor && owner && actor === owner) };
  }
  const ids = [
    ...new Set(rowList.map(importRowProjectId).filter(Boolean)),
  ];
  const store = cache || createCache();
  for (const projectId of ids) {
    const created = await authorizeTaskCreate({
      ddb,
      tableName,
      accessTable,
      user,
      projectId,
      cache: store,
    });
    if (!created.ok) return created;
    if (!created.allowed) {
      return { ok: true, allowed: false };
    }
  }
  return { ok: true, allowed: true };
}

async function authorizeTimeEntryAccess({
  ddb,
  tableName,
  accessTable,
  user,
  task,
  cache,
} = {}) {
  return authorizeTaskRead({
    ddb,
    tableName,
    accessTable,
    user,
    task,
    cache: cache || createCache(),
  });
}

module.exports = {
  listImportableProjects,
  applyImportAclToRows,
  authorizeImportRowCreate,
  filterScheduledAssignees,
  listActiveProjectAdminEmails,
  adminNotifyRecipientsForTask,
  authorizeTimeEntryAccess,
  resolveTimeEntryQueryEmail,
  authorizeImportOperator,
  authorizeImportBatchView,
};

const {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { randomUUID } = require("crypto");
const { isEligibleProjectAdmin, ACCESS_OPEN, ACCESS_RESTRICTED, normalizeEmail, isRestrictedProject, isActiveRegularMemberItem, isActiveProjectAdminItem, isProjectDeleting } = require("./projectAccess");
const { requireEligiblePortalAdmin } = require("./portalAdminAuth");
const { createRestrictedProject, acquireDeletionLock, releaseDeletionLock, convertLockToDeleting, deleteAllProjectAclRecords, REASON_INVALID_TASK_VISIBILITY, REASON_CONDITION_FAILED, REASON_TX_CONFLICT, REASON_DDB_ERROR, REASON_INVALID_IDENTITY } = require("./projectAccessPersist");

const PROJECT_ENTITY_PK = "ENTITY#PROJECT";
const TASK_ENTITY_PK = "ENTITY#TASK";
const STATUS_ACTIVE = "ACTIVE";
const STATUS_ARCHIVED = "ARCHIVED";
const STATUS_ALL = "ALL";
const ACTION_ARCHIVED = "ARCHIVED";
const ACTION_DELETED = "DELETED";
const PROJECT_HAS_TASKS = "PROJECT_HAS_TASKS";
const PROJECT_HAS_TASKS_MESSAGE =
  "This project cannot be permanently deleted because it contains existing tasks or task history. Please archive the project instead.";
const DYNAMO_BATCH_LIMIT = 25;
const S3_DELETE_LIMIT = 1000;
const DELETE_MAX_ATTEMPTS = 5;
const CONFIRM_NAME_REQUIRED = "Project name confirmation is required";
const CONFIRM_NAME_MISMATCH = "Project name confirmation does not match";
const RESTRICTED_CREATE_DISABLED = "Restricted project creation is not enabled";
const RESTRICTED_MEMBERS_REQUIRED = "At least one employee must be selected";
const RESTRICTED_MEMBER_INACTIVE = "Target user is not active";
const RESTRICTED_TOO_MANY_MEMBERS = "Too many members";
const ENV_RESTRICTED_CREATE = "PROJECT_ACL_RESTRICTED_CREATE";
const MAX_RESTRICTED_CREATE_MEMBERS = 40;

function projectSk(projectId) {
  return `PROJECT#${projectId}`;
}

function projectTaskPk(projectId) {
  return `PROJECT#${projectId}`;
}

function canonicalTaskSk(taskId) {
  return `TASK#${taskId}`;
}

function taskChildPk(taskId) {
  return `TASK#${taskId}`;
}

function projectPathMatch(path, pathParameters) {
  const fromParams = pathParameters?.projectId
    ? String(pathParameters.projectId)
    : "";
  const normalized = String(path || "").replace(/\/+$/, "");
  if (/\/documents\/projects(?:\/|$)/.test(normalized)) return null;
  const match = normalized.match(/\/projects\/([^/]+)$/);
  const raw = fromParams || (match ? match[1] : "");
  if (!raw) return null;
  let projectId = raw;
  try {
    projectId = decodeURIComponent(raw);
  } catch {
    projectId = raw;
  }
  projectId = String(projectId).trim();
  if (!projectId) return null;
  return { projectId };
}

function projectStatusOf(item) {
  const status = String(item?.status || STATUS_ACTIVE)
    .trim()
    .toUpperCase();
  return status === STATUS_ARCHIVED ? STATUS_ARCHIVED : STATUS_ACTIVE;
}

function isActiveProject(item) {
  return projectStatusOf(item) === STATUS_ACTIVE && !isProjectDeleting(item);
}

function filterActiveProjects(items) {
  return (items || []).filter(isActiveProject);
}

function countActiveProjects(items) {
  return filterActiveProjects(items).length;
}

function parseListStatus(raw) {
  const value = String(raw || "")
    .trim()
    .toUpperCase();
  if (!value) return STATUS_ACTIVE;
  if (value === STATUS_ALL || value === STATUS_ACTIVE || value === STATUS_ARCHIVED) {
    return value;
  }
  return null;
}

function filterProjectsByStatus(items, statusFilter) {
  const list = items || [];
  if (statusFilter === STATUS_ALL) return list;
  if (statusFilter === STATUS_ARCHIVED) {
    return list.filter((item) => !isActiveProject(item));
  }
  return filterActiveProjects(list);
}

function normalizeProjectName(name) {
  return String(name || "").trim();
}

function namesMatch(a, b) {
  return (
    normalizeProjectName(a).toLowerCase() ===
    normalizeProjectName(b).toLowerCase()
  );
}

function confirmationNameOf(body = {}, query = {}) {
  const raw =
    body.confirmName ??
    body.confirmationName ??
    query.confirmName ??
    query.confirmationName ??
    body.name ??
    query.name ??
    "";
  return normalizeProjectName(raw);
}

function taskIdFromItem(item) {
  const fromField = String(item?.taskId || "").trim();
  if (fromField) return fromField;
  const sk = String(item?.SK || "");
  if (sk.startsWith("TASK#")) return sk.slice("TASK#".length);
  return "";
}

function chunk(items, size) {
  const out = [];
  const limit = Math.max(1, Number(size) || 1);
  for (let i = 0; i < items.length; i += limit) {
    out.push(items.slice(i, i + limit));
  }
  return out;
}

function backoffMs(attempt) {
  return Math.min(400, 25 * 2 ** Math.max(0, attempt - 1));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeS3Key(s3Key) {
  return String(s3Key || "").replace(/^\/+/, "").trim();
}

function isSafeTaskAttachmentKey(s3Key, taskId) {
  const key = normalizeS3Key(s3Key);
  const id = String(taskId || "").trim();
  if (!key || !id) return false;
  if (key.includes("..")) return false;
  if (key.includes("\\")) return false;
  if (key.includes("\0")) return false;
  if (/^[a-zA-Z]:/.test(key)) return false;
  if (key.startsWith("profiles/")) return false;
  if (key.startsWith("task-imports/")) return false;
  const prefix = `tasks/${id}/`;
  if (!key.startsWith(prefix)) return false;
  if (key.length <= prefix.length) return false;
  return true;
}

function isRetryableS3Error(error) {
  const code = String(error?.Code || error?.code || "").toUpperCase();
  return code === "NOSUCHKEY" || code === "NOTFOUND";
}

async function queryAll(ddb, input) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        ...input,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function listAllProjects(ddb, tableName) {
  return queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": PROJECT_ENTITY_PK },
  });
}

async function listActiveProjects(ddb, tableName) {
  const items = await listAllProjects(ddb, tableName);
  return filterActiveProjects(items);
}

function findActiveNameConflict(items, name, exceptProjectId) {
  const needle = normalizeProjectName(name);
  if (!needle) return null;
  return (
    (items || []).find(
      (item) =>
        isActiveProject(item) &&
        item.projectId !== exceptProjectId &&
        namesMatch(item.name, needle)
    ) || null
  );
}

async function getProject(ddb, tableName, projectId) {
  if (!projectId) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: PROJECT_ENTITY_PK, SK: projectSk(projectId) },
    })
  );
  return res.Item || null;
}

async function getProjectName(ddb, tableName, projectId) {
  if (!projectId) return "";
  const item = await getProject(ddb, tableName, projectId);
  return item?.name || "";
}

async function listProjectTaskCopies(ddb, tableName, projectId) {
  return queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": projectTaskPk(projectId),
      ":sk": "TASK#",
    },
  });
}

async function listCanonicalTasksForProject(ddb, tableName, projectId) {
  const items = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": TASK_ENTITY_PK,
      ":sk": "TASK#",
    },
  });
  return (items || []).filter(
    (item) => String(item.projectId || "") === String(projectId)
  );
}

async function listTaskChildren(ddb, tableName, taskId) {
  if (!taskId) return [];
  return queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": taskChildPk(taskId) },
  });
}

async function countProjectTasks(ddb, tableName, projectId) {
  const items = await listProjectTaskCopies(ddb, tableName, projectId);
  return items.length;
}

function collectTaskIds(copies, canonical) {
  const ids = new Set();
  for (const item of [...(copies || []), ...(canonical || [])]) {
    const id = taskIdFromItem(item);
    if (id) ids.add(id);
  }
  return [...ids];
}

function projectOwnedDeleteKeys(projectId, taskIds, childrenByTask) {
  const keys = new Map();
  const add = (PK, SK) => {
    if (!PK || !SK) return;
    keys.set(`${PK}\u0000${SK}`, { PK, SK });
  };
  for (const taskId of taskIds) {
    add(TASK_ENTITY_PK, canonicalTaskSk(taskId));
    add(projectTaskPk(projectId), canonicalTaskSk(taskId));
    for (const child of childrenByTask.get(taskId) || []) {
      if (child.PK !== taskChildPk(taskId)) continue;
      add(child.PK, child.SK);
    }
  }
  return [...keys.values()];
}

async function batchWriteDeletes(
  ddb,
  tableName,
  keys,
  {
    maxAttempts = DELETE_MAX_ATTEMPTS,
    sleep = defaultSleep,
    batchLimit = DYNAMO_BATCH_LIMIT,
  } = {}
) {
  if (!keys.length) return;
  let pending = keys.map((Key) => ({ DeleteRequest: { Key } }));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const leftover = [];
    for (const group of chunk(pending, batchLimit)) {
      const res = await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [tableName]: group },
        })
      );
      leftover.push(...(res.UnprocessedItems?.[tableName] || []));
    }
    if (!leftover.length) return;
    pending = leftover;
    if (attempt >= maxAttempts) {
      const err = new Error("Unprocessed DynamoDB delete requests remained");
      err.code = "PROJECT_DELETE_UNPROCESSED";
      throw err;
    }
    await sleep(backoffMs(attempt));
  }
}

function collectAttachmentTargets(taskIds, childrenByTask) {
  const safe = [];
  const unsafe = [];
  const seen = new Set();
  for (const taskId of taskIds) {
    for (const child of childrenByTask.get(taskId) || []) {
      if (!String(child.SK || "").startsWith("ATTACHMENT#")) continue;
      const key = normalizeS3Key(child.s3Key);
      if (!key) continue;
      if (!isSafeTaskAttachmentKey(key, taskId)) {
        unsafe.push({ taskId, s3Key: key });
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      safe.push(key);
    }
  }
  return { safe, unsafe };
}

async function deleteS3Keys(
  s3,
  bucket,
  keys,
  {
    maxAttempts = DELETE_MAX_ATTEMPTS,
    sleep = defaultSleep,
    batchLimit = S3_DELETE_LIMIT,
  } = {}
) {
  if (!keys.length) return;
  let pending = keys.map((Key) => ({ Key }));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const leftover = [];
    for (const group of chunk(pending, batchLimit)) {
      const res = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: group, Quiet: false },
        })
      );
      for (const error of res.Errors || []) {
        if (isRetryableS3Error(error)) continue;
        leftover.push({ Key: error.Key });
      }
    }
    if (!leftover.length) return;
    pending = leftover;
    if (attempt >= maxAttempts) {
      const err = new Error("S3 attachment cleanup failed");
      err.code = "PROJECT_DELETE_S3_FAILED";
      throw err;
    }
    await sleep(backoffMs(attempt));
  }
}

async function handleListProjects({
  ddb,
  tableName,
  status,
  user,
  accessTable,
} = {}) {
  if (!tableName) {
    return { statusCode: 500, body: { error: "Work table not configured" } };
  }
  const parsed = parseListStatus(status);
  if (!parsed) {
    return { statusCode: 400, body: { error: "Invalid status" } };
  }
  const email = normalizeEmail(user?.email);
  if (!email) {
    return { statusCode: 401, body: { error: "Unauthorized" } };
  }
  if (!accessTable) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }

  let accessRow;
  try {
    accessRow = await loadPortalAccessRow(ddb, accessTable, email);
  } catch (err) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  const portalActive = isEligibleProjectAdmin({
    role: accessRow?.role,
    status: accessRow?.status,
  });
  const accessActive = String(accessRow?.status || "").toUpperCase() === "ACTIVE";

  let catalog;
  try {
    catalog = await listAllProjects(ddb, tableName);
  } catch (err) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  const statusFiltered = filterProjectsByStatus(catalog, parsed);

  let restrictedAcl = { visibleIds: new Set(), adminIds: new Set() };
  if (accessActive) {
    try {
      restrictedAcl = await loadRestrictedCallerAcl(ddb, tableName, email);
    } catch (err) {
      return { statusCode: 500, body: { error: "Internal server error" } };
    }
  }

  const visible = statusFiltered
    .filter((project) => {
      if (isProjectDeleting(project)) return false;
      if (isRestrictedProject(project)) {
        const id = String(project.projectId || "").trim();
        return Boolean(id && restrictedAcl.visibleIds.has(id));
      }
      return portalActive;
    })
    .map((project) => {
      const id = String(project.projectId || "").trim();
      return {
        ...project,
        canManageAccess: Boolean(
          isRestrictedProject(project) && id && restrictedAcl.adminIds.has(id)
        ),
      };
    });
  return { statusCode: 200, body: visible };
}

function projectIdFromUserAclSk(sk, prefix) {
  const raw = String(sk || "");
  if (!raw.startsWith(prefix)) return "";
  return raw.slice(prefix.length).trim();
}

async function loadRestrictedCallerAcl(ddb, tableName, email) {
  const memberItems = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `USER#${email}`,
      ":sk": "PROJECT_MEMBER#",
    },
  });
  const adminItems = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `USER#${email}`,
      ":sk": "PROJECT_ADMIN#",
    },
  });
  const visibleIds = new Set();
  const adminIds = new Set();
  for (const item of memberItems) {
    const id = String(item.projectId || "").trim() || projectIdFromUserAclSk(item.SK, "PROJECT_MEMBER#");
    if (isActiveRegularMemberItem(item, id, email)) visibleIds.add(id);
  }
  for (const item of adminItems) {
    const id = String(item.projectId || "").trim() || projectIdFromUserAclSk(item.SK, "PROJECT_ADMIN#");
    if (isActiveProjectAdminItem(item, id, email)) {
      visibleIds.add(id);
      adminIds.add(id);
    }
  }
  return { visibleIds, adminIds };
}

async function loadVisibleRestrictedProjectIds(ddb, tableName, email) {
  const loaded = await loadRestrictedCallerAcl(ddb, tableName, email);
  return loaded.visibleIds;
}

function deleteResponse(action, project, taskCount) {
  return {
    action,
    projectId: project.projectId,
    name: project.name || "",
    taskCount,
  };
}

function failDelete(code, error) {
  return {
    statusCode: 500,
    body: { error, code },
  };
}

/**
 * DELETE /projects/{id}. Cognito isAdmin is not sufficient.
 * Requires ACTIVE UserAccess ADMIN or SUPER_ADMIN. Project Admin
 * membership is not required. Applies to OPEN and RESTRICTED.
 */
async function handleDeleteProject({
  user,
  projectId,
  body = {},
  query = {},
  ddb,
  s3,
  tableName,
  accessTable,
  attachmentsBucket,
  documentsBucket,
  sleep = defaultSleep,
  maxAttempts = DELETE_MAX_ATTEMPTS,
  dynamoBatchLimit = DYNAMO_BATCH_LIMIT,
  s3DeleteLimit = S3_DELETE_LIMIT,
} = {}) {
  const auth = await requireEligiblePortalAdmin({ user, ddb, accessTable });
  if (!auth.ok) {
    return { statusCode: auth.statusCode, body: auth.body };
  }
  const id = String(projectId || "").trim();
  if (!id) {
    return { statusCode: 400, body: { error: "projectId required" } };
  }
  if (!tableName) {
    return { statusCode: 500, body: { error: "Work table not configured" } };
  }

  const project = await getProject(ddb, tableName, id);
  if (!project) {
    return { statusCode: 404, body: { error: "Project not found" } };
  }

  const confirmName = confirmationNameOf(body, query);
  if (!confirmName) {
    return { statusCode: 400, body: { error: CONFIRM_NAME_REQUIRED } };
  }
  if (!namesMatch(confirmName, project.name)) {
    return { statusCode: 400, body: { error: CONFIRM_NAME_MISMATCH } };
  }

  let copies;
  let canonical;
  let deletionLockId = null;
  const alreadyDeleting = isProjectDeleting(project);

  if (!alreadyDeleting) {
    const locked = await acquireDeletionLock(ddb, tableName, id);
    if (!locked.ok) {
      let latest = null;
      try {
        latest = await getProject(ddb, tableName, id);
      } catch (err) {
        latest = null;
      }
      if (!latest || isProjectDeleting(latest)) {
        return { statusCode: 404, body: { error: "Project not found" } };
      }
      if (locked.reason === REASON_CONDITION_FAILED) {
        return { statusCode: 409, body: { error: "Conflict" } };
      }
      return failDelete("PROJECT_DELETE_FAILED", "Unable to delete project");
    }
    deletionLockId = locked.lockId;
  }

  try {
    copies = await listProjectTaskCopies(ddb, tableName, id);
    canonical = await listCanonicalTasksForProject(ddb, tableName, id);
  } catch (err) {
    if (deletionLockId) {
      await releaseDeletionLock(ddb, tableName, id, deletionLockId);
    }
    console.error(
      "PROJECT_DELETE_TASK_LOOKUP_FAILED",
      JSON.stringify({ projectId: id })
    );
    return {
      statusCode: 500,
      body: { error: "Unable to verify project tasks" },
    };
  }

  if ((copies && copies.length) || (canonical && canonical.length)) {
    if (deletionLockId) {
      await releaseDeletionLock(ddb, tableName, id, deletionLockId);
    }
    return {
      statusCode: 409,
      body: {
        error: PROJECT_HAS_TASKS_MESSAGE,
        code: PROJECT_HAS_TASKS,
      },
    };
  }

  const taskIds = collectTaskIds(copies, canonical);
  const childrenByTask = new Map();
  try {
    for (const taskId of taskIds) {
      childrenByTask.set(
        taskId,
        await listTaskChildren(ddb, tableName, taskId)
      );
    }
  } catch (err) {
    if (deletionLockId) {
      await releaseDeletionLock(ddb, tableName, id, deletionLockId);
    }
    console.error(
      "PROJECT_DELETE_CHILD_LOOKUP_FAILED",
      JSON.stringify({ projectId: id })
    );
    return {
      statusCode: 500,
      body: { error: "Unable to verify project tasks" },
    };
  }

  const attachments = collectAttachmentTargets(taskIds, childrenByTask);
  if (attachments.unsafe.length) {
    if (deletionLockId) {
      await releaseDeletionLock(ddb, tableName, id, deletionLockId);
    }
    console.error(
      "PROJECT_DELETE_UNSAFE_S3_KEY",
      JSON.stringify({ projectId: id, count: attachments.unsafe.length })
    );
    return failDelete(
      "PROJECT_DELETE_UNSAFE_S3_KEY",
      "Unable to delete project attachments"
    );
  }

  if (!alreadyDeleting) {
    const marked = await convertLockToDeleting(
      ddb,
      tableName,
      id,
      deletionLockId
    );
    if (!marked.ok) {
      console.error(
        "PROJECT_DELETE_TOMBSTONE_FAILED",
        JSON.stringify({ projectId: id, reason: marked.reason || "" })
      );
      return failDelete("PROJECT_DELETE_FAILED", "Unable to delete project");
    }
  }

  const aclCleanup = await deleteAllProjectAclRecords(ddb, tableName, id);
  if (!aclCleanup.ok) {
    console.error(
      "PROJECT_DELETE_ACL_FAILED",
      JSON.stringify({ projectId: id, reason: aclCleanup.reason || "" })
    );
    return failDelete("PROJECT_DELETE_FAILED", "Unable to delete project");
  }

  const bucket = String(attachmentsBucket || "").trim();
  const docsBucket = String(documentsBucket || "").trim();
  if (attachments.safe.length) {
    if (!s3 || !bucket) {
      return failDelete(
        "PROJECT_DELETE_S3_FAILED",
        "Unable to delete project attachments"
      );
    }
    if (docsBucket && bucket === docsBucket) {
      return failDelete(
        "PROJECT_DELETE_S3_FAILED",
        "Unable to delete project attachments"
      );
    }
    try {
      await deleteS3Keys(s3, bucket, attachments.safe, {
        maxAttempts,
        sleep,
        batchLimit: s3DeleteLimit,
      });
    } catch (err) {
      console.error(
        "PROJECT_DELETE_S3_FAILED",
        JSON.stringify({ projectId: id, code: err.code || "" })
      );
      return failDelete(
        err.code || "PROJECT_DELETE_S3_FAILED",
        "Unable to delete project attachments"
      );
    }
  }

  const dynamoKeys = projectOwnedDeleteKeys(id, taskIds, childrenByTask);
  try {
    await batchWriteDeletes(ddb, tableName, dynamoKeys, {
      maxAttempts,
      sleep,
      batchLimit: dynamoBatchLimit,
    });
  } catch (err) {
    console.error(
      "PROJECT_DELETE_DYNAMO_FAILED",
      JSON.stringify({ projectId: id, code: err.code || "" })
    );
    return failDelete(
      err.code || "PROJECT_DELETE_FAILED",
      "Unable to delete project"
    );
  }

  try {
    const remainingCopies = await listProjectTaskCopies(ddb, tableName, id);
    const remainingCanonical = await listCanonicalTasksForProject(
      ddb,
      tableName,
      id
    );
    if (remainingCopies.length || remainingCanonical.length) {
      return failDelete(
        "PROJECT_DELETE_VERIFY_FAILED",
        "Unable to verify project deletion"
      );
    }
    for (const taskId of taskIds) {
      const remainingChildren = await listTaskChildren(ddb, tableName, taskId);
      if (remainingChildren.length) {
        return failDelete(
          "PROJECT_DELETE_VERIFY_FAILED",
          "Unable to verify project deletion"
        );
      }
    }
  } catch (err) {
    console.error(
      "PROJECT_DELETE_VERIFY_FAILED",
      JSON.stringify({ projectId: id })
    );
    return failDelete(
      "PROJECT_DELETE_VERIFY_FAILED",
      "Unable to verify project deletion"
    );
  }

  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { PK: PROJECT_ENTITY_PK, SK: projectSk(id) },
      })
    );
  } catch (err) {
    console.error(
      "PROJECT_DELETE_FAILED",
      JSON.stringify({ projectId: id })
    );
    return {
      statusCode: 500,
      body: { error: "Unable to delete project" },
    };
  }
  return {
    statusCode: 200,
    body: deleteResponse(ACTION_DELETED, project, taskIds.length),
  };
}

async function handlePatchProject({
  user,
  projectId,
  body = {},
  ddb,
  tableName,
  accessTable,
  now,
} = {}) {
  if (body && body.access && typeof body.access === "object") {
    const { handleProjectAccess } = require("./projectAccessManage");
    return handleProjectAccess({
      user,
      projectId,
      access: body.access,
      ddb,
      tableName,
      accessTable,
      now,
    });
  }
  const auth = await requireEligiblePortalAdmin({ user, ddb, accessTable });
  if (!auth.ok) {
    return { statusCode: auth.statusCode, body: auth.body };
  }
  const id = String(projectId || "").trim();
  if (!id) {
    return { statusCode: 400, body: { error: "projectId required" } };
  }
  if (!tableName) {
    return { statusCode: 500, body: { error: "Work table not configured" } };
  }

  const project = await getProject(ddb, tableName, id);
  if (!project || isProjectDeleting(project)) {
    return { statusCode: 404, body: { error: "Project not found" } };
  }

  const next = { ...project };
  let changed = false;

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const name = normalizeProjectName(body.name);
    if (!name) {
      return { statusCode: 400, body: { error: "name is required" } };
    }
    next.name = name;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(body, "client")) {
    next.client = String(body.client || "");
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    next.description = String(body.description || "");
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    const status = String(body.status || "")
      .trim()
      .toUpperCase();
    if (status !== STATUS_ACTIVE && status !== STATUS_ARCHIVED) {
      return { statusCode: 400, body: { error: "Invalid status" } };
    }
    if (status === STATUS_ARCHIVED) {
      next.status = STATUS_ARCHIVED;
      next.archivedAt = now || new Date().toISOString();
      next.archivedBy = auth.email;
    } else {
      next.status = STATUS_ACTIVE;
      delete next.archivedAt;
      delete next.archivedBy;
    }
    changed = true;
  }

  if (!changed) {
    return { statusCode: 400, body: { error: "No updates provided" } };
  }

  const nameChanged = !namesMatch(project.name, next.name);
  if (nameChanged || isActiveProject(next)) {
    const all = await listAllProjects(ddb, tableName);
    const conflict = findActiveNameConflict(all, next.name, id);
    if (conflict) {
      return {
        statusCode: 409,
        body: { error: "A project with this name already exists." },
      };
    }
  }

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: next,
        ConditionExpression:
          "attribute_exists(PK) AND (attribute_not_exists(deletionStatus) OR deletionStatus <> :deleting)",
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
        },
      })
    );
  } catch (err) {
    if (String(err?.name || "") !== "ConditionalCheckFailedException") {
      return { statusCode: 500, body: { error: "Internal server error" } };
    }
    let latest = null;
    try {
      latest = await getProject(ddb, tableName, id);
    } catch (readErr) {
      return { statusCode: 500, body: { error: "Internal server error" } };
    }
    if (!latest || isProjectDeleting(latest)) {
      return { statusCode: 404, body: { error: "Project not found" } };
    }
    return { statusCode: 409, body: { error: "Conflict" } };
  }
  return { statusCode: 200, body: next };
}

function isRestrictedCreateEnabled(value, env = process.env) {
  if (value === true || value === false) return value;
  return String(env[ENV_RESTRICTED_CREATE] || "").trim().toLowerCase() === "true";
}

function parseCreateAccessMode(raw) {
  if (raw == null || String(raw).trim() === "") {
    return { ok: true, value: ACCESS_OPEN };
  }
  const mode = String(raw).trim().toUpperCase();
  if (mode === ACCESS_OPEN) return { ok: true, value: ACCESS_OPEN };
  if (mode === ACCESS_RESTRICTED) return { ok: true, value: ACCESS_RESTRICTED };
  return { ok: false };
}

function parseCreateMembers(raw, creatorEmail) {
  const list = Array.isArray(raw) ? raw : [];
  const emails = [];
  const seen = new Set();
  const creator = normalizeEmail(creatorEmail);
  for (const entry of list) {
    const value = typeof entry === "string" ? entry : entry?.email;
    const email = normalizeEmail(value);
    if (!email || email === creator || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

async function loadPortalAccessRow(ddb, accessTable, email) {
  if (!accessTable) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: accessTable,
      Key: { PK: email, SK: email },
    })
  );
  return res.Item || null;
}

function mapPersistWriteError(result) {
  if (!result || result.ok) return null;
  if (result.reason === REASON_INVALID_TASK_VISIBILITY) {
    return { statusCode: 400, body: { error: "Invalid taskVisibility" } };
  }
  if (result.reason === REASON_INVALID_IDENTITY) {
    return { statusCode: 400, body: { error: "Invalid project identity" } };
  }
  if (result.reason === REASON_CONDITION_FAILED) {
    return { statusCode: 409, body: { error: "Conflict" } };
  }
  if (result.reason === REASON_TX_CONFLICT || result.reason === REASON_DDB_ERROR) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  return { statusCode: 500, body: { error: "Internal server error" } };
}

/**
 * POST /projects. Cognito isAdmin is not sufficient.
 * RESTRICTED create is gated by PROJECT_ACL_RESTRICTED_CREATE=true until
 * catalog/task ACL is implemented (GET /projects currently lists all projects).
 */
async function handleCreateProject({
  user,
  body = {},
  ddb,
  tableName,
  accessTable,
  now,
  newId,
  restrictedCreateEnabled,
} = {}) {
  if (!tableName) {
    return { statusCode: 500, body: { error: "Work table not configured" } };
  }
  const auth = await requireEligiblePortalAdmin({ user, ddb, accessTable });
  if (!auth.ok) {
    return { statusCode: auth.statusCode, body: auth.body };
  }

  const mode = parseCreateAccessMode(body.accessMode);
  if (!mode.ok) {
    return { statusCode: 400, body: { error: "Invalid accessMode" } };
  }

  const email = auth.email;
  const createdAt = now || new Date().toISOString();
  const projectId = typeof newId === "function" ? String(newId()) : randomUUID();
  const lead = normalizeEmail(body.lead) || email;
  const catalog = {
    PK: PROJECT_ENTITY_PK,
    SK: projectSk(projectId),
    projectId,
    name: body.name,
    client: body.client || "",
    lead,
    members: body.members || [],
    status: body.status || STATUS_ACTIVE,
    description: body.description || "",
    createdAt,
    createdBy: email,
    accessMode: mode.value,
  };

  if (mode.value === ACCESS_RESTRICTED) {
    if (!isRestrictedCreateEnabled(restrictedCreateEnabled)) {
      return { statusCode: 400, body: { error: RESTRICTED_CREATE_DISABLED } };
    }
    const members = parseCreateMembers(body.members, email);
    if (!members.length) {
      return { statusCode: 400, body: { error: RESTRICTED_MEMBERS_REQUIRED } };
    }
    if (members.length > MAX_RESTRICTED_CREATE_MEMBERS) {
      return { statusCode: 400, body: { error: RESTRICTED_TOO_MANY_MEMBERS } };
    }
    for (const memberEmail of members) {
      let accessRow;
      try {
        accessRow = await loadPortalAccessRow(ddb, accessTable, memberEmail);
      } catch (err) {
        return { statusCode: 500, body: { error: "Internal server error" } };
      }
      if (String(accessRow?.status || "").toUpperCase() !== STATUS_ACTIVE) {
        return { statusCode: 400, body: { error: RESTRICTED_MEMBER_INACTIVE } };
      }
    }
    catalog.members = members;
    const written = await createRestrictedProject(ddb, tableName, {
      projectId,
      email,
      actorEmail: email,
      now: createdAt,
      taskVisibility: body.taskVisibility,
      catalog,
      members,
    });
    const fail = mapPersistWriteError(written);
    if (fail) return fail;
    return { statusCode: 201, body: written.catalog };
  }

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: catalog,
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  } catch (err) {
    if (String(err?.name || "") === "ConditionalCheckFailedException") {
      return { statusCode: 409, body: { error: "Conflict" } };
    }
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  return { statusCode: 201, body: catalog };
}

module.exports = {
  PROJECT_ENTITY_PK,
  TASK_ENTITY_PK,
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  STATUS_ALL,
  ACTION_ARCHIVED,
  ACTION_DELETED,
  PROJECT_HAS_TASKS,
  PROJECT_HAS_TASKS_MESSAGE,
  DYNAMO_BATCH_LIMIT,
  S3_DELETE_LIMIT,
  CONFIRM_NAME_REQUIRED,
  CONFIRM_NAME_MISMATCH,
  projectPathMatch,
  isActiveProject,
  filterActiveProjects,
  filterProjectsByStatus,
  parseListStatus,
  countActiveProjects,
  namesMatch,
  confirmationNameOf,
  isSafeTaskAttachmentKey,
  getProject,
  getProjectName,
  countProjectTasks,
  listActiveProjects,
  handleListProjects,
  handleCreateProject,
  handleDeleteProject,
  handlePatchProject,
  isRestrictedCreateEnabled,
  parseCreateMembers,
  RESTRICTED_CREATE_DISABLED,
  RESTRICTED_MEMBERS_REQUIRED,
  RESTRICTED_MEMBER_INACTIVE,
};

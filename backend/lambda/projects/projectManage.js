const {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");

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
  return projectStatusOf(item) === STATUS_ACTIVE;
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

async function handleListProjects({ ddb, tableName, status } = {}) {
  if (!tableName) {
    return { statusCode: 500, body: { error: "Work table not configured" } };
  }
  const parsed = parseListStatus(status);
  if (!parsed) {
    return { statusCode: 400, body: { error: "Invalid status" } };
  }
  const items = await listAllProjects(ddb, tableName);
  return { statusCode: 200, body: filterProjectsByStatus(items, parsed) };
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

async function handleDeleteProject({
  user,
  projectId,
  body = {},
  query = {},
  ddb,
  s3,
  tableName,
  attachmentsBucket,
  documentsBucket,
  sleep = defaultSleep,
  maxAttempts = DELETE_MAX_ATTEMPTS,
  dynamoBatchLimit = DYNAMO_BATCH_LIMIT,
  s3DeleteLimit = S3_DELETE_LIMIT,
} = {}) {
  if (!user?.isAdmin) {
    return { statusCode: 403, body: { error: "Admin required" } };
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
  try {
    copies = await listProjectTaskCopies(ddb, tableName, id);
    canonical = await listCanonicalTasksForProject(ddb, tableName, id);
  } catch (err) {
    console.error(
      "PROJECT_DELETE_TASK_LOOKUP_FAILED",
      JSON.stringify({ projectId: id })
    );
    return {
      statusCode: 500,
      body: { error: "Unable to verify project tasks" },
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
    console.error(
      "PROJECT_DELETE_UNSAFE_S3_KEY",
      JSON.stringify({ projectId: id, count: attachments.unsafe.length })
    );
    return failDelete(
      "PROJECT_DELETE_UNSAFE_S3_KEY",
      "Unable to delete project attachments"
    );
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
  now,
} = {}) {
  if (!user?.isAdmin) {
    return { statusCode: 403, body: { error: "Admin required" } };
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
      next.archivedBy = user.email || "";
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

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: next,
    })
  );
  return { statusCode: 200, body: next };
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
  handleDeleteProject,
  handlePatchProject,
};

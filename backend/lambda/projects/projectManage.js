const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

const PROJECT_ENTITY_PK = "ENTITY#PROJECT";
const STATUS_ACTIVE = "ACTIVE";
const STATUS_ARCHIVED = "ARCHIVED";
const STATUS_ALL = "ALL";
const ACTION_ARCHIVED = "ARCHIVED";
const ACTION_DELETED = "DELETED";

function projectSk(projectId) {
  return `PROJECT#${projectId}`;
}

function projectTaskPk(projectId) {
  return `PROJECT#${projectId}`;
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

async function countProjectTasks(ddb, tableName, projectId) {
  const items = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": projectTaskPk(projectId),
      ":sk": "TASK#",
    },
  });
  return items.length;
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

async function handleDeleteProject({
  user,
  projectId,
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

  const taskCount = await countProjectTasks(ddb, tableName, id);
  const timestamp = now || new Date().toISOString();

  if (taskCount > 0) {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...project,
          status: STATUS_ARCHIVED,
          archivedAt: timestamp,
          archivedBy: user.email || "",
        },
      })
    );
    return {
      statusCode: 200,
      body: deleteResponse(ACTION_ARCHIVED, project, taskCount),
    };
  }

  await ddb.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { PK: PROJECT_ENTITY_PK, SK: projectSk(id) },
    })
  );
  return {
    statusCode: 200,
    body: deleteResponse(ACTION_DELETED, project, 0),
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
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  STATUS_ALL,
  ACTION_ARCHIVED,
  ACTION_DELETED,
  projectPathMatch,
  isActiveProject,
  filterActiveProjects,
  filterProjectsByStatus,
  parseListStatus,
  countActiveProjects,
  getProject,
  getProjectName,
  countProjectTasks,
  listActiveProjects,
  handleListProjects,
  handleDeleteProject,
  handlePatchProject,
};

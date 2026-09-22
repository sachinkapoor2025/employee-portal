/**
 * HTTP access-management for project members and Project Admins.
 * Mutations use PATCH /projects/{projectId} { access: { action, email, ... } }.
 * Dedicated member routes are not added (no template.yaml change).
 */
const { GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const {
  isRestrictedProject,
  isEligibleProjectAdmin,
  isActiveProjectAdminItem,
  isActiveRegularMemberItem,
  projectAdminTaskVisibility,
  projectAccessMode,
  isProjectDeleting,
  normalizeEmail,
} = require("./projectAccess");
const persist = require("./projectAccessPersist");

function trimId(value) {
  return String(value || "").trim();
}

const ACTION_LIST = "list";
const ACTION_ADD_MEMBER = "addMember";
const ACTION_REVOKE_MEMBER = "revokeMember";
const ACTION_REACTIVATE_MEMBER = "reactivateMember";
const ACTION_ADD_ADMIN = "addAdmin";
const ACTION_REVOKE_ADMIN = "revokeAdmin";
const ACTION_REACTIVATE_ADMIN = "reactivateAdmin";
const ACTION_UPDATE_VISIBILITY = "updateVisibility";

const WRITE_ACTIONS = new Set([
  ACTION_ADD_MEMBER,
  ACTION_REVOKE_MEMBER,
  ACTION_REACTIVATE_MEMBER,
  ACTION_ADD_ADMIN,
  ACTION_REVOKE_ADMIN,
  ACTION_REACTIVATE_ADMIN,
  ACTION_UPDATE_VISIBILITY,
]);

async function getStoredProject(ddb, tableName, projectId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: "ENTITY#PROJECT", SK: `PROJECT#${projectId}` },
    })
  );
  return res.Item || null;
}

async function queryPrefix(ddb, tableName, pk, skPrefix) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": pk, ":sk": skPrefix },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function loadAccessRow(ddb, accessTable, email) {
  if (!accessTable || !email) return { ok: true, item: null };
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: accessTable,
        Key: { PK: email, SK: email },
      })
    );
    return { ok: true, item: res.Item || null };
  } catch (err) {
    return { ok: false, reason: persist.REASON_DDB_ERROR };
  }
}

function persistHttpError(result) {
  if (!result || result.ok) return null;
  if (result.reason === persist.REASON_INVALID_TASK_VISIBILITY) {
    return { statusCode: 400, body: { error: "Invalid taskVisibility" } };
  }
  if (result.reason === persist.REASON_INVALID_IDENTITY) {
    return { statusCode: 400, body: { error: "Invalid identity" } };
  }
  if (result.reason === persist.REASON_CONDITION_FAILED) {
    return { statusCode: 409, body: { error: "Conflict" } };
  }
  return { statusCode: 500, body: { error: "Internal server error" } };
}

function publicMember(item, projectId) {
  const email = normalizeEmail(item?.email);
  return {
    email,
    status: String(item?.status || "").toUpperCase(),
    addedAt: item?.addedAt || null,
    addedBy: item?.addedBy || null,
    updatedAt: item?.updatedAt || null,
    active: isActiveRegularMemberItem(item, projectId, email),
  };
}

function publicAdmin(item, projectId) {
  const email = normalizeEmail(item?.email);
  return {
    email,
    status: String(item?.status || "").toUpperCase(),
    taskVisibility: projectAdminTaskVisibility(item),
    addedAt: item?.addedAt || null,
    addedBy: item?.addedBy || null,
    updatedAt: item?.updatedAt || null,
    active: isActiveProjectAdminItem(item, projectId, email),
  };
}

async function listAclItems(ddb, tableName, projectId) {
  const pk = `PROJECT#${projectId}`;
  try {
    const [members, admins] = await Promise.all([
      queryPrefix(ddb, tableName, pk, "MEMBER#"),
      queryPrefix(ddb, tableName, pk, "PROJECT_ADMIN#"),
    ]);
    return { ok: true, members, admins };
  } catch (err) {
    return { ok: false, reason: persist.REASON_DDB_ERROR };
  }
}

async function enforceRestrictedAdminCount(ddb, tableName, projectId) {
  const ensured = await persist.ensureRestrictedAdminCount(ddb, tableName, projectId);
  if (!ensured.ok) return persistHttpError(ensured);
  return null;
}

async function authorizeAccessManager({
  ddb,
  tableName,
  accessTable,
  user,
  project,
}) {
  const email = normalizeEmail(user?.email);
  if (!email) {
    return { ok: true, allowed: false, statusCode: 401 };
  }
  const callerAccess = await loadAccessRow(ddb, accessTable, email);
  if (!callerAccess.ok) return { ok: false, reason: callerAccess.reason };
  if (isRestrictedProject(project)) {
    const admin = await persist.getProjectAdminRecord(
      ddb,
      tableName,
      project.projectId,
      email
    );
    if (!admin.ok) return admin;
    const allowed =
      String(callerAccess.item?.status || "").toUpperCase() === "ACTIVE" &&
      isActiveProjectAdminItem(admin.item, project.projectId, email);
    return {
      ok: true,
      allowed,
      statusCode: allowed ? 200 : 403,
      callerEmail: email,
      callerAccess: callerAccess.item,
    };
  }
  const allowed = isEligibleProjectAdmin(callerAccess.item);
  return {
    ok: true,
    allowed,
    statusCode: allowed ? 200 : 403,
    callerEmail: email,
    callerAccess: callerAccess.item,
  };
}

function accessListBody(project, members, admins, includeRevoked) {
  const projectId = String(project.projectId || "").trim();
  const memberViews = members.map((item) => publicMember(item, projectId));
  const adminViews = admins.map((item) => publicAdmin(item, projectId));
  const filterActive = (rows) => rows.filter((row) => row.active);
  return {
    projectId,
    accessMode: projectAccessMode(project),
    members: includeRevoked ? memberViews : filterActive(memberViews),
    projectAdmins: includeRevoked ? adminViews : filterActive(adminViews),
  };
}

async function handleProjectAccess({
  user,
  projectId,
  access = {},
  ddb,
  tableName,
  accessTable,
  now,
} = {}) {
  const email = normalizeEmail(user?.email);
  if (!email) {
    return { statusCode: 401, body: { error: "Unauthorized" } };
  }
  const id = trimId(projectId);
  if (!id) {
    return { statusCode: 400, body: { error: "projectId required" } };
  }
  if (!tableName || !ddb) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }

  let project;
  try {
    project = await getStoredProject(ddb, tableName, id);
  } catch (err) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  if (!project || isProjectDeleting(project)) {
    return { statusCode: 404, body: { error: "Project not found" } };
  }

  const action = String(access.action || "").trim();
  if (action !== ACTION_LIST && !WRITE_ACTIONS.has(action)) {
    return { statusCode: 400, body: { error: "Invalid access action" } };
  }

  const auth = await authorizeAccessManager({
    ddb,
    tableName,
    accessTable,
    user,
    project,
  });
  if (!auth.ok) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  if (!auth.allowed) {
    return {
      statusCode: auth.statusCode === 401 ? 401 : 403,
      body: { error: auth.statusCode === 401 ? "Unauthorized" : "Forbidden" },
    };
  }

  const includeRevoked = access.includeRevoked === true;
  if (action === ACTION_LIST) {
    const listed = await listAclItems(ddb, tableName, id);
    if (!listed.ok) {
      return { statusCode: 500, body: { error: "Internal server error" } };
    }
    return {
      statusCode: 200,
      body: accessListBody(project, listed.members, listed.admins, includeRevoked),
    };
  }

  const targetEmail = normalizeEmail(access.email);
  if (!targetEmail) {
    return { statusCode: 400, body: { error: "email required" } };
  }

  const actorEmail = auth.callerEmail;
  const params = {
    projectId: id,
    email: targetEmail,
    actorEmail,
    now,
    mode: persist.MODE_CREATE,
    taskVisibility: access.taskVisibility,
  };

  if (action === ACTION_ADD_MEMBER || action === ACTION_REACTIVATE_MEMBER) {
    const targetAccess = await loadAccessRow(ddb, accessTable, targetEmail);
    if (!targetAccess.ok) {
      return { statusCode: 500, body: { error: "Internal server error" } };
    }
    if (String(targetAccess.item?.status || "").toUpperCase() !== "ACTIVE") {
      return { statusCode: 400, body: { error: "Target user is not active" } };
    }
    params.mode =
      action === ACTION_ADD_MEMBER
        ? persist.MODE_CREATE
        : persist.MODE_REACTIVATE;
    const written = await persist.putProjectMemberRecords(ddb, tableName, params);
    const err = persistHttpError(written);
    if (err) return err;
  } else if (action === ACTION_REVOKE_MEMBER) {
    const written = await persist.revokeProjectMemberRecords(ddb, tableName, params);
    const err = persistHttpError(written);
    if (err) return err;
  } else if (action === ACTION_ADD_ADMIN) {
    const targetAccess = await loadAccessRow(ddb, accessTable, targetEmail);
    if (!targetAccess.ok) {
      return { statusCode: 500, body: { error: "Internal server error" } };
    }
    if (!isEligibleProjectAdmin(targetAccess.item)) {
      return {
        statusCode: 400,
        body: { error: "Target is not eligible to be a Project Admin" },
      };
    }
    params.mode = persist.MODE_CREATE;
    if (isRestrictedProject(project)) {
      const ensured = await enforceRestrictedAdminCount(ddb, tableName, id);
      if (ensured) return ensured;
      params.enforceAdminCount = true;
    }
    const written = await persist.putProjectAdminRecords(ddb, tableName, params);
    const err = persistHttpError(written);
    if (err) return err;
  } else if (action === ACTION_REACTIVATE_ADMIN) {
    const targetAccess = await loadAccessRow(ddb, accessTable, targetEmail);
    if (!targetAccess.ok) {
      return { statusCode: 500, body: { error: "Internal server error" } };
    }
    if (!isEligibleProjectAdmin(targetAccess.item)) {
      return {
        statusCode: 400,
        body: { error: "Target is not eligible to be a Project Admin" },
      };
    }
    const existing = await persist.getProjectAdminRecord(
      ddb,
      tableName,
      id,
      targetEmail
    );
    if (!existing.ok) {
      return { statusCode: 500, body: { error: "Internal server error" } };
    }
    const visRaw = access.taskVisibility;
    const visOmitted = visRaw == null || String(visRaw).trim() === "";
    params.taskVisibility = visOmitted
      ? existing.item?.taskVisibility
      : visRaw;
    params.mode = persist.MODE_REACTIVATE;
    if (isRestrictedProject(project)) {
      const ensured = await enforceRestrictedAdminCount(ddb, tableName, id);
      if (ensured) return ensured;
      params.enforceAdminCount = true;
    }
    const written = await persist.putProjectAdminRecords(ddb, tableName, params);
    const err = persistHttpError(written);
    if (err) return err;
  } else if (action === ACTION_UPDATE_VISIBILITY) {
    params.mode = persist.MODE_UPDATE_VISIBILITY;
    const written = await persist.putProjectAdminRecords(ddb, tableName, params);
    const err = persistHttpError(written);
    if (err) return err;
  } else if (action === ACTION_REVOKE_ADMIN) {
    if (isRestrictedProject(project)) {
      const ensured = await enforceRestrictedAdminCount(ddb, tableName, id);
      if (ensured) return ensured;
      params.enforceAdminCount = true;
    }
    const written = await persist.revokeProjectAdminRecords(ddb, tableName, params);
    const err = persistHttpError(written);
    if (err) {
      if (
        isRestrictedProject(project) &&
        written.reason === persist.REASON_CONDITION_FAILED
      ) {
        return {
          statusCode: 409,
          body: { error: "A restricted project must keep at least one Project Admin" },
        };
      }
      return err;
    }
  }

  const listed = await listAclItems(ddb, tableName, id);
  if (!listed.ok) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  return {
    statusCode: 200,
    body: accessListBody(project, listed.members, listed.admins, includeRevoked),
  };
}

module.exports = {
  ACTION_LIST,
  ACTION_ADD_MEMBER,
  ACTION_REVOKE_MEMBER,
  ACTION_REACTIVATE_MEMBER,
  ACTION_ADD_ADMIN,
  ACTION_REVOKE_ADMIN,
  ACTION_REACTIVATE_ADMIN,
  ACTION_UPDATE_VISIBILITY,
  handleProjectAccess,
  authorizeAccessManager,
};

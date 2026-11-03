const { randomUUID } = require("crypto");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { requireEligiblePortalAdmin } = require("./portalAdminAuth");
const { OWNER_DESIGNATION, versionPutsForMutation } = require("./costRateVersions");
const { normalizeEmail } = require("./projectAccess");

const ORG_DESIGNATION_PK = "ENTITY#ORG_DESIGNATION";
const ORG_DESIGNATION_NAME_PK = "ENTITY#ORG_DESIGNATION_NAME";
const TYPE_ORG_DESIGNATION = "ORG_DESIGNATION";
const TYPE_ORG_DESIGNATION_NAME = "ORG_DESIGNATION_NAME";
const DEPARTMENT_ENTITY_PK = "ENTITY#DEPARTMENT";
const STATUS_ACTIVE = "ACTIVE";
const STATUS_INACTIVE = "INACTIVE";
const NAME_MAX = 80;
const NAME_REQUIRED = "Designation name is required.";
const TRACK_REQUIRED = "Designation track is required.";
const NAME_DUPLICATE = "A designation with this name already exists in this department.";
const NOT_FOUND = "Designation not found.";
const DEPARTMENT_NOT_FOUND = "Department not found.";
const WRONG_DEPARTMENT = "Designation does not belong to the selected department.";
const INACTIVE_ASSIGN = "Only active designations can be newly assigned.";
const LINK_INVALID = "departmentDesignations must be a list of department and designation IDs.";

function normalizePath(path) {
  return String(path || "").replace(/\/+$/, "");
}

function designationSk(id) {
  return `DESIGNATION#${id}`;
}

function nameSk(departmentId, nameKey) {
  return `NAME#${departmentId}#${nameKey}`;
}

function departmentSk(id) {
  return `DEPARTMENT#${id}`;
}

function displayName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function nameKey(name) {
  return displayName(name)
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function decodeSegment(raw) {
  try {
    return { ok: true, value: decodeURIComponent(String(raw || "")).trim() };
  } catch {
    return { ok: false };
  }
}

function designationListPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  if (!/\/departments\/[^/]+\/designations$/.test(normalized)) return null;
  const fromParams = pathParameters?.departmentId
    ? String(pathParameters.departmentId)
    : "";
  if (fromParams) return decodeSegment(fromParams);
  const match = normalized.match(/\/departments\/([^/]+)\/designations$/);
  return match ? decodeSegment(match[1]) : null;
}

function designationStatusPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  if (!/\/admin\/departments\/[^/]+\/designations\/[^/]+\/status$/.test(normalized)) {
    return null;
  }
  const departmentId = pathParameters?.departmentId
    ? decodeSegment(pathParameters.departmentId)
    : decodeSegment(normalized.match(/\/admin\/departments\/([^/]+)\/designations\//)?.[1]);
  const designationId = pathParameters?.designationId
    ? decodeSegment(pathParameters.designationId)
    : decodeSegment(
        normalized.match(/\/designations\/([^/]+)\/status$/)?.[1]
      );
  if (!departmentId?.ok || !designationId?.ok) return { ok: false };
  if (!departmentId.value || !designationId.value) return null;
  return {
    ok: true,
    departmentId: departmentId.value,
    designationId: designationId.value,
  };
}

function designationIdPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  if (/\/status$/.test(normalized)) return null;
  if (!/\/admin\/departments\/[^/]+\/designations\/[^/]+$/.test(normalized)) return null;
  const departmentId = pathParameters?.departmentId
    ? decodeSegment(pathParameters.departmentId)
    : decodeSegment(normalized.match(/\/admin\/departments\/([^/]+)\/designations\//)?.[1]);
  const designationId = pathParameters?.designationId
    ? decodeSegment(pathParameters.designationId)
    : decodeSegment(normalized.match(/\/designations\/([^/]+)$/)?.[1]);
  if (!departmentId?.ok || !designationId?.ok) return { ok: false };
  if (!departmentId.value || !designationId.value) return null;
  return {
    ok: true,
    departmentId: departmentId.value,
    designationId: designationId.value,
  };
}

function isConditionalCheckFailed(err) {
  return err?.name === "ConditionalCheckFailedException";
}

function transactFailedAt(err, index) {
  const reasons = err?.CancellationReasons || err?.cancellationReasons || [];
  const row = reasons[index] || {};
  return String(row.Code || row.code || "") === "ConditionalCheckFailed";
}

async function queryAll(ddb, input) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({ ...input, ExclusiveStartKey: lastKey })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function getDepartment(ddb, tableName, departmentId) {
  const id = String(departmentId || "").trim();
  if (!id) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: DEPARTMENT_ENTITY_PK, SK: departmentSk(id) },
    })
  );
  return res.Item || null;
}

async function getDesignation(ddb, tableName, designationId) {
  const id = String(designationId || "").trim();
  if (!id) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: ORG_DESIGNATION_PK, SK: designationSk(id) },
    })
  );
  return res.Item && res.Item.type === TYPE_ORG_DESIGNATION ? res.Item : null;
}

function publicDesignation(item) {
  if (!item) return null;
  return {
    designationId: item.designationId,
    departmentId: item.departmentId,
    track: item.track || "",
    trackSort: Number(item.trackSort) || 0,
    sortOrder: Number(item.sortOrder) || 0,
    name: item.name,
    status: item.status,
    createdAt: item.createdAt || null,
    createdBy: item.createdBy || null,
    updatedAt: item.updatedAt || null,
    updatedBy: item.updatedBy || null,
  };
}

async function listForDepartment(ddb, tableName, departmentId) {
  const items = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": ORG_DESIGNATION_PK,
      ":sk": "DESIGNATION#",
    },
  });
  return items.filter(
    (item) => item.type === TYPE_ORG_DESIGNATION && item.departmentId === departmentId
  );
}

function requireSignedIn(user) {
  const email = normalizeEmail(user?.email);
  if (!email) return { statusCode: 401, body: { error: "Unauthorized" } };
  return { ok: true, email };
}

async function handleListDesignations({
  user,
  departmentId,
  ddb,
  tableName,
  accessTable,
  admin = false,
}) {
  if (admin) {
    const auth = await requireEligiblePortalAdmin({ user, ddb, accessTable });
    if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  } else {
    const auth = requireSignedIn(user);
    if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  }
  const department = await getDepartment(ddb, tableName, departmentId);
  if (!department) return { statusCode: 404, body: { error: DEPARTMENT_NOT_FOUND } };
  const items = await listForDepartment(ddb, tableName, department.departmentId);
  const designations = items
    .map(publicDesignation)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.trackSort !== b.trackSort) return a.trackSort - b.trackSort;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return String(a.name).localeCompare(String(b.name));
    });
  return { statusCode: 200, body: { designations } };
}

async function handleCreateDesignation({
  user,
  departmentId,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
}) {
  const auth = await requireEligiblePortalAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const department = await getDepartment(ddb, tableName, departmentId);
  if (!department) return { statusCode: 404, body: { error: DEPARTMENT_NOT_FOUND } };
  const name = displayName(body?.name);
  if (!name) return { statusCode: 400, body: { error: NAME_REQUIRED } };
  if (name.length > NAME_MAX) {
    return {
      statusCode: 400,
      body: { error: `Designation name must be at most ${NAME_MAX} characters.` },
    };
  }
  const track = displayName(body?.track);
  if (!track) return { statusCode: 400, body: { error: TRACK_REQUIRED } };
  const sortOrder = Number(body?.sortOrder);
  const trackSort = Number(body?.trackSort);
  const key = nameKey(name);
  const designationId = randomUUID();
  const now = nowIso || new Date().toISOString();
  const item = {
    PK: ORG_DESIGNATION_PK,
    SK: designationSk(designationId),
    type: TYPE_ORG_DESIGNATION,
    designationId,
    departmentId: department.departmentId,
    track,
    trackSort: Number.isInteger(trackSort) && trackSort > 0 ? trackSort : 0,
    sortOrder: Number.isInteger(sortOrder) && sortOrder > 0 ? sortOrder : 0,
    name,
    nameKey: key,
    status: STATUS_ACTIVE,
    internalHourlyRate: null,
    externalHourlyRate: null,
    createdAt: now,
    createdBy: auth.email,
    updatedAt: now,
    updatedBy: auth.email,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                PK: ORG_DESIGNATION_NAME_PK,
                SK: nameSk(department.departmentId, key),
                type: TYPE_ORG_DESIGNATION_NAME,
                departmentId: department.departmentId,
                designationId,
                nameKey: key,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      })
    );
  } catch (err) {
    if (isConditionalCheckFailed(err) || transactFailedAt(err, 0) || transactFailedAt(err, 1)) {
      return { statusCode: 409, body: { error: NAME_DUPLICATE } };
    }
    throw err;
  }
  return { statusCode: 201, body: { designation: publicDesignation(item) } };
}

async function handlePatchDesignation({
  user,
  departmentId,
  designationId,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
}) {
  const auth = await requireEligiblePortalAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  if (body?.status !== undefined) {
    return {
      statusCode: 400,
      body: { error: "Use the status endpoint to activate or deactivate a designation." },
    };
  }
  const existing = await getDesignation(ddb, tableName, designationId);
  if (!existing || existing.departmentId !== departmentId) {
    return { statusCode: 404, body: { error: NOT_FOUND } };
  }
  const name = body?.name !== undefined ? displayName(body.name) : existing.name;
  if (!name) return { statusCode: 400, body: { error: NAME_REQUIRED } };
  if (name.length > NAME_MAX) {
    return {
      statusCode: 400,
      body: { error: `Designation name must be at most ${NAME_MAX} characters.` },
    };
  }
  const track = body?.track !== undefined ? displayName(body.track) : existing.track || "";
  if (!track) return { statusCode: 400, body: { error: TRACK_REQUIRED } };
  const sortOrder =
    body?.sortOrder !== undefined ? Number(body.sortOrder) : Number(existing.sortOrder) || 0;
  const trackSort =
    body?.trackSort !== undefined ? Number(body.trackSort) : Number(existing.trackSort) || 0;
  if (!Number.isInteger(sortOrder) || sortOrder < 0) {
    return { statusCode: 400, body: { error: "sortOrder must be a whole number." } };
  }
  const key = nameKey(name);
  const now = nowIso || new Date().toISOString();
  const item = {
    ...existing,
    name,
    nameKey: key,
    track,
    trackSort: Number.isInteger(trackSort) && trackSort > 0 ? trackSort : 0,
    sortOrder,
    designationId: existing.designationId,
    departmentId: existing.departmentId,
    updatedAt: now,
    updatedBy: auth.email,
  };
  const oldKey = existing.nameKey || nameKey(existing.name);
  try {
    if (oldKey === key) {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: "attribute_exists(PK)",
        })
      );
    } else {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: ORG_DESIGNATION_NAME_PK,
                  SK: nameSk(existing.departmentId, key),
                  type: TYPE_ORG_DESIGNATION_NAME,
                  departmentId: existing.departmentId,
                  designationId: existing.designationId,
                  nameKey: key,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: {
                  PK: ORG_DESIGNATION_NAME_PK,
                  SK: nameSk(existing.departmentId, oldKey),
                },
                ConditionExpression: "attribute_exists(PK)",
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: item,
                ConditionExpression: "attribute_exists(PK)",
              },
            },
          ],
        })
      );
    }
  } catch (err) {
    if (transactFailedAt(err, 0)) {
      return { statusCode: 409, body: { error: NAME_DUPLICATE } };
    }
    if (isConditionalCheckFailed(err)) {
      return { statusCode: 404, body: { error: NOT_FOUND } };
    }
    throw err;
  }
  return { statusCode: 200, body: { designation: publicDesignation(item) } };
}

async function handleDesignationStatus({
  user,
  departmentId,
  designationId,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
}) {
  const auth = await requireEligiblePortalAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const status = String(body?.status || "").trim().toUpperCase();
  if (status !== STATUS_ACTIVE && status !== STATUS_INACTIVE) {
    return { statusCode: 400, body: { error: "Status must be ACTIVE or INACTIVE." } };
  }
  const existing = await getDesignation(ddb, tableName, designationId);
  if (!existing || existing.departmentId !== departmentId) {
    return { statusCode: 404, body: { error: NOT_FOUND } };
  }
  const now = nowIso || new Date().toISOString();
  const item = {
    ...existing,
    status,
    updatedAt: now,
    updatedBy: auth.email,
  };
  const versionPuts = await versionPutsForMutation({
    ddb,
    tableName,
    ownerType: OWNER_DESIGNATION,
    ownerId: existing.designationId,
    existingItem: existing,
    nextSnapshot: item,
    nowIso: now,
    actor: auth.email,
  });
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: item,
            ConditionExpression: "attribute_exists(PK)",
          },
        },
        ...versionPuts,
      ],
    })
  );
  return { statusCode: 200, body: { designation: publicDesignation(item) } };
}

function existingLinks(profile) {
  if (!Array.isArray(profile?.departmentDesignations)) return [];
  return profile.departmentDesignations
    .map((row) => ({
      departmentId: String(row?.departmentId || "").trim(),
      designationId: String(row?.designationId || "").trim(),
    }))
    .filter((row) => row.departmentId && row.designationId);
}

/**
 * Each link must name a department in the employee's membership and a
 * designation stored on that department. A new link requires an active
 * designation. An already stored link may remain when the designation is inactive.
 */
async function resolveDepartmentDesignations({
  ddb,
  tableName,
  departmentIds,
  requested,
  existingProfile,
}) {
  if (!Array.isArray(requested)) return { ok: false, error: LINK_INVALID };
  const allowed = new Set(departmentIds);
  const previous = new Set(
    existingLinks(existingProfile).map((row) => `${row.departmentId}\0${row.designationId}`)
  );
  const seen = new Set();
  const links = [];
  for (const row of requested) {
    const departmentId = String(row?.departmentId || "").trim();
    const designationId = String(row?.designationId || "").trim();
    if (!departmentId && !designationId) continue;
    if (!departmentId || !designationId) return { ok: false, error: LINK_INVALID };
    if (!allowed.has(departmentId)) return { ok: false, error: WRONG_DEPARTMENT };
    if (seen.has(departmentId)) return { ok: false, error: LINK_INVALID };
    seen.add(departmentId);
    const designation = await getDesignation(ddb, tableName, designationId);
    if (!designation) return { ok: false, error: NOT_FOUND };
    if (designation.departmentId !== departmentId) {
      return { ok: false, error: WRONG_DEPARTMENT };
    }
    const already = previous.has(`${departmentId}\0${designationId}`);
    if (!already && String(designation.status).toUpperCase() !== STATUS_ACTIVE) {
      return { ok: false, error: INACTIVE_ASSIGN };
    }
    links.push({ departmentId, designationId });
  }
  return { ok: true, departmentDesignations: links };
}

module.exports = {
  INACTIVE_ASSIGN,
  LINK_INVALID,
  NAME_DUPLICATE,
  TRACK_REQUIRED,
  NOT_FOUND,
  ORG_DESIGNATION_PK,
  WRONG_DEPARTMENT,
  designationIdPathMatch,
  designationListPathMatch,
  designationStatusPathMatch,
  existingLinks,
  getDesignation,
  handleCreateDesignation,
  handleDesignationStatus,
  handleListDesignations,
  handlePatchDesignation,
  resolveDepartmentDesignations,
};

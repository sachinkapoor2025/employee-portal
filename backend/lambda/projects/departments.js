const { randomUUID } = require("crypto");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { requireEligiblePortalAdmin } = require("./portalAdminAuth");
const orgDesignations = require("./departmentDesignations");
const costingDesignation = require("./costingDesignation");
const { normalizeEmail } = require("./projectAccess");

const DEPARTMENT_ENTITY_PK = "ENTITY#DEPARTMENT";
const DEPARTMENT_NAME_PK = "ENTITY#DEPARTMENT_NAME";
const TYPE_DEPARTMENT = "DEPARTMENT";
const TYPE_DEPARTMENT_NAME = "DEPARTMENT_NAME";
const STATUS_ACTIVE = "ACTIVE";
const STATUS_INACTIVE = "INACTIVE";
const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const NAME_REQUIRED = "Department name is required.";
const NAME_DUPLICATE = "A department with this name already exists.";
const STATUS_INVALID = "Status must be ACTIVE or INACTIVE.";
const NOT_FOUND = "Department not found.";
const IDS_INVALID = "departmentIds must be an array of department IDs.";
const PRIMARY_INVALID =
  "Primary department must be one of the employee's departments.";
const INACTIVE_ASSIGN =
  "Only active departments can be newly assigned.";
const PROFILE_SK = "PROFILE";

const SEED_DEPARTMENTS = [
  {
    departmentId: "it-software-development",
    name: "IT — Software Development",
    description:
      "Client websites, web applications, mobile applications, APIs, cloud infrastructure and technical support",
  },
  {
    departmentId: "ai-automation",
    name: "AI & Automation",
    description:
      "AI agents, LLM integrations, RAG systems, workflow automation and AI solutions",
  },
  {
    departmentId: "seo-digital-marketing",
    name: "SEO & Digital Marketing",
    description:
      "SEO, content marketing, social media, paid advertising and website growth",
  },
  {
    departmentId: "ecommerce-product-operations",
    name: "Ecommerce & Product Operations",
    description:
      "Internal ecommerce products, product catalogs, vendor coordination, orders and operations",
  },
  {
    departmentId: "sales-business-development",
    name: "Sales & Business Development",
    description:
      "Lead generation, client acquisition, proposals, quotations and partnerships",
  },
  {
    departmentId: "project-management-client-services",
    name: "Project Management & Client Services",
    description:
      "Project planning, client communication, requirements gathering, delivery coordination and quality assurance",
  },
  {
    departmentId: "human-resources-administration",
    name: "Human Resources & Administration",
    description:
      "Recruitment, employee management, attendance, training and administration",
  },
  {
    departmentId: "finance-accounting",
    name: "Finance & Accounting",
    description:
      "Invoicing, payments, accounting, budgeting, financial reporting and cost management",
  },
];

function normalizePath(path) {
  return String(path || "").replace(/\/+$/, "");
}

function departmentSk(id) {
  return `DEPARTMENT#${id}`;
}

function departmentNameSk(nameKey) {
  return `NAME#${nameKey}`;
}

function userPk(email) {
  return `USER#${email}`;
}

function displayDepartmentName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeDepartmentNameKey(name) {
  return displayDepartmentName(name)
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

function publicDepartmentsPathMatch(path) {
  const normalized = normalizePath(path);
  return /\/departments$/.test(normalized) && !/\/admin\/departments$/.test(normalized);
}

function adminDepartmentsPathMatch(path) {
  return /\/admin\/departments$/.test(normalizePath(path));
}

function departmentStatusPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  const fromParams = pathParameters?.departmentId
    ? String(pathParameters.departmentId)
    : "";
  if (
    fromParams &&
    /\/admin\/departments\/[^/]+\/status$/.test(normalized)
  ) {
    return decodeSegment(fromParams);
  }
  const match = normalized.match(/\/admin\/departments\/([^/]+)\/status$/);
  if (!match) return null;
  return decodeSegment(match[1]);
}

function departmentIdPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  if (/\/status$/.test(normalized)) return null;
  const fromParams = pathParameters?.departmentId
    ? String(pathParameters.departmentId)
    : "";
  if (fromParams && /\/admin\/departments\/[^/]+$/.test(normalized)) {
    return decodeSegment(fromParams);
  }
  const match = normalized.match(/\/admin\/departments\/([^/]+)$/);
  if (!match) return null;
  return decodeSegment(match[1]);
}

function membershipPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  const fromParams = pathParameters?.email ? String(pathParameters.email) : "";
  if (fromParams && /\/admin\/employees\/[^/]+\/departments$/.test(normalized)) {
    const decoded = decodeSegment(fromParams);
    if (!decoded.ok) return decoded;
    return { ok: true, value: normalizeEmail(decoded.value) };
  }
  const match = normalized.match(/\/admin\/employees\/([^/]+)\/departments$/);
  if (!match) return null;
  const decoded = decodeSegment(match[1]);
  if (!decoded.ok) return decoded;
  return { ok: true, value: normalizeEmail(decoded.value) };
}

function parseDepartmentName(raw) {
  const name = displayDepartmentName(raw);
  if (!name) return { ok: false, error: NAME_REQUIRED };
  if (name.length > NAME_MAX) {
    return {
      ok: false,
      error: `Department name must be at most ${NAME_MAX} characters.`,
    };
  }
  return { ok: true, value: name, nameKey: normalizeDepartmentNameKey(name) };
}

function parseDescription(raw) {
  if (raw == null) return { ok: true, value: "" };
  const description = String(raw).trim();
  if (description.length > DESCRIPTION_MAX) {
    return {
      ok: false,
      error: `Description must be at most ${DESCRIPTION_MAX} characters.`,
    };
  }
  return { ok: true, value: description };
}

function parseStatus(raw) {
  const status = String(raw || "").trim().toUpperCase();
  if (status !== STATUS_ACTIVE && status !== STATUS_INACTIVE) {
    return { ok: false, error: STATUS_INVALID };
  }
  return { ok: true, value: status };
}

function isConditionalCheckFailed(err) {
  return (
    err?.name === "ConditionalCheckFailedException" ||
    err?.code === "ConditionalCheckFailedException"
  );
}

function transactReasons(err) {
  return err?.CancellationReasons || err?.cancellationReasons || [];
}

function transactFailedAt(err, index) {
  const row = transactReasons(err)[index] || {};
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

async function scanAll(ddb, tableName) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function getDepartmentItem(ddb, tableName, departmentId) {
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

async function getNamePointer(ddb, tableName, nameKey) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: DEPARTMENT_NAME_PK, SK: departmentNameSk(nameKey) },
    })
  );
  return res.Item || null;
}

function publicDepartment(item, employeeCount) {
  if (!item || item.type !== TYPE_DEPARTMENT) return null;
  const row = {
    departmentId: item.departmentId,
    name: item.name,
    description: item.description || "",
    status: item.status,
    createdAt: item.createdAt || null,
    createdBy: item.createdBy || null,
    updatedAt: item.updatedAt || null,
    updatedBy: item.updatedBy || null,
  };
  if (employeeCount !== undefined) row.employeeCount = employeeCount;
  return row;
}

async function listDepartmentItems(ddb, tableName) {
  return queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": DEPARTMENT_ENTITY_PK,
      ":sk": "DEPARTMENT#",
    },
  });
}

async function ensureSeedDepartments({ ddb, tableName, nowIso, actor }) {
  const now = nowIso || new Date().toISOString();
  const createdBy = actor || "SYSTEM";
  for (const seed of SEED_DEPARTMENTS) {
    const parsed = parseDepartmentName(seed.name);
    const item = {
      PK: DEPARTMENT_ENTITY_PK,
      SK: departmentSk(seed.departmentId),
      type: TYPE_DEPARTMENT,
      departmentId: seed.departmentId,
      name: parsed.value,
      nameKey: parsed.nameKey,
      description: seed.description,
      status: STATUS_ACTIVE,
      createdAt: now,
      createdBy,
      updatedAt: now,
      updatedBy: createdBy,
    };
    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(PK)",
        })
      );
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }
    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: DEPARTMENT_NAME_PK,
            SK: departmentNameSk(parsed.nameKey),
            type: TYPE_DEPARTMENT_NAME,
            departmentId: seed.departmentId,
            nameKey: parsed.nameKey,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        })
      );
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }
  }
}

async function countMembersByDepartment(ddb, profileTable) {
  const counts = new Map();
  if (!profileTable) return counts;
  const items = await scanAll(ddb, profileTable);
  for (const item of items) {
    if (item.SK !== PROFILE_SK) continue;
    const ids = Array.isArray(item.departmentIds) ? item.departmentIds : [];
    for (const id of new Set(ids.map((value) => String(value || "").trim()).filter(Boolean))) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

async function requireDepartmentAdmin({ user, ddb, accessTable }) {
  return requireEligiblePortalAdmin({ user, ddb, accessTable });
}

function requireSignedIn(user) {
  const email = normalizeEmail(user?.email);
  if (!email) return { statusCode: 401, body: { error: "Unauthorized" } };
  return { ok: true, email };
}

async function handleListPublicDepartments({ user, ddb, tableName, nowIso }) {
  const auth = requireSignedIn(user);
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  await ensureSeedDepartments({ ddb, tableName, nowIso, actor: "SYSTEM" });
  const items = await listDepartmentItems(ddb, tableName);
  const departments = items
    .map((item) => publicDepartment(item))
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { statusCode: 200, body: { departments } };
}

async function handleListDepartments({
  user,
  ddb,
  tableName,
  accessTable,
  profileTable,
  nowIso,
}) {
  const auth = await requireDepartmentAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  await ensureSeedDepartments({
    ddb,
    tableName,
    nowIso,
    actor: auth.email,
  });
  const [items, counts] = await Promise.all([
    listDepartmentItems(ddb, tableName),
    countMembersByDepartment(ddb, profileTable),
  ]);
  const departments = items
    .map((item) => publicDepartment(item, counts.get(item.departmentId) || 0))
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { statusCode: 200, body: { departments } };
}

async function handleCreateDepartment({
  user,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
}) {
  const auth = await requireDepartmentAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const parsedName = parseDepartmentName(body?.name);
  if (!parsedName.ok) return { statusCode: 400, body: { error: parsedName.error } };
  const description = parseDescription(body?.description);
  if (!description.ok) return { statusCode: 400, body: { error: description.error } };
  const departmentId = randomUUID();
  const now = nowIso || new Date().toISOString();
  const item = {
    PK: DEPARTMENT_ENTITY_PK,
    SK: departmentSk(departmentId),
    type: TYPE_DEPARTMENT,
    departmentId,
    name: parsedName.value,
    nameKey: parsedName.nameKey,
    description: description.value,
    status: STATUS_ACTIVE,
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
                PK: DEPARTMENT_NAME_PK,
                SK: departmentNameSk(parsedName.nameKey),
                type: TYPE_DEPARTMENT_NAME,
                departmentId,
                nameKey: parsedName.nameKey,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      })
    );
  } catch (err) {
    if (
      isConditionalCheckFailed(err) ||
      transactFailedAt(err, 1) ||
      transactFailedAt(err, 0)
    ) {
      return { statusCode: 409, body: { error: NAME_DUPLICATE } };
    }
    throw err;
  }
  return { statusCode: 201, body: { department: publicDepartment(item, 0) } };
}

async function handlePatchDepartment({
  user,
  departmentId,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
}) {
  const auth = await requireDepartmentAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const id = String(departmentId || "").trim();
  if (!id) return { statusCode: 400, body: { error: "departmentId required" } };
  const existing = await getDepartmentItem(ddb, tableName, id);
  if (!existing) return { statusCode: 404, body: { error: NOT_FOUND } };
  if (body?.status !== undefined) {
    return {
      statusCode: 400,
      body: { error: "Use the status endpoint to activate or deactivate a department." },
    };
  }
  const nextName =
    body?.name !== undefined
      ? parseDepartmentName(body.name)
      : {
          ok: true,
          value: existing.name,
          nameKey: existing.nameKey || normalizeDepartmentNameKey(existing.name),
        };
  if (!nextName.ok) return { statusCode: 400, body: { error: nextName.error } };
  const description =
    body?.description !== undefined
      ? parseDescription(body.description)
      : { ok: true, value: existing.description || "" };
  if (!description.ok) return { statusCode: 400, body: { error: description.error } };
  const now = nowIso || new Date().toISOString();
  const item = {
    ...existing,
    name: nextName.value,
    nameKey: nextName.nameKey,
    description: description.value,
    updatedAt: now,
    updatedBy: auth.email,
  };
  const oldKey = existing.nameKey || normalizeDepartmentNameKey(existing.name);
  const renamed = oldKey !== nextName.nameKey;
  try {
    if (!renamed) {
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
                  PK: DEPARTMENT_NAME_PK,
                  SK: departmentNameSk(nextName.nameKey),
                  type: TYPE_DEPARTMENT_NAME,
                  departmentId: id,
                  nameKey: nextName.nameKey,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: {
                  PK: DEPARTMENT_NAME_PK,
                  SK: departmentNameSk(oldKey),
                },
                ConditionExpression:
                  "attribute_exists(PK) AND departmentId = :departmentId",
                ExpressionAttributeValues: { ":departmentId": id },
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
    if (!renamed && isConditionalCheckFailed(err)) {
      return { statusCode: 404, body: { error: NOT_FOUND } };
    }
    if (transactFailedAt(err, 0)) {
      return { statusCode: 409, body: { error: NAME_DUPLICATE } };
    }
    throw err;
  }
  return { statusCode: 200, body: { department: publicDepartment(item) } };
}

async function handleDepartmentStatus({
  user,
  departmentId,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
}) {
  const auth = await requireDepartmentAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const id = String(departmentId || "").trim();
  if (!id) return { statusCode: 400, body: { error: "departmentId required" } };
  const parsed = parseStatus(body?.status);
  if (!parsed.ok) return { statusCode: 400, body: { error: parsed.error } };
  const existing = await getDepartmentItem(ddb, tableName, id);
  if (!existing) return { statusCode: 404, body: { error: NOT_FOUND } };
  const now = nowIso || new Date().toISOString();
  const item = {
    ...existing,
    status: parsed.value,
    updatedAt: now,
    updatedBy: auth.email,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: "attribute_exists(PK)",
      })
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { statusCode: 404, body: { error: NOT_FOUND } };
    }
    throw err;
  }
  return { statusCode: 200, body: { department: publicDepartment(item) } };
}

function existingDepartmentIds(profile) {
  if (!Array.isArray(profile?.departmentIds)) return [];
  return profile.departmentIds.map((id) => String(id || "").trim()).filter(Boolean);
}

/**
 * Validate a membership update.
 * New IDs must reference an ACTIVE department.
 * IDs already stored may stay even when that department is inactive.
 * Primary must be one of the resulting IDs, or empty when there are none.
 */
function resolveMembership({
  departmentIds,
  primaryDepartmentId,
  existingIds = [],
  departmentsById,
}) {
  if (!Array.isArray(departmentIds)) {
    return { ok: false, error: IDS_INVALID };
  }
  const seen = new Set();
  const ids = [];
  for (const raw of departmentIds) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const department = departmentsById.get(id);
    if (!department) return { ok: false, error: NOT_FOUND };
    const already = existingIds.includes(id);
    const active = String(department.status || "").toUpperCase() === STATUS_ACTIVE;
    if (!already && !active) return { ok: false, error: INACTIVE_ASSIGN };
    ids.push(id);
  }
  let primary = String(primaryDepartmentId || "").trim();
  if (!ids.length) {
    if (primary) return { ok: false, error: PRIMARY_INVALID };
    primary = "";
  } else if (!primary) {
    const kept = existingIds.find((id) => ids.includes(id));
    primary = kept || ids[0];
  } else if (!ids.includes(primary)) {
    return { ok: false, error: PRIMARY_INVALID };
  }
  return { ok: true, departmentIds: ids, primaryDepartmentId: primary };
}

async function loadDepartmentsById(ddb, tableName, ids) {
  const map = new Map();
  for (const id of ids) {
    if (map.has(id)) continue;
    const item = await getDepartmentItem(ddb, tableName, id);
    if (item) map.set(id, item);
  }
  return map;
}

async function getProfileItem(ddb, profileTable, email) {
  const res = await ddb.send(
    new GetCommand({
      TableName: profileTable,
      Key: { PK: userPk(email), SK: PROFILE_SK },
    })
  );
  return res.Item || null;
}

function membershipBody(profile, departmentsById) {
  const departmentIds = existingDepartmentIds(profile);
  const primary = String(profile?.primaryDepartmentId || "").trim();
  return {
    email: profile?.email || "",
    departmentIds,
    primaryDepartmentId: departmentIds.includes(primary) ? primary : departmentIds[0] || "",
    legacyDepartment: "",
    departmentDesignations: orgDesignations.existingLinks(profile),
    departments: departmentIds.map((id) => {
      const item = departmentsById.get(id);
      return item
        ? publicDepartment(item)
        : {
            departmentId: id,
            name: id,
            description: "",
            status: "MISSING",
          };
    }),
  };
}

async function handleGetMembership({
  user,
  email,
  ddb,
  tableName,
  accessTable,
  profileTable,
}) {
  const auth = await requireDepartmentAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const target = normalizeEmail(email);
  if (!target) return { statusCode: 400, body: { error: "email required" } };
  const profile = await getProfileItem(ddb, profileTable, target);
  if (!profile) return { statusCode: 404, body: { error: "Employee not found." } };
  const ids = existingDepartmentIds(profile);
  const departmentsById = await loadDepartmentsById(ddb, tableName, ids);
  const membership = membershipBody({ ...profile, email: target }, departmentsById);
  const rates = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: userPk(target), SK: "COST_RATES" },
    })
  );
  membership.costingDesignationId = rates.Item?.designationId || "";
  return { statusCode: 200, body: { membership } };
}

async function handlePutMembership({
  user,
  email,
  body,
  ddb,
  tableName,
  accessTable,
  profileTable,
  nowIso,
}) {
  const auth = await requireDepartmentAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const target = normalizeEmail(email);
  if (!target) return { statusCode: 400, body: { error: "email required" } };
  const existing = await getProfileItem(ddb, profileTable, target);
  if (!existing) return { statusCode: 404, body: { error: "Employee not found." } };
  const requested = Array.isArray(body?.departmentIds) ? body.departmentIds : null;
  if (!requested) return { statusCode: 400, body: { error: IDS_INVALID } };
  const departmentsById = await loadDepartmentsById(ddb, tableName, [
    ...requested,
    ...existingDepartmentIds(existing),
  ]);
  const resolved = resolveMembership({
    departmentIds: requested,
    primaryDepartmentId: body?.primaryDepartmentId,
    existingIds: existingDepartmentIds(existing),
    departmentsById,
  });
  if (!resolved.ok) return { statusCode: 400, body: { error: resolved.error } };
  let departmentDesignations = orgDesignations
    .existingLinks(existing)
    .filter((row) => resolved.departmentIds.includes(row.departmentId));
  if (Object.prototype.hasOwnProperty.call(body || {}, "departmentDesignations")) {
    const linked = await orgDesignations.resolveDepartmentDesignations({
      ddb,
      tableName,
      departmentIds: resolved.departmentIds,
      requested: body.departmentDesignations,
      existingProfile: existing,
    });
    if (!linked.ok) return { statusCode: 400, body: { error: linked.error } };
    departmentDesignations = linked.departmentDesignations;
  }
  const costing = await costingDesignation.syncCostingDesignation({
    ddb,
    tableName,
    email: target,
    links: departmentDesignations,
    requested: Object.prototype.hasOwnProperty.call(body || {}, "costingDesignationId")
      ? body.costingDesignationId
      : undefined,
    nowIso,
    actor: auth.email,
  });
  if (!costing.ok) return { statusCode: 400, body: { error: costing.error } };
  const now = nowIso || new Date().toISOString();
  const item = {
    ...existing,
    PK: userPk(target),
    SK: PROFILE_SK,
    email: target,
    departmentIds: resolved.departmentIds,
    primaryDepartmentId: resolved.primaryDepartmentId,
    departmentDesignations,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: profileTable, Item: item }));
  const refreshed = await loadDepartmentsById(ddb, tableName, resolved.departmentIds);
  const membership = membershipBody(item, refreshed);
  membership.costingDesignationId = costing.designationId || "";
  return {
    statusCode: 200,
    body: { membership },
  };
}

function planProfileDepartmentMigration(profile, departments) {
  const legacy = String(profile?.department || "").trim();
  if (Array.isArray(profile?.departmentIds)) {
    return { action: "skip", reason: "membership-already-set" };
  }
  if (
    profile?.departmentMigration?.status === "UNMATCHED" &&
    profile.departmentMigration.source === legacy
  ) {
    return { action: "skip", reason: "already-unmatched" };
  }
  if (!legacy) return { action: "skip", reason: "no-legacy-department" };
  const key = normalizeDepartmentNameKey(legacy);
  const matches = (departments || []).filter(
    (department) => normalizeDepartmentNameKey(department.name) === key
  );
  if (matches.length > 1) {
    return { action: "review", reason: "ambiguous-name", source: legacy };
  }
  if (matches.length === 1) {
    return {
      action: "match",
      departmentIds: [matches[0].departmentId],
      primaryDepartmentId: matches[0].departmentId,
      departmentMigration: {
        status: "MATCHED",
        source: legacy,
        matchedDepartmentId: matches[0].departmentId,
      },
    };
  }
  return {
    action: "unmatched",
    departmentMigration: { status: "UNMATCHED", source: legacy },
  };
}

function migrationPatch(plan, nowIso) {
  const migratedAt = nowIso || new Date().toISOString();
  if (plan?.action === "match") {
    return {
      departmentIds: plan.departmentIds,
      primaryDepartmentId: plan.primaryDepartmentId,
      departmentMigration: { ...plan.departmentMigration, migratedAt },
    };
  }
  if (plan?.action === "unmatched" || plan?.action === "review") {
    return {
      departmentMigration: {
        status: "UNMATCHED",
        source: plan.source || plan.departmentMigration?.source || "",
        reason: plan.reason || plan.departmentMigration?.reason || "unmatched",
        migratedAt,
      },
    };
  }
  return null;
}

function profileFieldsForActor({ isAdmin, profileData }) {
  const data = { ...(profileData || {}) };
  delete data.PK;
  delete data.SK;
  delete data.profileImageUrl;
  delete data.imageStorageUrl;
  if (!isAdmin) {
    delete data.department;
    delete data.departmentIds;
    delete data.primaryDepartmentId;
    delete data.departmentDesignations;
    delete data.costingDesignationId;
    delete data.departmentMigration;
  }
  return data;
}

function mergeProfileForSave({
  existing,
  profileData,
  email,
  membership,
  nowIso,
}) {
  const data = { ...(profileData || {}) };
  delete data.department;
  delete data.designation;
  if (data.resignations == null && Array.isArray(existing?.resignations)) {
    delete data.resignations;
  }
  const item = {
    ...(existing || {}),
    ...data,
    PK: userPk(email),
    SK: PROFILE_SK,
    email,
    updatedAt: nowIso || new Date().toISOString(),
  };
  if (Object.prototype.hasOwnProperty.call(data, "skill")) {
    item.skill = data.skill ? String(data.skill).trim().toUpperCase() : data.skill;
  }
  if (membership) {
    item.departmentIds = membership.departmentIds;
    item.primaryDepartmentId = membership.primaryDepartmentId;
    if (membership.departmentDesignations) {
      item.departmentDesignations = membership.departmentDesignations;
    }
  }
  return item;
}

module.exports = {
  DEPARTMENT_ENTITY_PK,
  DEPARTMENT_NAME_PK,
  NAME_DUPLICATE,
  INACTIVE_ASSIGN,
  PRIMARY_INVALID,
  NOT_FOUND,
  SEED_DEPARTMENTS,
  STATUS_ACTIVE,
  STATUS_INACTIVE,
  adminDepartmentsPathMatch,
  departmentIdPathMatch,
  departmentStatusPathMatch,
  ensureSeedDepartments,
  getDepartmentItem,
  getNamePointer,
  handleCreateDepartment,
  handleDepartmentStatus,
  handleGetMembership,
  handleListDepartments,
  handleListPublicDepartments,
  handlePatchDepartment,
  handlePutMembership,
  membershipPathMatch,
  mergeProfileForSave,
  normalizeDepartmentNameKey,
  migrationPatch,
  planProfileDepartmentMigration,
  profileFieldsForActor,
  publicDepartmentsPathMatch,
  resolveMembership,
};

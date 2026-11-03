const { GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const orgDesignations = require("./departmentDesignations");
const { normalizeEmail } = require("./projectAccess");
const {
  OWNER_EMPLOYEE,
  versionPutsForMutation,
} = require("./costRateVersions");

const COST_RATES_SK = "COST_RATES";
const TYPE_EMPLOYEE_COST_RATES = "EMPLOYEE_COST_RATES";
const COSTING_NOT_ASSIGNED =
  "Costing designation must be an active designation assigned to this employee.";
const COSTING_CHOICE_REQUIRED =
  "Choose an assigned costing designation or clear it. The current costing designation is no longer an active assignment.";

function userPk(email) {
  return `USER#${normalizeEmail(email)}`;
}

function activeAssignedPairs(links, designationById) {
  const pairs = [];
  const seen = new Set();
  for (const link of links || []) {
    const departmentId = String(link?.departmentId || "").trim();
    const designationId = String(link?.designationId || "").trim();
    if (!departmentId || !designationId || seen.has(designationId)) continue;
    const designation = designationById.get(designationId);
    if (!designation || designation.departmentId !== departmentId) continue;
    if (String(designation.status || "").toUpperCase() !== "ACTIVE") continue;
    seen.add(designationId);
    pairs.push({ departmentId, designationId });
  }
  return pairs;
}

/**
 * Decide the costing designation from assigned pairs.
 * One active pair defaults only when costing is currently empty.
 * Several pairs never imply a choice. An invalid current value is kept
 * only when the caller explicitly replaces or clears it.
 */
function planCostingDesignation({
  links,
  designationById,
  currentDesignationId,
  requested,
}) {
  const active = activeAssignedPairs(links, designationById);
  const current = String(currentDesignationId || "").trim();
  const explicit = requested !== undefined;
  if (!explicit) {
    if (!current) {
      if (active.length === 1) {
        return { ok: true, designationId: active[0].designationId, changed: true };
      }
      return { ok: true, designationId: "", changed: false };
    }
    if (active.some((row) => row.designationId === current)) {
      return { ok: true, designationId: current, changed: false };
    }
    return { ok: false, error: COSTING_CHOICE_REQUIRED };
  }
  const requestedId = String(requested || "").trim();
  if (!requestedId) {
    return { ok: true, designationId: "", changed: current !== "" };
  }
  if (!active.some((row) => row.designationId === requestedId)) {
    return { ok: false, error: COSTING_NOT_ASSIGNED };
  }
  return { ok: true, designationId: requestedId, changed: requestedId !== current };
}

async function getEmployeeRatesItem(ddb, tableName, email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: userPk(e), SK: COST_RATES_SK },
    })
  );
  return res.Item || null;
}

async function loadDesignations(ddb, tableName, links) {
  const designationById = new Map();
  for (const link of links || []) {
    const id = String(link?.designationId || "").trim();
    if (!id || designationById.has(id)) continue;
    const item = await orgDesignations.getDesignation(ddb, tableName, id);
    if (item) designationById.set(id, item);
  }
  return designationById;
}

async function writeCostingDesignation({
  ddb,
  tableName,
  email,
  existing,
  designationId,
  nowIso,
  actor,
}) {
  const target = normalizeEmail(email);
  const now = nowIso || new Date().toISOString();
  const item = {
    PK: userPk(target),
    SK: COST_RATES_SK,
    type: TYPE_EMPLOYEE_COST_RATES,
    email: target,
    designationId: designationId || null,
    internalHourlyRate: existing?.internalHourlyRate ?? null,
    externalHourlyRate: existing?.externalHourlyRate ?? null,
    status: existing?.status || "ACTIVE",
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || actor || "",
    updatedAt: now,
    updatedBy: actor || "",
  };
  const versionPuts = await versionPutsForMutation({
    ddb,
    tableName,
    ownerType: OWNER_EMPLOYEE,
    ownerId: target,
    existingItem: existing,
    nextSnapshot: item,
    nowIso: now,
    actor: actor || "",
  });
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tableName, Item: item } },
        ...versionPuts,
      ],
    })
  );
  return item;
}

async function syncCostingDesignation({
  ddb,
  tableName,
  email,
  links,
  requested,
  nowIso,
  actor,
}) {
  const existing = await getEmployeeRatesItem(ddb, tableName, email);
  const designationById = await loadDesignations(ddb, tableName, links);
  const current = existing?.designationId;
  if (current && !designationById.has(String(current))) {
    const currentItem = await orgDesignations.getDesignation(ddb, tableName, current);
    if (currentItem) designationById.set(String(current), currentItem);
  }
  const plan = planCostingDesignation({
    links,
    designationById,
    currentDesignationId: current,
    requested,
  });
  if (!plan.ok) return plan;
  if (!plan.changed || (!existing && !plan.designationId)) {
    return { ok: true, designationId: plan.designationId || "" };
  }
  await writeCostingDesignation({
    ddb,
    tableName,
    email,
    existing,
    designationId: plan.designationId,
    nowIso,
    actor,
  });
  return { ok: true, designationId: plan.designationId || "" };
}

module.exports = {
  COSTING_CHOICE_REQUIRED,
  COSTING_NOT_ASSIGNED,
  activeAssignedPairs,
  planCostingDesignation,
  syncCostingDesignation,
};

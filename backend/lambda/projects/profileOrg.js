const { QueryCommand } = require("@aws-sdk/lib-dynamodb");

const DEPARTMENT_PK = "ENTITY#DEPARTMENT";
const DESIGNATION_PK = "ENTITY#ORG_DESIGNATION";

function clean(value) {
  return String(value || "").trim();
}

function departmentIdsOf(profile) {
  if (!Array.isArray(profile?.departmentIds)) return [];
  const seen = new Set();
  const ids = [];
  for (const raw of profile.departmentIds) {
    const id = clean(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function orderedDepartmentIds(profile) {
  const ids = departmentIdsOf(profile);
  const primary = clean(profile?.primaryDepartmentId);
  if (primary && ids.includes(primary)) {
    return [primary, ...ids.filter((id) => id !== primary)];
  }
  return ids;
}

function designationLinks(profile) {
  if (!Array.isArray(profile?.departmentDesignations)) return [];
  const seen = new Set();
  const links = [];
  for (const row of profile.departmentDesignations) {
    const departmentId = clean(row?.departmentId);
    const designationId = clean(row?.designationId);
    if (!departmentId || !designationId) continue;
    const key = `${departmentId}\0${designationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ departmentId, designationId });
  }
  return links;
}

function catalogDepartments(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || (row.type && row.type !== "DEPARTMENT")) continue;
    const departmentId = clean(row.departmentId);
    const name = clean(row.name);
    if (!departmentId || !name || map.has(departmentId)) continue;
    map.set(departmentId, { departmentId, name, status: clean(row.status).toUpperCase() });
  }
  return map;
}

function catalogDesignations(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || (row.type && row.type !== "ORG_DESIGNATION")) continue;
    const designationId = clean(row.designationId);
    const departmentId = clean(row.departmentId);
    const name = clean(row.name);
    if (!designationId || !departmentId || !name || map.has(designationId)) continue;
    map.set(designationId, {
      designationId,
      departmentId,
      name,
      status: clean(row.status).toUpperCase(),
      track: clean(row.track),
    });
  }
  return map;
}

function resolveProfileOrg(profile, departments, designations) {
  const deptById = catalogDepartments(departments);
  const desById = catalogDesignations(designations);
  const ids = orderedDepartmentIds(profile);
  const allowed = new Set(ids);
  const departmentNames = [];
  for (const id of ids) {
    const row = deptById.get(id);
    if (row) departmentNames.push(row.name);
  }
  const primaryId = ids[0] || "";
  const links = designationLinks(profile).filter((link) => allowed.has(link.departmentId));
  const ordered = [
    ...links.filter((link) => link.departmentId === primaryId),
    ...links.filter((link) => link.departmentId !== primaryId),
  ];
  const designationNames = [];
  for (const link of ordered) {
    const row = desById.get(link.designationId);
    if (!row || row.departmentId !== link.departmentId) continue;
    designationNames.push(row.name);
  }
  return {
    department: departmentNames.join(", "),
    designation: designationNames.join(", "),
    departmentNames,
    designationNames,
  };
}

async function queryPartition(ddb, tableName, pk, skPrefix) {
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

async function loadOrgCatalogs(ddb, tableName) {
  if (!ddb || !tableName) return { departments: [], designations: [] };
  const [departments, designations] = await Promise.all([
    queryPartition(ddb, tableName, DEPARTMENT_PK, "DEPARTMENT#"),
    queryPartition(ddb, tableName, DESIGNATION_PK, "DESIGNATION#"),
  ]);
  return { departments, designations };
}

async function labelsForProfile(ddb, tableName, profile) {
  const catalogs = await loadOrgCatalogs(ddb, tableName);
  return resolveProfileOrg(profile, catalogs.departments, catalogs.designations);
}

module.exports = {
  departmentIdsOf,
  designationLinks,
  labelsForProfile,
  loadOrgCatalogs,
  resolveProfileOrg,
};

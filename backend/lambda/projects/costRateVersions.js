const { randomUUID } = require("crypto");
const { PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const TYPE_COST_RATE_VERSION = "COST_RATE_VERSION";
const OWNER_DESIGNATION = "DESIGNATION";
const OWNER_EMPLOYEE = "EMPLOYEE";
const RATEVER_PREFIX = "RATEVER#";
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

function userPk(email) {
  return `USER#${email}`;
}

function designationVersionPk(designationId) {
  return `DESIGNATION#${designationId}`;
}

function versionSk(effectiveFrom, versionId) {
  return `${RATEVER_PREFIX}${effectiveFrom}#${versionId}`;
}

function ownerPk(ownerType, ownerId) {
  return ownerType === OWNER_DESIGNATION
    ? designationVersionPk(ownerId)
    : userPk(ownerId);
}

function ratesSnapshotFromItem(item = {}) {
  return {
    internalHourlyRate:
      item.internalHourlyRate == null ? null : item.internalHourlyRate,
    externalHourlyRate:
      item.externalHourlyRate == null ? null : item.externalHourlyRate,
    status: item.status || "ACTIVE",
    designationId: item.designationId || null,
  };
}

function ratesDiffer(left, right) {
  const a = ratesSnapshotFromItem(left);
  const b = ratesSnapshotFromItem(right);
  return (
    a.internalHourlyRate !== b.internalHourlyRate ||
    a.externalHourlyRate !== b.externalHourlyRate ||
    a.status !== b.status ||
    String(a.designationId || "") !== String(b.designationId || "")
  );
}

function buildVersionItem({
  ownerType,
  ownerId,
  snapshot,
  effectiveFrom,
  createdAt,
  createdBy,
  versionId,
}) {
  const id = versionId || randomUUID();
  const from = effectiveFrom || createdAt;
  return {
    PK: ownerPk(ownerType, ownerId),
    SK: versionSk(from, id),
    type: TYPE_COST_RATE_VERSION,
    ownerType,
    ownerId,
    versionId: id,
    effectiveFrom: from,
    currency: "USD",
    internalHourlyRate: snapshot.internalHourlyRate ?? null,
    externalHourlyRate: snapshot.externalHourlyRate ?? null,
    status: snapshot.status || "ACTIVE",
    designationId: snapshot.designationId || null,
    createdAt: createdAt || from,
    createdBy: createdBy || "",
  };
}

async function listRateVersions(ddb, tableName, ownerType, ownerId) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": ownerPk(ownerType, ownerId),
          ":sk": RATEVER_PREFIX,
        },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

function compareVersions(a, b) {
  const fromA = String(a.effectiveFrom || "");
  const fromB = String(b.effectiveFrom || "");
  if (fromA !== fromB) return fromA < fromB ? -1 : 1;
  const createdA = String(a.createdAt || "");
  const createdB = String(b.createdAt || "");
  if (createdA !== createdB) return createdA < createdB ? -1 : 1;
  return String(a.versionId || "").localeCompare(String(b.versionId || ""));
}

/**
 * Inclusive start: a version is effective at `atIso` when effectiveFrom <= atIso
 * and no later version has effectiveFrom <= atIso.
 * Do not filter on createdAt: bootstrap rows may be written after the
 * historical period they represent. Same effectiveFrom is resolved by
 * createdAt then versionId so the last written row at that instant wins.
 */
function pickEffectiveVersion(versions, atIso) {
  const at = String(atIso || "");
  const eligible = (versions || []).filter(
    (item) => String(item.effectiveFrom || "") <= at
  );
  if (!eligible.length) return null;
  eligible.sort(compareVersions);
  return eligible[eligible.length - 1];
}

function catalogAsVersion(item, ownerType, ownerId) {
  if (!item) return null;
  return buildVersionItem({
    ownerType,
    ownerId,
    snapshot: ratesSnapshotFromItem(item),
    effectiveFrom: item.createdAt || EPOCH_ISO,
    createdAt: item.createdAt || EPOCH_ISO,
    createdBy: item.createdBy || "",
    versionId: `catalog-${ownerId}`,
  });
}

function versionsOrCatalog(versions, catalogItem, ownerType, ownerId) {
  if (versions && versions.length) return versions;
  const synthetic = catalogAsVersion(catalogItem, ownerType, ownerId);
  return synthetic ? [synthetic] : [];
}

function versionPutOp(tableName, item) {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(PK)",
    },
  };
}

async function versionPutsForMutation({
  ddb,
  tableName,
  ownerType,
  ownerId,
  existingItem,
  nextSnapshot,
  nowIso,
  actor,
}) {
  const versions = await listRateVersions(ddb, tableName, ownerType, ownerId);
  const puts = [];
  const next = ratesSnapshotFromItem(nextSnapshot);
  const changed = !existingItem || ratesDiffer(existingItem, next);
  if (!changed && versions.length) return puts;

  if (!versions.length && existingItem) {
    const bootstrapFrom =
      existingItem.createdAt && existingItem.createdAt < nowIso
        ? existingItem.createdAt
        : EPOCH_ISO;
    puts.push(
      versionPutOp(
        tableName,
        buildVersionItem({
          ownerType,
          ownerId,
          snapshot: ratesSnapshotFromItem(existingItem),
          effectiveFrom: bootstrapFrom,
          createdAt: nowIso,
          createdBy: actor,
        })
      )
    );
  }

  if (changed || !versions.length) {
    puts.push(
      versionPutOp(
        tableName,
        buildVersionItem({
          ownerType,
          ownerId,
          snapshot: next,
          effectiveFrom: nowIso,
          createdAt: nowIso,
          createdBy: actor,
        })
      )
    );
  }
  return puts;
}

function singlePut(tableName, item, condition, values) {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ...(condition
        ? {
            ConditionExpression: condition,
            ...(values ? { ExpressionAttributeValues: values } : {}),
          }
        : {}),
    },
  };
}

async function transactPuts(ddb, items) {
  if (!items.length) return;
  const { TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: items,
    })
  );
}

module.exports = {
  TYPE_COST_RATE_VERSION,
  OWNER_DESIGNATION,
  OWNER_EMPLOYEE,
  RATEVER_PREFIX,
  EPOCH_ISO,
  userPk,
  designationVersionPk,
  versionSk,
  ratesSnapshotFromItem,
  ratesDiffer,
  buildVersionItem,
  listRateVersions,
  pickEffectiveVersion,
  catalogAsVersion,
  versionsOrCatalog,
  versionPutsForMutation,
  versionPutOp,
  singlePut,
  transactPuts,
  PutCommand,
};

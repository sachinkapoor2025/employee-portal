const {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  AUDIT_ELIGIBILITY,
  IMPORT_STATUSES,
  META_SK,
  TYPE_TASK_IMPORT,
  TYPE_TASK_IMPORT_AUDIT_WAIT,
  WAIT_PK,
  auditWaitSk,
  buildAuditS3Key,
  buildHoldS3Key,
  importHoldRetentionDays,
  importPk,
  isAuditImportKey,
  isManagedDeletableImportKey,
  isTrustedImportKey,
  parseImportS3Key,
  syncImportHistory,
} = require("./taskImport");

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

const WAITING_PROMOTE_LIMIT = 25;

function isS3NotFound(err) {
  if (!err) return false;
  const status = err.$metadata?.httpStatusCode;
  const name = String(err.name || err.Code || err.code || "");
  return (
    status === 404 ||
    name === "NoSuchKey" ||
    name === "NotFound" ||
    name === "NoSuchBucket"
  );
}

function encodeCopySource(bucket, key) {
  return `${bucket}/${String(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function holdUntilIso(fromIso, nowMs) {
  const start = Date.parse(fromIso || "") || Number(nowMs) || Date.now();
  const days = importHoldRetentionDays();
  return new Date(start + days * 24 * 60 * 60 * 1000).toISOString();
}

async function getMeta(ddb, tableName, batchId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: importPk(batchId), SK: META_SK },
    })
  );
  return res.Item || null;
}

async function objectExists(s3, bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (isS3NotFound(err)) return false;
    throw err;
  }
}

async function copyObject(s3, bucket, fromKey, toKey) {
  if (fromKey === toKey) return true;
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: encodeCopySource(bucket, fromKey),
      Key: toKey,
    })
  );
  return objectExists(s3, bucket, toKey);
}

async function deleteManagedObject(s3, bucket, key, batchId) {
  if (!isManagedDeletableImportKey(key, batchId)) return false;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (isS3NotFound(err)) return true;
    throw err;
  }
}

function evaluateBatchDistribution(_ddb, _tableName, meta) {
  const status = String(meta?.status || "").toUpperCase();
  const failureCount = Number(meta?.failureCount || 0);
  const successCount = Number(meta?.successCount || 0);
  const totalRows = Number(meta?.totalRows || 0);
  if (status !== IMPORT_STATUSES.COMPLETED) {
    return { eligible: false, waiting: false, reason: "not-completed" };
  }
  if (failureCount !== 0 || successCount !== totalRows || totalRows <= 0) {
    return { eligible: false, waiting: false, reason: "incomplete-counts" };
  }
  return { eligible: true, waiting: false, reason: "" };
}

async function putWaitItem(ddb, tableName, meta) {
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: WAIT_PK,
        SK: auditWaitSk(meta.batchId),
        type: TYPE_TASK_IMPORT_AUDIT_WAIT,
        batchId: meta.batchId,
        uploadedBy: meta.uploadedBy || "",
        holdUntil: meta.holdUntil || null,
        updatedAt: meta.updatedAt || new Date().toISOString(),
      },
    })
  );
}

async function clearWaitItem(ddb, tableName, batchId) {
  await ddb.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { PK: WAIT_PK, SK: auditWaitSk(batchId) },
    })
  );
}

async function saveMeta(ddb, tableName, meta) {
  await ddb.send(new PutCommand({ TableName: tableName, Item: meta }));
  await syncImportHistory(ddb, tableName, meta);
}

async function markEligible(ddb, tableName, meta, auditKey, now) {
  const nowIso = now || new Date().toISOString();
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: importPk(meta.batchId), SK: META_SK },
        ConditionExpression:
          "#status = :completed AND (attribute_not_exists(auditEligibility) OR auditEligibility <> :eligible)",
        UpdateExpression:
          "SET auditEligibility = :eligible, s3Key = :s3Key, auditPromotedAt = :now, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":completed": IMPORT_STATUSES.COMPLETED,
          ":eligible": AUDIT_ELIGIBILITY.ELIGIBLE,
          ":s3Key": auditKey,
          ":now": nowIso,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    if (res.Attributes) await syncImportHistory(ddb, tableName, res.Attributes);
    return true;
  } catch (err) {
    if (String(err.name || "") === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

async function ensureCopied(s3, bucket, fromKey, toKey, batchId) {
  if (!isTrustedImportKey(fromKey, batchId) || !isTrustedImportKey(toKey, batchId)) {
    return false;
  }
  if (await objectExists(s3, bucket, toKey)) return true;
  const copied = await copyObject(s3, bucket, fromKey, toKey);
  return Boolean(copied);
}

async function cleanupManagedSource(s3, bucket, key, batchId) {
  if (!key) return;
  await deleteManagedObject(s3, bucket, key, batchId);
}

async function parkForAuditRetry({
  ddb,
  s3,
  tableName,
  bucket,
  meta,
  sourceKey,
  parsed,
  nowIso,
  nowMs,
}) {
  let nextKey = sourceKey;
  if (parsed?.kind === "tmp" && s3 && bucket) {
    const holdKey = buildHoldS3Key(meta.uploadedBy, meta.batchId);
    try {
      const held = await ensureCopied(s3, bucket, sourceKey, holdKey, meta.batchId);
      if (held) {
        nextKey = holdKey;
        await cleanupManagedSource(s3, bucket, sourceKey, meta.batchId);
      }
    } catch {
      /* keep tmp so a later retry can still copy */
    }
  }
  const waiting = {
    ...meta,
    s3Key: nextKey,
    auditEligibility: AUDIT_ELIGIBILITY.WAITING_DISTRIBUTION,
    holdUntil: meta.holdUntil || holdUntilIso(meta.completedAt || nowIso, nowMs),
    updatedAt: nowIso,
  };
  await saveMeta(ddb, tableName, waiting);
  await putWaitItem(ddb, tableName, waiting);
  return {
    ok: false,
    reason: "copy-failed",
    eligibility: AUDIT_ELIGIBILITY.WAITING_DISTRIBUTION,
  };
}

async function promoteImportAudit({
  ddb,
  s3,
  tableName = process.env.WORK_TABLE,
  bucket = process.env.DOCUMENTS_BUCKET,
  batchId,
  now,
  nowMs = Date.now(),
} = {}) {
  if (!ddb || !tableName || !batchId) return { ok: false, reason: "missing-args" };
  const meta = await getMeta(ddb, tableName, batchId);
  if (!meta || meta.type !== TYPE_TASK_IMPORT) {
    return { ok: false, reason: "missing-meta" };
  }
  const nowIso = now || new Date().toISOString();
  const sourceKey = meta.s3Key || "";
  const parsed = parseImportS3Key(sourceKey, meta.batchId);
  const alreadyEligible =
    String(meta.auditEligibility || "").toUpperCase() === AUDIT_ELIGIBILITY.ELIGIBLE &&
    isAuditImportKey(sourceKey, meta.batchId);
  if (alreadyEligible && s3 && bucket && (await objectExists(s3, bucket, sourceKey))) {
    await clearWaitItem(ddb, tableName, meta.batchId);
    return { ok: true, eligibility: AUDIT_ELIGIBILITY.ELIGIBLE };
  }

  const distribution = await evaluateBatchDistribution(ddb, tableName, meta);

  if (String(meta.status || "").toUpperCase() !== IMPORT_STATUSES.COMPLETED) {
    await saveMeta(ddb, tableName, {
      ...meta,
      auditEligibility: AUDIT_ELIGIBILITY.INELIGIBLE,
      updatedAt: nowIso,
    });
    await clearWaitItem(ddb, tableName, meta.batchId);
    return { ok: true, eligibility: AUDIT_ELIGIBILITY.INELIGIBLE };
  }

  if (distribution.eligible) {
    if (!bucket || !s3 || !parsed) {
      return { ok: false, reason: "missing-source" };
    }
    const auditKey = buildAuditS3Key(meta.uploadedBy, meta.batchId);
    let copied = false;
    try {
      copied = await ensureCopied(s3, bucket, sourceKey, auditKey, meta.batchId);
    } catch {
      copied = false;
    }
    if (!copied) {
      return parkForAuditRetry({
        ddb,
        s3,
        tableName,
        bucket,
        meta,
        sourceKey,
        parsed,
        nowIso,
        nowMs,
      });
    }
    const claimed = await markEligible(ddb, tableName, meta, auditKey, nowIso);
    if (
      claimed ||
      String(meta.auditEligibility || "").toUpperCase() === AUDIT_ELIGIBILITY.ELIGIBLE
    ) {
      await clearWaitItem(ddb, tableName, meta.batchId);
      if (sourceKey !== auditKey) {
        await cleanupManagedSource(s3, bucket, sourceKey, meta.batchId);
      }
    }
    return { ok: true, eligibility: AUDIT_ELIGIBILITY.ELIGIBLE };
  }

  await saveMeta(ddb, tableName, {
    ...meta,
    auditEligibility: AUDIT_ELIGIBILITY.INELIGIBLE,
    updatedAt: nowIso,
  });
  await clearWaitItem(ddb, tableName, meta.batchId);
  return { ok: true, eligibility: AUDIT_ELIGIBILITY.INELIGIBLE, reason: distribution.reason };
}

async function cleanupNonEligibleOriginal({
  ddb,
  s3,
  tableName = process.env.WORK_TABLE,
  bucket = process.env.DOCUMENTS_BUCKET,
  meta,
  now,
} = {}) {
  if (!meta?.batchId) return;
  const nowIso = now || new Date().toISOString();
  await saveMeta(ddb, tableName, {
    ...meta,
    auditEligibility: AUDIT_ELIGIBILITY.INELIGIBLE,
    updatedAt: nowIso,
  });
  await clearWaitItem(ddb, tableName, meta.batchId);
  if (s3 && bucket) {
    await cleanupManagedSource(s3, bucket, meta.s3Key, meta.batchId);
  }
}

async function listWaitingBatchIds(ddb, tableName) {
  const items = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": WAIT_PK },
  });
  return (items || [])
    .map((item) => String(item.batchId || "").trim())
    .filter(Boolean)
    .slice(0, WAITING_PROMOTE_LIMIT);
}

async function promoteWaitingImportAudits({
  ddb,
  s3,
  tableName = process.env.WORK_TABLE,
  bucket = process.env.DOCUMENTS_BUCKET,
  now,
  nowMs = Date.now(),
} = {}) {
  if (!ddb || !tableName) return { processed: 0 };
  const batchIds = await listWaitingBatchIds(ddb, tableName);
  let processed = 0;
  for (const batchId of batchIds) {
    await promoteImportAudit({
      ddb,
      s3,
      tableName,
      bucket,
      batchId,
      now,
      nowMs,
    });
    processed += 1;
  }
  return { processed };
}

function canDownloadAuditOriginal(meta) {
  const status = String(meta?.status || "").toUpperCase();
  const eligibility = String(meta?.auditEligibility || "").toUpperCase();
  return (
    status === IMPORT_STATUSES.COMPLETED &&
    eligibility === AUDIT_ELIGIBILITY.ELIGIBLE &&
    isAuditImportKey(meta?.s3Key, meta?.batchId)
  );
}

module.exports = {
  evaluateBatchDistribution,
  promoteImportAudit,
  promoteWaitingImportAudits,
  cleanupNonEligibleOriginal,
  canDownloadAuditOriginal,
  objectExists,
  isS3NotFound,
};

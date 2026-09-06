const {
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
} = require("@aws-sdk/client-s3");
const {
  QueryCommand,
  ScanCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  createDocumentsStorage,
  emptyManifest,
  personalRootKey,
  personalFolderKey,
} = require("../common/documentsStorage");
const { ensurePersonalTree } = require("./personalLogic");
const {
  REQUIRED_DOCUMENTS_ID,
  REQUIRED_DOCUMENTS_NAME,
  uniqueName,
  sanitizeFileName,
} = require("./folderRules");

const KYC_TYPES = {
  AADHAAR: "Aadhaar Card",
  PAN: "PAN Card",
  PHOTOGRAPH: "Photograph",
  PHOTO: "Photograph",
  RESUME: "Resume",
};

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeType(value) {
  return String(value || "").trim().toUpperCase();
}

function isKycType(value) {
  return Boolean(KYC_TYPES[normalizeType(value)]);
}

function typeLabel(value) {
  return KYC_TYPES[normalizeType(value)] || normalizeType(value) || "Document";
}

function storageKeyOf(item) {
  return String(item?.storageKey || item?.s3Key || "").trim();
}

function sourceIdOf(item) {
  return String(item?.documentId || item?.id || storageKeyOf(item) || "").trim();
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function alreadyMigrated(children, item) {
  const sourceId = sourceIdOf(item);
  const key = storageKeyOf(item);
  return (children || []).some((child) => {
    if (child?.type !== "file") return false;
    if (sourceId && child.sourceDocumentId === sourceId) return true;
    if (key && child.sourceStorageKey === key) return true;
    return false;
  });
}

function displayName(item) {
  const original = sanitizeFileName(item.fileName || "document");
  const label = typeLabel(item.documentType);
  if (String(original).toLowerCase().startsWith(String(label).toLowerCase())) {
    return original;
  }
  return `${label} - ${original}`;
}

function pickSourceBucket(key, documentsBucket, profileBucket) {
  if (String(key).startsWith("profiles/")) return profileBucket || documentsBucket;
  if (String(key).startsWith("documents/")) return documentsBucket;
  return documentsBucket;
}

async function queryAll(ddb, params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({ ...params, ExclusiveStartKey })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function scanAll(ddb, params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new ScanCommand({ ...params, ExclusiveStartKey })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function loadDynamoDocuments(ddb, workTable, emails) {
  const items = await queryAll(ddb, {
    TableName: workTable,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": "ENTITY#DOCUMENT",
      ":sk": "DOC#",
    },
  });
  return items.filter((item) => {
    if (item.isCurrent === false) return false;
    if (!isKycType(item.documentType)) return false;
    if (!storageKeyOf(item)) return false;
    const email = normalizeEmail(item.email);
    if (!email) return false;
    if (emails && emails.length && !emails.includes(email)) return false;
    return true;
  });
}

async function loadProfileDocuments(ddb, profileTable, emails) {
  let profiles = [];
  if (emails && emails.length) {
    for (const email of emails) {
      const res = await ddb.send(
        new GetCommand({
          TableName: profileTable,
          Key: { PK: `USER#${email}`, SK: "PROFILE" },
        })
      );
      if (res.Item) profiles.push(res.Item);
    }
  } else {
    profiles = await scanAll(ddb, {
      TableName: profileTable,
      FilterExpression: "SK = :sk",
      ExpressionAttributeValues: { ":sk": "PROFILE" },
    });
  }

  const docs = [];
  for (const profile of profiles) {
    const email = normalizeEmail(profile.email || String(profile.PK || "").replace(/^USER#/i, ""));
    const rows = Array.isArray(profile.hrDocuments) ? profile.hrDocuments : [];
    for (const row of rows) {
      if (!isKycType(row.documentType)) continue;
      if (!storageKeyOf(row)) continue;
      docs.push({
        ...row,
        email,
        documentType: normalizeType(row.documentType),
      });
    }
  }
  return docs;
}

function groupByEmail(items) {
  const map = new Map();
  for (const item of items) {
    const email = normalizeEmail(item.email);
    if (!email) continue;
    if (!map.has(email)) map.set(email, []);
    map.get(email).push(item);
  }
  return map;
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = sourceIdOf(item) || `${storageKeyOf(item)}:${item.fileName || ""}`;
    const key = `${normalizeEmail(item.email)}::${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function resolveSourceBucket(s3, key, documentsBucket, profileBucket) {
  const preferred = pickSourceBucket(key, documentsBucket, profileBucket);
  const order = [...new Set([preferred, documentsBucket, profileBucket].filter(Boolean))];
  for (const bucket of order) {
    if (await objectExists(s3, bucket, key)) return bucket;
  }
  return null;
}

async function objectExists(s3, bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    const name = String(err?.name || err?.Code || "");
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
    throw err;
  }
}

async function copyBlob({ s3, storage, sourceBucket, sourceKey, item }) {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: sourceBucket, Key: sourceKey })
  );
  const body = await streamToBuffer(res.Body);
  return storage.putFileBlob({
    body,
    contentType: res.ContentType || item.fileType || "application/octet-stream",
    fileName: item.fileName,
    uploadedBy: item.email,
    uploadedAt: item.uploadedAt || item.documentDate || new Date().toISOString(),
    description: item.description || typeLabel(item.documentType),
    size: body.length || item.fileSize,
  });
}

async function migrateUser({
  email,
  items,
  s3,
  storage,
  documentsBucket,
  profileBucket,
  dryRun,
}) {
  const result = {
    email,
    copied: 0,
    skipped: 0,
    missing: 0,
    errors: [],
    files: [],
  };

  if (!dryRun) {
    await ensurePersonalTree(storage, email);
  }

  const requiredKey = personalFolderKey(email, REQUIRED_DOCUMENTS_ID);
  const existing = await storage.readManifest(requiredKey);
  let children = existing?.manifest?.children ? [...existing.manifest.children] : [];
  const taken = children.map((c) => c.name);

  for (const item of items) {
    const key = storageKeyOf(item);
    if (alreadyMigrated(children, item)) {
      result.skipped += 1;
      result.files.push({ fileName: item.fileName, status: "skipped-already-migrated" });
      continue;
    }
    const resolvedBucket = await resolveSourceBucket(
      s3,
      key,
      documentsBucket,
      profileBucket
    );
    if (!resolvedBucket) {
      result.missing += 1;
      result.files.push({ fileName: item.fileName, storageKey: key, status: "missing-source" });
      continue;
    }
    const name = uniqueName(displayName(item), taken, { keepExtension: true });
    taken.push(name);

    if (dryRun) {
      result.copied += 1;
      result.files.push({
        fileName: name,
        storageKey: key,
        sourceBucket: resolvedBucket,
        status: "would-copy",
      });
      children.push({
        type: "file",
        name,
        sourceDocumentId: sourceIdOf(item),
        sourceStorageKey: key,
      });
      continue;
    }

    try {
      const blob = await copyBlob({
        s3,
        storage,
        sourceBucket: resolvedBucket,
        sourceKey: key,
        item,
      });
      const entry = {
        id: blob.fileId,
        type: "file",
        name,
        fileId: blob.fileId,
        size: Number(item.fileSize) || undefined,
        uploadedBy: item.email,
        uploadedAt: blob.uploadedAt,
        description: item.description || typeLabel(item.documentType),
        sourceDocumentId: sourceIdOf(item),
        sourceStorageKey: key,
        documentType: normalizeType(item.documentType),
      };
      children.push(entry);
      result.copied += 1;
      result.files.push({
        fileName: name,
        fileId: blob.fileId,
        status: "copied",
      });
    } catch (err) {
      result.errors.push(`${item.fileName || key}: ${err.message || err}`);
      result.files.push({
        fileName: item.fileName,
        storageKey: key,
        status: "error",
        error: err.message || String(err),
      });
    }
  }

  if (!dryRun && result.copied > 0) {
    const required = await storage.readManifest(requiredKey);
    if (required) {
      await storage.updateManifest(requiredKey, (manifest) => ({
        ...manifest,
        children,
      }));
    } else {
      await storage.writeManifest(
        requiredKey,
        emptyManifest({
          id: REQUIRED_DOCUMENTS_ID,
          name: REQUIRED_DOCUMENTS_NAME,
          parentId: "root",
          isSystem: true,
          children,
        })
      );
    }
    const rootKey = personalRootKey(email);
    const root = await storage.readManifest(rootKey);
    const hasRequired = (root?.manifest?.children || []).some(
      (c) => c.id === REQUIRED_DOCUMENTS_ID
    );
    if (root && !hasRequired) {
      await storage.updateManifest(rootKey, (manifest) => ({
        ...manifest,
        children: [
          {
            id: REQUIRED_DOCUMENTS_ID,
            type: "folder",
            name: REQUIRED_DOCUMENTS_NAME,
            isSystem: true,
          },
          ...(manifest.children || []),
        ],
      }));
    }
  }

  return result;
}

async function resolveBuckets(s3, options = {}) {
  let documentsBucket = options.documentsBucket || process.env.DOCUMENTS_BUCKET;
  let profileBucket =
    options.profileBucket ||
    process.env.PROFILE_IMAGE_BUCKET ||
    "mydgv-portal-profile-images";
  if (!documentsBucket) {
    const listed = await s3.send(new ListBucketsCommand({}));
    const names = (listed.Buckets || []).map((b) => b.Name);
    documentsBucket = names.find((n) =>
      String(n).startsWith("mydgv-portal-employee-documents")
    );
  }
  if (!documentsBucket) {
    throw new Error("DOCUMENTS_BUCKET is not configured and could not be discovered.");
  }
  return { documentsBucket, profileBucket };
}

async function migrateKycDocuments({
  ddb,
  s3,
  storage,
  workTable,
  profileTable,
  documentsBucket,
  profileBucket,
  dryRun = true,
  limit = 0,
  emails = [],
} = {}) {
  const emailFilter = (emails || []).map(normalizeEmail).filter(Boolean);
  const dynamoDocs = workTable
    ? await loadDynamoDocuments(ddb, workTable, emailFilter)
    : [];
  const profileDocs = profileTable
    ? await loadProfileDocuments(ddb, profileTable, emailFilter)
    : [];
  const grouped = groupByEmail(dedupeItems([...dynamoDocs, ...profileDocs]));
  let emailsToRun = [...grouped.keys()].sort();
  if (limit && limit > 0) emailsToRun = emailsToRun.slice(0, limit);

  const users = [];
  for (const email of emailsToRun) {
    users.push(
      await migrateUser({
        email,
        items: grouped.get(email) || [],
        s3,
        storage,
        documentsBucket,
        profileBucket,
        dryRun,
      })
    );
  }

  return {
    dryRun: Boolean(dryRun),
    usersConsidered: grouped.size,
    usersProcessed: users.length,
    copied: users.reduce((n, u) => n + u.copied, 0),
    skipped: users.reduce((n, u) => n + u.skipped, 0),
    missing: users.reduce((n, u) => n + u.missing, 0),
    errors: users.flatMap((u) => u.errors.map((e) => `${u.email}: ${e}`)),
    users,
  };
}

module.exports = {
  KYC_TYPES,
  isKycType,
  migrateKycDocuments,
  resolveBuckets,
  createDocumentsStorage,
};

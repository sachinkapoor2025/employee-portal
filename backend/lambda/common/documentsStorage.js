const { randomUUID } = require("crypto");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

const defaultS3 = new S3Client({ region: process.env.AWS_REGION });

const PROJECT_INDEX_KEY = "manifests/projects/_index.json";
const FILE_PREFIX = "files/";
const NOTIFICATION_EVENTS_PREFIX = "notifications/events/";
const DEFAULT_MAX_ATTEMPTS = 5;

class ManifestConflictError extends Error {
  constructor(key, attempts) {
    super(`Concurrent update conflict for ${key} after ${attempts} attempt(s)`);
    this.name = "ManifestConflictError";
    this.code = "MANIFEST_CONFLICT";
    this.key = key;
    this.attempts = attempts;
  }
}

function resolveBucket(bucket) {
  const value = bucket || process.env.DOCUMENTS_BUCKET;
  if (!value) throw new Error("DOCUMENTS_BUCKET is not configured");
  return value;
}

function assertSafeSegment(value, label) {
  const s = String(value || "").trim();
  if (!s || s.includes("/") || s.includes("\\") || s.includes("\0")) {
    throw new Error(`Invalid ${label}`);
  }
  if (s === "." || s === "..") {
    throw new Error(`Invalid ${label}`);
  }
  return s;
}

function projectRootKey(projectId) {
  return `manifests/projects/${assertSafeSegment(projectId, "projectId")}/root.json`;
}

function projectFolderKey(projectId, folderId) {
  return `manifests/projects/${assertSafeSegment(projectId, "projectId")}/folders/${assertSafeSegment(folderId, "folderId")}.json`;
}

function personalRootKey(email) {
  return `manifests/personal/${assertSafeSegment(String(email).trim().toLowerCase(), "email")}/root.json`;
}

function personalFolderKey(email, folderId) {
  return `manifests/personal/${assertSafeSegment(String(email).trim().toLowerCase(), "email")}/folders/${assertSafeSegment(folderId, "folderId")}.json`;
}

function fileBlobKey(fileId) {
  return `${FILE_PREFIX}${assertSafeSegment(fileId, "fileId")}`;
}

function manifestKey({ scope, projectId, email, folderId } = {}) {
  const nested = folderId && folderId !== "root";
  if (scope === "project") {
    return nested ? projectFolderKey(projectId, folderId) : projectRootKey(projectId);
  }
  if (scope === "personal") {
    return nested ? personalFolderKey(email, folderId) : personalRootKey(email);
  }
  throw new Error("Invalid manifest scope");
}

function childFolderKey(parentKey, folderId) {
  const id = assertSafeSegment(folderId, "folderId");
  const rootMatch = String(parentKey).match(
    /^(manifests\/(?:projects|personal)\/.+)\/root\.json$/
  );
  if (rootMatch) return `${rootMatch[1]}/folders/${id}.json`;
  const folderMatch = String(parentKey).match(
    /^(manifests\/(?:projects|personal)\/.+\/folders)\/[^/]+\.json$/
  );
  if (folderMatch) return `${folderMatch[1]}/${id}.json`;
  throw new Error(`Cannot derive child folder key from ${parentKey}`);
}

function emptyManifest(overrides = {}) {
  return {
    ...overrides,
    id: overrides.id || null,
    name: overrides.name || "",
    children: Array.isArray(overrides.children) ? overrides.children : [],
  };
}

function normalizeManifest(data) {
  if (Array.isArray(data)) {
    return { id: null, name: "", children: data };
  }
  const obj = data && typeof data === "object" ? data : {};
  return {
    ...obj,
    id: obj.id || null,
    name: obj.name || "",
    children: Array.isArray(obj.children) ? obj.children : [],
  };
}

function normalizeProjects(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.projects)) return data.projects;
  return [];
}

function isNotFound(err) {
  const status = err?.$metadata?.httpStatusCode;
  const name = String(err?.name || err?.Code || "");
  return status === 404 || name === "NoSuchKey" || name === "NotFound";
}

function isConflictError(err) {
  const status = err?.$metadata?.httpStatusCode;
  const name = String(err?.name || err?.Code || "");
  return (
    status === 412 ||
    status === 409 ||
    name === "PreconditionFailed" ||
    name === "ConditionalRequestConflict"
  );
}

function quoteEtag(etag) {
  if (!etag) return null;
  const value = String(etag);
  return value.startsWith('"') ? value : `"${value}"`;
}

async function bodyToString(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body.transformToString === "function") {
    return body.transformToString();
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toMetaValue(value) {
  return encodeURIComponent(String(value ?? "")).slice(0, 1024);
}

async function readJson(s3, bucket, key) {
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: resolveBucket(bucket),
        Key: key,
      })
    );
    const raw = await bodyToString(res.Body);
    const data = raw ? JSON.parse(raw) : null;
    return { data, etag: quoteEtag(res.ETag) };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function writeJson(s3, bucket, key, data, { etag } = {}) {
  const params = {
    Bucket: resolveBucket(bucket),
    Key: key,
    Body: JSON.stringify(data),
    ContentType: "application/json",
  };
  if (etag) {
    params.IfMatch = quoteEtag(etag);
  } else {
    params.IfNoneMatch = "*";
  }
  try {
    const res = await s3.send(new PutObjectCommand(params));
    return { data, etag: quoteEtag(res.ETag) };
  } catch (err) {
    if (isConflictError(err)) {
      throw new ManifestConflictError(key, 1);
    }
    throw err;
  }
}

async function updateJson(s3, bucket, key, updater, { maxAttempts = DEFAULT_MAX_ATTEMPTS, defaultValue = null } = {}) {
  const attempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const current = await readJson(s3, bucket, key);
    const input = current ? current.data : defaultValue;
    const next = await updater(input, current);
    try {
      return await writeJson(s3, bucket, key, next, {
        etag: current ? current.etag : undefined,
      });
    } catch (err) {
      if (err.code !== "MANIFEST_CONFLICT") throw err;
      lastError = err;
    }
  }
  throw new ManifestConflictError(key, attempts);
}

async function readManifest(s3, bucket, key) {
  const result = await readJson(s3, bucket, key);
  if (!result) return null;
  return {
    manifest: normalizeManifest(result.data),
    etag: result.etag,
  };
}

async function writeManifest(s3, bucket, key, manifest, options) {
  const normalized = normalizeManifest(manifest);
  const result = await writeJson(s3, bucket, key, normalized, options);
  return { manifest: result.data, etag: result.etag };
}

async function updateManifest(s3, bucket, key, updater, options) {
  const result = await updateJson(
    s3,
    bucket,
    key,
    async (current, meta) => {
      const manifest = current == null ? emptyManifest() : normalizeManifest(current);
      return normalizeManifest(await updater(manifest, meta));
    },
    { ...options, defaultValue: null }
  );
  return { manifest: normalizeManifest(result.data), etag: result.etag };
}

function notificationEventKey(isoTimestamp, eventId) {
  return `notifications/events/${isoTimestamp}_${assertSafeSegment(eventId, "eventId")}.json`;
}

function notificationCursorKey(email) {
  return `notifications/cursors/${assertSafeSegment(String(email).trim().toLowerCase(), "email")}.json`;
}

function parseNotificationEventKey(key) {
  const name = String(key || "").split("/").pop() || "";
  const stem = name.replace(/\.json$/i, "");
  const idx = stem.indexOf("_");
  if (idx < 0) return { timestamp: stem, eventId: "" };
  return { timestamp: stem.slice(0, idx), eventId: stem.slice(idx + 1) };
}

async function listAllKeys(s3, bucket, prefix) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: resolveBucket(bucket),
        Prefix: prefix,
        ContinuationToken,
      })
    );
    for (const obj of res.Contents || []) {
      if (obj.Key) keys.push(obj.Key);
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

async function listNotificationEvents(s3, bucket, { limit = 50 } = {}) {
  const keys = (await listAllKeys(s3, bucket, NOTIFICATION_EVENTS_PREFIX)).sort(
    (a, b) => String(b).localeCompare(String(a))
  );
  const max = Math.max(1, Number(limit) || 50);
  const selected = keys.slice(0, max);
  const events = [];
  for (const key of selected) {
    const parsed = await readJson(s3, bucket, key);
    const fromKey = parseNotificationEventKey(key);
    events.push({
      ...(parsed?.data || {}),
      key,
      eventId: (parsed?.data && parsed.data.eventId) || fromKey.eventId,
      timestamp: fromKey.timestamp,
    });
  }
  return { events, keys };
}

async function readNotificationCursor(s3, bucket, email) {
  const result = await readJson(s3, bucket, notificationCursorKey(email));
  if (!result) return { lastSeenAt: null, etag: null };
  const lastSeenAt = result.data && result.data.lastSeenAt ? result.data.lastSeenAt : null;
  return { lastSeenAt, etag: result.etag };
}

async function writeNotificationCursor(s3, bucket, email, lastSeenAt) {
  const cursor = { lastSeenAt };
  await s3.send(
    new PutObjectCommand({
      Bucket: resolveBucket(bucket),
      Key: notificationCursorKey(email),
      Body: JSON.stringify(cursor),
      ContentType: "application/json",
    })
  );
  return cursor;
}

async function putNotificationEvent(s3, bucket, payload = {}) {
  const eventId = payload.eventId || randomUUID();
  const timestamp = payload.timestamp || new Date().toISOString();
  const key = notificationEventKey(timestamp, eventId);
  const event = {
    projectId: payload.projectId || null,
    projectName: payload.projectName || "",
    folderPath: payload.folderPath || "",
    fileCount: Number(payload.fileCount) || 0,
    uploadedBy: payload.uploadedBy || "",
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: resolveBucket(bucket),
      Key: key,
      Body: JSON.stringify(event),
      ContentType: "application/json",
    })
  );
  return { key, eventId, timestamp, ...event };
}

async function deleteFileBlob(s3, bucket, fileId) {
  await deleteObject(s3, bucket, fileBlobKey(fileId));
}

async function putFileBlob(s3, bucket, input = {}) {
  const fileId = input.fileId || randomUUID();
  const key = fileBlobKey(fileId);
  const uploadedAt = input.uploadedAt || new Date().toISOString();
  await s3.send(
    new PutObjectCommand({
      Bucket: resolveBucket(bucket),
      Key: key,
      Body: input.body,
      ContentType: input.contentType || "application/octet-stream",
      Metadata: {
        originalfilename: toMetaValue(input.fileName || input.originalFilename || ""),
        uploadedby: toMetaValue(input.uploadedBy || ""),
        uploadedat: toMetaValue(uploadedAt),
        description: toMetaValue(input.description || ""),
        size: toMetaValue(input.size == null ? "" : input.size),
      },
    })
  );
  return { fileId, key, uploadedAt };
}

async function deleteObject(s3, bucket, key) {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: resolveBucket(bucket),
      Key: key,
    })
  );
}

async function collectFolderTree(s3, bucket, key, acc) {
  const current = await readManifest(s3, bucket, key);
  if (!current) return acc;
  acc.manifests.push(key);
  for (const child of current.manifest.children) {
    if (child.type === "file" && child.fileId) {
      acc.files.push(fileBlobKey(child.fileId));
    } else if (child.type === "folder" && child.id) {
      await collectFolderTree(s3, bucket, childFolderKey(key, child.id), acc);
    }
  }
  return acc;
}

async function deleteFolderTree(s3, bucket, key) {
  const acc = { manifests: [], files: [] };
  await collectFolderTree(s3, bucket, key, acc);
  const unique = [...new Set([...acc.files, ...acc.manifests])];
  await Promise.all(unique.map((objectKey) => deleteObject(s3, bucket, objectKey)));
  return acc;
}

async function readProjectIndex(s3, bucket) {
  const result = await readJson(s3, bucket, PROJECT_INDEX_KEY);
  if (!result) return { projects: [], etag: null };
  return { projects: normalizeProjects(result.data), etag: result.etag };
}

async function writeProjectIndex(s3, bucket, projects, options) {
  const list = normalizeProjects(projects);
  const result = await writeJson(s3, bucket, PROJECT_INDEX_KEY, list, options);
  return { projects: result.data, etag: result.etag };
}

async function updateProjectIndex(s3, bucket, updater, options) {
  const result = await updateJson(
    s3,
    bucket,
    PROJECT_INDEX_KEY,
    async (current, meta) => normalizeProjects(await updater(normalizeProjects(current), meta)),
    { ...options, defaultValue: [] }
  );
  return { projects: normalizeProjects(result.data), etag: result.etag };
}

function createDocumentsStorage(deps = {}) {
  const s3 = deps.s3 || defaultS3;
  const bucketOf = () => resolveBucket(deps.bucket);
  return {
    readManifest: (key) => readManifest(s3, bucketOf(), key),
    writeManifest: (key, manifest, options) =>
      writeManifest(s3, bucketOf(), key, manifest, options),
    updateManifest: (key, updater, options) =>
      updateManifest(s3, bucketOf(), key, updater, options),
    putFileBlob: (input) => putFileBlob(s3, bucketOf(), input),
    deleteFileBlob: (fileId) => deleteFileBlob(s3, bucketOf(), fileId),
    deleteFolderTree: (key) => deleteFolderTree(s3, bucketOf(), key),
    putNotificationEvent: (payload) => putNotificationEvent(s3, bucketOf(), payload),
    listNotificationEvents: (options) => listNotificationEvents(s3, bucketOf(), options),
    readNotificationCursor: (email) => readNotificationCursor(s3, bucketOf(), email),
    writeNotificationCursor: (email, lastSeenAt) =>
      writeNotificationCursor(s3, bucketOf(), email, lastSeenAt),
    readProjectIndex: () => readProjectIndex(s3, bucketOf()),
    writeProjectIndex: (projects, options) =>
      writeProjectIndex(s3, bucketOf(), projects, options),
    updateProjectIndex: (updater, options) =>
      updateProjectIndex(s3, bucketOf(), updater, options),
  };
}

module.exports = {
  PROJECT_INDEX_KEY,
  FILE_PREFIX,
  DEFAULT_MAX_ATTEMPTS,
  ManifestConflictError,
  createDocumentsStorage,
  emptyManifest,
  manifestKey,
  projectRootKey,
  projectFolderKey,
  personalRootKey,
  personalFolderKey,
  fileBlobKey,
  childFolderKey,
  notificationEventKey,
  notificationCursorKey,
  parseNotificationEventKey,
  NOTIFICATION_EVENTS_PREFIX,
  readManifest,
  writeManifest,
  updateManifest,
  putFileBlob,
  deleteFileBlob,
  putNotificationEvent,
  listNotificationEvents,
  readNotificationCursor,
  writeNotificationCursor,
  deleteFolderTree,
  readProjectIndex,
  writeProjectIndex,
  updateProjectIndex,
};

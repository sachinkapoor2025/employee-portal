const { randomUUID } = require("crypto");
const { json } = require("../common/response");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  ManifestConflictError,
  createDocumentsStorage,
  emptyManifest,
  personalRootKey,
  personalFolderKey,
  fileBlobKey,
} = require("../common/documentsStorage");

const s3 = new S3Client({ region: process.env.AWS_REGION });
const SIGNED_TTL = Number(process.env.DOCUMENT_URL_TTL_SECONDS || 300);
const {
  REQUIRED_DOCUMENTS_NAME,
  REQUIRED_DOCUMENTS_ID,
  normalizePath,
  decodeSegment,
  isReservedFolderName,
  isSystemFolder,
  reservedNameError,
  normalizeItemName,
  sanitizeFileName,
  uniqueName,
  prepareUploadFiles,
  pinSystemFoldersFirst,
  normalizeEmail,
} = require("./folderRules");

const defaultStorage = createDocumentsStorage();

function parsePersonalRoute(path) {
  const p = normalizePath(path);
  if (!p.includes("/documents/personal")) return null;

  let m = p.match(
    /\/documents\/personal\/([^/]+)\/folders\/([^/]+)\/files\/([^/]+)\/download-url$/
  );
  if (m) {
    return {
      kind: "download-url",
      email: decodeSegment(m[1]),
      folderId: decodeSegment(m[2]),
      fileId: decodeSegment(m[3]),
    };
  }
  m = p.match(/\/documents\/personal\/([^/]+)\/files\/([^/]+)\/download-url$/);
  if (m) {
    return {
      kind: "download-url",
      email: decodeSegment(m[1]),
      folderId: "root",
      fileId: decodeSegment(m[2]),
    };
  }
  m = p.match(
    /\/documents\/personal\/([^/]+)\/folders\/([^/]+)\/files\/([^/]+)$/
  );
  if (m) {
    return {
      kind: "file",
      email: decodeSegment(m[1]),
      folderId: decodeSegment(m[2]),
      fileId: decodeSegment(m[3]),
    };
  }
  m = p.match(/\/documents\/personal\/([^/]+)\/folders\/([^/]+)\/files$/);
  if (m) {
    return {
      kind: "files",
      email: decodeSegment(m[1]),
      folderId: decodeSegment(m[2]),
    };
  }
  m = p.match(/\/documents\/personal\/([^/]+)\/folders\/([^/]+)\/subfolders$/);
  if (m) {
    return {
      kind: "subfolders",
      email: decodeSegment(m[1]),
      folderId: decodeSegment(m[2]),
    };
  }
  m = p.match(/\/documents\/personal\/([^/]+)\/folders\/([^/]+)$/);
  if (m) {
    return {
      kind: "folder",
      email: decodeSegment(m[1]),
      folderId: decodeSegment(m[2]),
    };
  }
  m = p.match(/\/documents\/personal\/([^/]+)\/folders$/);
  if (m) {
    return { kind: "folder", email: decodeSegment(m[1]), folderId: "root" };
  }
  m = p.match(/\/documents\/personal\/([^/]+)\/files\/([^/]+)$/);
  if (m) {
    return {
      kind: "file",
      email: decodeSegment(m[1]),
      folderId: "root",
      fileId: decodeSegment(m[2]),
    };
  }
  m = p.match(/\/documents\/personal\/([^/]+)\/files$/);
  if (m) {
    return { kind: "files", email: decodeSegment(m[1]), folderId: "root" };
  }
  m = p.match(/\/documents\/personal\/([^/]+)\/subfolders$/);
  if (m) {
    return { kind: "subfolders", email: decodeSegment(m[1]), folderId: "root" };
  }
  m = p.match(/\/documents\/personal\/([^/]+)$/);
  if (m) {
    return { kind: "root", email: decodeSegment(m[1]) };
  }
  if (/\/documents\/personal$/.test(p)) return { kind: "root", email: null };
  return null;
}

function resolveTargetEmail(user, requestedEmail) {
  const own = normalizeEmail(user && user.email);
  const requested = normalizeEmail(requestedEmail);
  if (!own) return { error: json(401, { error: "Unauthorized" }) };
  if (!requested || requested === own) return { email: own };
  if (!user.isAdmin) return { error: json(403, { error: "Forbidden" }) };
  if (!requested.includes("@")) {
    return { error: json(400, { error: "Invalid email" }) };
  }
  return { email: requested };
}

function manifestKeyFor(email, folderId) {
  if (!folderId || folderId === "root") return personalRootKey(email);
  return personalFolderKey(email, folderId);
}

function publicManifest(email, folderId, record) {
  const manifest = record.manifest;
  return {
    email,
    folderId: folderId && folderId !== "root" ? folderId : "root",
    id: manifest.id,
    name: manifest.name,
    parentId: manifest.parentId || null,
    children: pinSystemFoldersFirst(manifest.children || []),
  };
}

async function ignoreConflict(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.code !== "MANIFEST_CONFLICT") throw err;
  }
}

async function ensurePersonalTree(storage, email) {
  const rootKey = personalRootKey(email);
  const requiredKey = personalFolderKey(email, REQUIRED_DOCUMENTS_ID);
  const requiredEntry = {
    id: REQUIRED_DOCUMENTS_ID,
    type: "folder",
    name: REQUIRED_DOCUMENTS_NAME,
    isSystem: true,
  };

  const required = await storage.readManifest(requiredKey);
  if (!required) {
    await ignoreConflict(() =>
      storage.writeManifest(
        requiredKey,
        emptyManifest({
          id: REQUIRED_DOCUMENTS_ID,
          name: REQUIRED_DOCUMENTS_NAME,
          parentId: "root",
          isSystem: true,
        })
      )
    );
  }

  let root = await storage.readManifest(rootKey);
  if (!root) {
    await ignoreConflict(() =>
      storage.writeManifest(
        rootKey,
        emptyManifest({
          id: "root",
          name: "Personal",
          children: [requiredEntry],
        })
      )
    );
    root = await storage.readManifest(rootKey);
  }

  const children = root?.manifest?.children || [];
  const hasRequired = children.some(
    (c) => c.id === REQUIRED_DOCUMENTS_ID || isSystemFolder(c)
  );
  if (!hasRequired) {
    root = await storage.updateManifest(rootKey, (manifest) => ({
      ...manifest,
      children: [requiredEntry, ...(manifest.children || [])],
    }));
  }
  return root;
}

async function requireFolder(storage, email, folderId) {
  await ensurePersonalTree(storage, email);
  const key = manifestKeyFor(email, folderId);
  const record = await storage.readManifest(key);
  if (!record) return { error: json(404, { error: "Folder not found" }) };
  return { key, record };
}

async function listFolder(storage, email, folderId) {
  const folder = await requireFolder(storage, email, folderId);
  if (folder.error) return folder.error;
  return json(200, publicManifest(email, folderId, folder.record));
}

async function createSubfolder(storage, user, email, folderId, body) {
  const name = normalizeItemName(body.name);
  if (!name) return json(400, { error: "name is required" });
  if (isReservedFolderName(name)) return reservedNameError();

  const parent = await requireFolder(storage, email, folderId);
  if (parent.error) return parent.error;

  const id = randomUUID();
  let savedName = name;
  await storage.updateManifest(parent.key, (manifest) => {
    savedName = uniqueName(
      name,
      (manifest.children || []).map((c) => c.name)
    );
    return {
      ...manifest,
      children: [
        ...(manifest.children || []),
        { id, type: "folder", name: savedName },
      ],
    };
  });
  await storage.writeManifest(
    personalFolderKey(email, id),
    emptyManifest({
      id,
      name: savedName,
      parentId: !folderId || folderId === "root" ? "root" : folderId,
    })
  );
  return json(201, {
    id,
    type: "folder",
    name: savedName,
    email,
    parentId: !folderId || folderId === "root" ? "root" : folderId,
  });
}

async function renameFolder(storage, email, folderId, body) {
  if (!folderId || folderId === "root") {
    return json(400, { error: "The personal root folder cannot be renamed." });
  }
  const name = normalizeItemName(body.name);
  if (!name) return json(400, { error: "name is required" });
  if (isReservedFolderName(name)) return reservedNameError();

  const folder = await requireFolder(storage, email, folderId);
  if (folder.error) return folder.error;
  if (folder.record.manifest.isSystem || folderId === REQUIRED_DOCUMENTS_ID) {
    return json(400, { error: "This folder cannot be renamed." });
  }

  const parentKey = manifestKeyFor(email, folder.record.manifest.parentId || "root");
  const parent = await storage.readManifest(parentKey);
  if (!parent) return json(404, { error: "Parent folder not found" });
  const child = (parent.manifest.children || []).find(
    (c) => c.type === "folder" && c.id === folderId
  );
  if (!child) return json(404, { error: "Folder not found" });
  if (isSystemFolder(child)) {
    return json(400, { error: "This folder cannot be renamed." });
  }

  const savedName = uniqueName(
    name,
    parent.manifest.children.filter((c) => c.id !== folderId).map((c) => c.name)
  );
  await storage.updateManifest(parentKey, (manifest) => ({
    ...manifest,
    children: (manifest.children || []).map((c) =>
      c.type === "folder" && c.id === folderId ? { ...c, name: savedName } : c
    ),
  }));
  await storage.updateManifest(folder.key, (manifest) => ({
    ...manifest,
    name: savedName,
  }));
  return json(200, { id: folderId, type: "folder", name: savedName, email });
}

async function deleteFolder(storage, email, folderId) {
  if (!folderId || folderId === "root") {
    return json(400, { error: "The personal root folder cannot be deleted." });
  }

  const folder = await requireFolder(storage, email, folderId);
  if (folder.error) return folder.error;
  if (folder.record.manifest.isSystem || folderId === REQUIRED_DOCUMENTS_ID) {
    return json(400, { error: "This folder cannot be deleted." });
  }

  const parentKey = manifestKeyFor(email, folder.record.manifest.parentId || "root");
  const parent = await storage.readManifest(parentKey);
  if (parent) {
    const child = (parent.manifest.children || []).find(
      (c) => c.type === "folder" && c.id === folderId
    );
    if (isSystemFolder(child)) {
      return json(400, { error: "This folder cannot be deleted." });
    }
    await storage.updateManifest(parentKey, (manifest) => ({
      ...manifest,
      children: (manifest.children || []).filter(
        (c) => !(c.type === "folder" && c.id === folderId)
      ),
    }));
  }
  const deleted = await storage.deleteFolderTree(folder.key);
  return json(200, {
    ok: true,
    id: folderId,
    deleted: {
      folders: deleted.manifests.length,
      files: deleted.files.length,
    },
  });
}

async function uploadFiles(storage, user, email, folderId, body) {
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return json(400, { error: "files is required" });

  const parent = await requireFolder(storage, email, folderId);
  if (parent.error) return parent.error;

  const { prepared, errors } = prepareUploadFiles(files);
  if (errors.length) {
    return json(400, {
      error: "Some files failed validation.",
      files: errors,
    });
  }

  const description = String(body.description || "").trim().slice(0, 500);
  const dateRaw = String(body.date || "").trim();
  const uploadedAt = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
    ? dateRaw
    : new Date().toISOString();
  const uploaded = [];
  try {
    for (const file of prepared) {
      const blob = await storage.putFileBlob({
        body: file.body,
        contentType: file.contentType,
        fileName: file.fileName,
        uploadedBy: user.email,
        uploadedAt,
        description: file.description || description,
        size: file.fileSize,
      });
      uploaded.push({ ...file, ...blob });
    }
  } catch (err) {
    await Promise.all(
      uploaded.map((f) => storage.deleteFileBlob(f.fileId).catch(() => {}))
    );
    console.error("Personal file upload error:", err);
    return json(500, { error: "Upload failed. No files were saved." });
  }

  let savedEntries = [];
  try {
    const result = await storage.updateManifest(parent.key, (manifest) => {
      const taken = (manifest.children || []).map((c) => c.name);
      savedEntries = uploaded.map((file) => {
        const name = uniqueName(file.fileName, taken, { keepExtension: true });
        taken.push(name);
        return {
          id: file.fileId,
          type: "file",
          name,
          fileId: file.fileId,
          size: file.fileSize,
          uploadedBy: user.email,
          uploadedAt,
          description: file.description || description,
        };
      });
      return {
        ...manifest,
        children: [...(manifest.children || []), ...savedEntries],
      };
    });
    savedEntries = (result.manifest.children || []).slice(-uploaded.length);
  } catch (err) {
    await Promise.all(
      uploaded.map((f) => storage.deleteFileBlob(f.fileId).catch(() => {}))
    );
    throw err;
  }

  return json(201, { files: savedEntries });
}

async function renameFile(storage, email, folderId, fileId, body) {
  const raw = String(body.name || body.fileName || "").trim();
  if (!raw) return json(400, { error: "name is required" });
  const name = sanitizeFileName(raw);

  const parent = await requireFolder(storage, email, folderId);
  if (parent.error) return parent.error;

  const child = (parent.record.manifest.children || []).find(
    (c) => c.type === "file" && (c.fileId === fileId || c.id === fileId)
  );
  if (!child) return json(404, { error: "File not found" });

  const savedName = uniqueName(
    name,
    parent.record.manifest.children
      .filter((c) => !(c.type === "file" && (c.fileId === fileId || c.id === fileId)))
      .map((c) => c.name),
    { keepExtension: true }
  );
  await storage.updateManifest(parent.key, (manifest) => ({
    ...manifest,
    children: (manifest.children || []).map((c) =>
      c.type === "file" && (c.fileId === fileId || c.id === fileId)
        ? { ...c, name: savedName }
        : c
    ),
  }));
  return json(200, {
    id: child.id,
    fileId: child.fileId,
    type: "file",
    name: savedName,
    email,
  });
}

async function deleteFile(storage, email, folderId, fileId) {
  const parent = await requireFolder(storage, email, folderId);
  if (parent.error) return parent.error;

  const child = (parent.record.manifest.children || []).find(
    (c) => c.type === "file" && (c.fileId === fileId || c.id === fileId)
  );
  if (!child) return json(404, { error: "File not found" });

  await storage.updateManifest(parent.key, (manifest) => ({
    ...manifest,
    children: (manifest.children || []).filter(
      (c) => !(c.type === "file" && (c.fileId === fileId || c.id === fileId))
    ),
  }));
  if (child.fileId) {
    await storage.deleteFileBlob(child.fileId).catch(() => {});
  }
  return json(200, { ok: true, fileId: child.fileId || fileId });
}

function dispositionName(name) {
  return String(name || "document").replace(/["\\]/g, "_");
}

async function getDownloadUrl(storage, email, folderId, fileId) {
  const parent = await requireFolder(storage, email, folderId);
  if (parent.error) return parent.error;
  const child = (parent.record.manifest.children || []).find(
    (c) => c.type === "file" && (c.fileId === fileId || c.id === fileId)
  );
  if (!child) return json(404, { error: "File not found" });
  const bucket = process.env.DOCUMENTS_BUCKET;
  if (!bucket) return json(500, { error: "Documents bucket not configured" });
  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: fileBlobKey(child.fileId),
      ResponseContentDisposition: `attachment; filename="${dispositionName(child.name)}"`,
    }),
    { expiresIn: SIGNED_TTL }
  );
  return json(200, { downloadUrl, fileName: child.name });
}

async function handlePersonalRequest({
  user,
  method,
  body = {},
  route,
  query = {},
  storage,
}) {
  const store = storage || defaultStorage;
  const requestedEmail = route.email || query.email || null;
  const scoped = resolveTargetEmail(user, requestedEmail);
  if (scoped.error) return scoped.error;
  const email = scoped.email;

  try {
    if (route.kind === "root") {
      if (method === "GET") return listFolder(store, email, "root");
      if (method === "PATCH") {
        return json(400, { error: "The personal root folder cannot be renamed." });
      }
      if (method === "DELETE") {
        return json(400, { error: "The personal root folder cannot be deleted." });
      }
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "folder") {
      if (method === "GET") return listFolder(store, email, route.folderId);
      if (method === "PATCH") return renameFolder(store, email, route.folderId, body);
      if (method === "DELETE") return deleteFolder(store, email, route.folderId);
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "subfolders") {
      if (method === "POST") {
        return createSubfolder(store, user, email, route.folderId, body);
      }
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "files") {
      if (method === "POST") {
        return uploadFiles(store, user, email, route.folderId, body);
      }
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "download-url") {
      if (method === "GET" || method === "POST") {
        return getDownloadUrl(store, email, route.folderId, route.fileId);
      }
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "file") {
      if (method === "PATCH") {
        return renameFile(store, email, route.folderId, route.fileId, body);
      }
      if (method === "DELETE") {
        return deleteFile(store, email, route.folderId, route.fileId);
      }
      return json(405, { error: "Method not allowed" });
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    if (err instanceof ManifestConflictError) {
      return json(409, {
        error: "This folder was updated by someone else. Please retry.",
      });
    }
    if (err.statusCode === 404) {
      return json(404, { error: err.message || "Not found" });
    }
    if (String(err.message || "").startsWith("Invalid ")) {
      return json(400, { error: err.message });
    }
    console.error("Personal documents error:", err);
    return json(500, { error: "Internal server error" });
  }
}

module.exports = {
  parsePersonalRoute,
  handlePersonalRequest,
  ensurePersonalTree,
  resolveTargetEmail,
};

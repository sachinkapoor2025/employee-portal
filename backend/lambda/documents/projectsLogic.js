const { randomUUID } = require("crypto");
const { json } = require("../common/response");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  ManifestConflictError,
  createDocumentsStorage,
  emptyManifest,
  projectRootKey,
  projectFolderKey,
  fileBlobKey,
} = require("../common/documentsStorage");

const s3 = new S3Client({ region: process.env.AWS_REGION });
const SIGNED_TTL = Number(process.env.DOCUMENT_URL_TTL_SECONDS || 300);
const {
  normalizePath,
  decodeSegment,
  isReservedFolderName,
  reservedNameError,
  normalizeItemName,
  sanitizeFileName,
  uniqueName,
  validateFile,
  prepareUploadFiles,
} = require("./folderRules");

const defaultStorage = createDocumentsStorage();

function parseProjectRoute(path) {
  const p = normalizePath(path);
  if (!p.includes("/documents/projects")) return null;

  let m = p.match(
    /\/documents\/projects\/([^/]+)\/folders\/([^/]+)\/files\/([^/]+)\/download-url$/
  );
  if (m) {
    return {
      kind: "download-url",
      projectId: decodeSegment(m[1]),
      folderId: decodeSegment(m[2]),
      fileId: decodeSegment(m[3]),
    };
  }
  m = p.match(/\/documents\/projects\/([^/]+)\/files\/([^/]+)\/download-url$/);
  if (m) {
    return {
      kind: "download-url",
      projectId: decodeSegment(m[1]),
      folderId: "root",
      fileId: decodeSegment(m[2]),
    };
  }
  m = p.match(
    /\/documents\/projects\/([^/]+)\/folders\/([^/]+)\/files\/([^/]+)$/
  );
  if (m) {
    return {
      kind: "file",
      projectId: decodeSegment(m[1]),
      folderId: decodeSegment(m[2]),
      fileId: decodeSegment(m[3]),
    };
  }
  m = p.match(/\/documents\/projects\/([^/]+)\/folders\/([^/]+)\/files$/);
  if (m) {
    return {
      kind: "files",
      projectId: decodeSegment(m[1]),
      folderId: decodeSegment(m[2]),
    };
  }
  m = p.match(/\/documents\/projects\/([^/]+)\/folders\/([^/]+)\/subfolders$/);
  if (m) {
    return {
      kind: "subfolders",
      projectId: decodeSegment(m[1]),
      folderId: decodeSegment(m[2]),
    };
  }
  m = p.match(/\/documents\/projects\/([^/]+)\/folders\/([^/]+)$/);
  if (m) {
    return {
      kind: "folder",
      projectId: decodeSegment(m[1]),
      folderId: decodeSegment(m[2]),
    };
  }
  m = p.match(/\/documents\/projects\/([^/]+)\/folders$/);
  if (m) {
    return { kind: "folder", projectId: decodeSegment(m[1]), folderId: "root" };
  }
  m = p.match(/\/documents\/projects\/([^/]+)\/files\/([^/]+)$/);
  if (m) {
    return {
      kind: "file",
      projectId: decodeSegment(m[1]),
      folderId: "root",
      fileId: decodeSegment(m[2]),
    };
  }
  m = p.match(/\/documents\/projects\/([^/]+)\/files$/);
  if (m) {
    return { kind: "files", projectId: decodeSegment(m[1]), folderId: "root" };
  }
  m = p.match(/\/documents\/projects\/([^/]+)\/subfolders$/);
  if (m) {
    return { kind: "subfolders", projectId: decodeSegment(m[1]), folderId: "root" };
  }
  m = p.match(/\/documents\/projects\/([^/]+)$/);
  if (m) {
    return { kind: "project", projectId: decodeSegment(m[1]) };
  }
  if (/\/documents\/projects$/.test(p)) return { kind: "index" };
  return null;
}

function adminDenied(user) {
  if (user && user.isAdmin) return null;
  return json(403, { error: "Admin required" });
}

function manifestKeyFor(projectId, folderId) {
  if (!folderId || folderId === "root") return projectRootKey(projectId);
  return projectFolderKey(projectId, folderId);
}

function publicManifest(projectId, folderId, record) {
  const manifest = record.manifest;
  return {
    projectId,
    folderId: folderId && folderId !== "root" ? folderId : "root",
    id: manifest.id,
    name: manifest.name,
    parentId: manifest.parentId || null,
    children: manifest.children || [],
  };
}

function publicProject(row) {
  return {
    projectId: row.projectId,
    name: row.name,
    createdAt: row.createdAt,
  };
}

async function loadProject(storage, projectId) {
  const [index, root] = await Promise.all([
    storage.readProjectIndex(),
    storage.readManifest(projectRootKey(projectId)),
  ]);
  const row = (index.projects || []).find((p) => p.projectId === projectId) || null;
  return { index, root, row };
}

async function requireProject(storage, projectId) {
  const found = await loadProject(storage, projectId);
  if (!found.row && !found.root) return { error: json(404, { error: "Project not found" }) };
  return found;
}

async function requireFolder(storage, projectId, folderId) {
  const key = manifestKeyFor(projectId, folderId);
  const record = await storage.readManifest(key);
  if (!record) return { error: json(404, { error: "Folder not found" }) };
  return { key, record };
}

async function buildFolderPath(storage, projectId, folderId) {
  const found = await loadProject(storage, projectId);
  const projectName = found.root?.manifest?.name || found.row?.name || "";
  if (!folderId || folderId === "root") {
    return { projectName, folderPath: projectName };
  }
  const chain = [];
  let currentId = folderId;
  for (let i = 0; i < 40 && currentId && currentId !== "root"; i += 1) {
    const rec = await storage.readManifest(projectFolderKey(projectId, currentId));
    if (!rec) break;
    chain.push(rec.manifest.name);
    currentId = rec.manifest.parentId;
    if (!currentId || currentId === "root" || currentId === projectId) break;
  }
  chain.reverse();
  return {
    projectName,
    folderPath: [projectName, ...chain].filter(Boolean).join(" / "),
  };
}

async function listProjects(storage) {
  const index = await storage.readProjectIndex();
  return json(200, { projects: (index.projects || []).map(publicProject) });
}

async function createProject(storage, user, body) {
  const denied = adminDenied(user);
  if (denied) return denied;
  const name = normalizeItemName(body.name);
  if (!name) return json(400, { error: "name is required" });
  if (isReservedFolderName(name)) return reservedNameError();

  const projectId = randomUUID();
  const createdAt = new Date().toISOString();
  let savedName = name;
  const indexResult = await storage.updateProjectIndex((projects) => {
    savedName = uniqueName(
      name,
      projects.map((p) => p.name)
    );
    return [
      ...projects,
      { projectId, name: savedName, createdAt },
    ];
  });
  await storage.writeManifest(
    projectRootKey(projectId),
    emptyManifest({ id: projectId, name: savedName })
  );
  const row = indexResult.projects.find((p) => p.projectId === projectId);
  return json(201, publicProject(row || { projectId, name: savedName, createdAt }));
}

async function renameProject(storage, user, projectId, body) {
  const denied = adminDenied(user);
  if (denied) return denied;
  const name = normalizeItemName(body.name);
  if (!name) return json(400, { error: "name is required" });
  if (isReservedFolderName(name)) return reservedNameError();

  const found = await requireProject(storage, projectId);
  if (found.error) return found.error;

  let savedName = name;
  const indexResult = await storage.updateProjectIndex((projects) => {
    const exists = projects.some((p) => p.projectId === projectId);
    if (!exists) {
      const err = new Error("Project not found");
      err.statusCode = 404;
      throw err;
    }
    savedName = uniqueName(
      name,
      projects.filter((p) => p.projectId !== projectId).map((p) => p.name)
    );
    return projects.map((p) =>
      p.projectId === projectId ? { ...p, name: savedName } : p
    );
  });
  const rootKey = projectRootKey(projectId);
  const root = await storage.readManifest(rootKey);
  if (root) {
    await storage.updateManifest(rootKey, (manifest) => ({
      ...manifest,
      name: savedName,
    }));
  }
  const row = indexResult.projects.find((p) => p.projectId === projectId);
  return json(200, publicProject(row || { projectId, name: savedName }));
}

async function deleteProject(storage, user, projectId) {
  const denied = adminDenied(user);
  if (denied) return denied;
  const found = await requireProject(storage, projectId);
  if (found.error) return found.error;

  await storage.updateProjectIndex((projects) =>
    projects.filter((p) => p.projectId !== projectId)
  );
  const deleted = await storage.deleteFolderTree(projectRootKey(projectId));
  return json(200, {
    ok: true,
    projectId,
    deleted: {
      folders: deleted.manifests.length,
      files: deleted.files.length,
    },
  });
}

async function listFolder(storage, projectId, folderId) {
  const found = await requireProject(storage, projectId);
  if (found.error) return found.error;
  const folder = await requireFolder(storage, projectId, folderId);
  if (folder.error) return folder.error;
  return json(200, publicManifest(projectId, folderId, folder.record));
}

async function createSubfolder(storage, user, projectId, folderId, body) {
  const denied = adminDenied(user);
  if (denied) return denied;
  const name = normalizeItemName(body.name);
  if (!name) return json(400, { error: "name is required" });
  if (isReservedFolderName(name)) return reservedNameError();

  const found = await requireProject(storage, projectId);
  if (found.error) return found.error;
  const parent = await requireFolder(storage, projectId, folderId);
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
    projectFolderKey(projectId, id),
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
    projectId,
    parentId: !folderId || folderId === "root" ? "root" : folderId,
  });
}

async function renameFolder(storage, user, projectId, folderId, body) {
  const denied = adminDenied(user);
  if (denied) return denied;
  if (!folderId || folderId === "root") {
    return json(400, { error: "Use PATCH /documents/projects/{projectId} to rename a project." });
  }
  const name = normalizeItemName(body.name);
  if (!name) return json(400, { error: "name is required" });
  if (isReservedFolderName(name)) return reservedNameError();

  const found = await requireProject(storage, projectId);
  if (found.error) return found.error;
  const folder = await requireFolder(storage, projectId, folderId);
  if (folder.error) return folder.error;
  if (folder.record.manifest.isSystem) {
    return json(400, { error: "This folder cannot be renamed." });
  }

  const parentKey = manifestKeyFor(projectId, folder.record.manifest.parentId || "root");
  const parent = await storage.readManifest(parentKey);
  if (!parent) return json(404, { error: "Parent folder not found" });
  const child = (parent.manifest.children || []).find(
    (c) => c.type === "folder" && c.id === folderId
  );
  if (!child) return json(404, { error: "Folder not found" });
  if (child.isSystem) return json(400, { error: "This folder cannot be renamed." });

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
  return json(200, { id: folderId, type: "folder", name: savedName, projectId });
}

async function deleteFolder(storage, user, projectId, folderId) {
  const denied = adminDenied(user);
  if (denied) return denied;
  if (!folderId || folderId === "root") {
    return json(400, { error: "Use DELETE /documents/projects/{projectId} to delete a project." });
  }

  const found = await requireProject(storage, projectId);
  if (found.error) return found.error;
  const folder = await requireFolder(storage, projectId, folderId);
  if (folder.error) return folder.error;
  if (folder.record.manifest.isSystem) {
    return json(400, { error: "This folder cannot be deleted." });
  }

  const parentKey = manifestKeyFor(projectId, folder.record.manifest.parentId || "root");
  const parent = await storage.readManifest(parentKey);
  if (parent) {
    const child = (parent.manifest.children || []).find(
      (c) => c.type === "folder" && c.id === folderId
    );
    if (child?.isSystem) {
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

async function uploadFiles(storage, user, projectId, folderId, body) {
  const denied = adminDenied(user);
  if (denied) return denied;

  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return json(400, { error: "files is required" });

  const found = await requireProject(storage, projectId);
  if (found.error) return found.error;
  const parent = await requireFolder(storage, projectId, folderId);
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
    console.error("Project file upload error:", err);
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

  const pathInfo = await buildFolderPath(storage, projectId, folderId);
  const notification = await storage.putNotificationEvent({
    projectId,
    projectName: pathInfo.projectName,
    folderPath: pathInfo.folderPath,
    fileCount: savedEntries.length,
    uploadedBy: user.email,
  });

  return json(201, {
    files: savedEntries,
    notification: {
      eventId: notification.eventId,
      fileCount: notification.fileCount,
      folderPath: notification.folderPath,
    },
  });
}

async function renameFile(storage, user, projectId, folderId, fileId, body) {
  const denied = adminDenied(user);
  if (denied) return denied;
  const raw = String(body.name || body.fileName || "").trim();
  if (!raw) return json(400, { error: "name is required" });
  const name = sanitizeFileName(raw);

  const found = await requireProject(storage, projectId);
  if (found.error) return found.error;
  const parent = await requireFolder(storage, projectId, folderId);
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
    projectId,
  });
}

async function deleteFile(storage, user, projectId, folderId, fileId) {
  const denied = adminDenied(user);
  if (denied) return denied;

  const found = await requireProject(storage, projectId);
  if (found.error) return found.error;
  const parent = await requireFolder(storage, projectId, folderId);
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

async function getDownloadUrl(storage, projectId, folderId, fileId) {
  const found = await requireProject(storage, projectId);
  if (found.error) return found.error;
  const parent = await requireFolder(storage, projectId, folderId);
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

async function handleProjectRequest({ user, method, body = {}, route, storage }) {
  const store = storage || defaultStorage;
  try {
    if (route.kind === "index") {
      if (method === "GET") return listProjects(store);
      if (method === "POST") return createProject(store, user, body);
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "project") {
      if (method === "GET") return listFolder(store, route.projectId, "root");
      if (method === "PATCH") return renameProject(store, user, route.projectId, body);
      if (method === "DELETE") return deleteProject(store, user, route.projectId);
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "folder") {
      if (method === "GET") return listFolder(store, route.projectId, route.folderId);
      if (method === "PATCH") {
        return renameFolder(store, user, route.projectId, route.folderId, body);
      }
      if (method === "DELETE") {
        return deleteFolder(store, user, route.projectId, route.folderId);
      }
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "subfolders") {
      if (method === "POST") {
        return createSubfolder(store, user, route.projectId, route.folderId, body);
      }
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "files") {
      if (method === "POST") {
        return uploadFiles(store, user, route.projectId, route.folderId, body);
      }
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "download-url") {
      if (method === "GET" || method === "POST") {
        return getDownloadUrl(store, route.projectId, route.folderId, route.fileId);
      }
      return json(405, { error: "Method not allowed" });
    }

    if (route.kind === "file") {
      if (method === "PATCH") {
        return renameFile(
          store,
          user,
          route.projectId,
          route.folderId,
          route.fileId,
          body
        );
      }
      if (method === "DELETE") {
        return deleteFile(store, user, route.projectId, route.folderId, route.fileId);
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
    console.error("Project documents error:", err);
    return json(500, { error: "Internal server error" });
  }
}

module.exports = {
  parseProjectRoute,
  handleProjectRequest,
  uniqueName,
  isReservedFolderName,
  validateFile,
  prepareUploadFiles,
};

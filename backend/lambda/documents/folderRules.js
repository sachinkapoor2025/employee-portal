const { json } = require("../common/response");

const REQUIRED_DOCUMENTS_NAME = "Required Documents";
const REQUIRED_DOCUMENTS_ID = "required-documents";
const RESERVED_FOLDER_NAME = "required documents";
const MAX_BYTES = Number(process.env.DOCUMENT_MAX_BYTES || 10 * 1024 * 1024);
const ALLOWED_BY_EXT = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function normalizePath(path) {
  return String(path || "")
    .replace(/^\/prod(?=\/)/, "")
    .replace(/\/+$/, "");
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isReservedFolderName(name) {
  return String(name || "").trim().toLowerCase() === RESERVED_FOLDER_NAME;
}

function isSystemFolder(entry) {
  if (!entry) return false;
  return Boolean(entry.isSystem) || isReservedFolderName(entry.name);
}

function reservedNameError() {
  return json(400, {
    error: 'The name "Required Documents" is reserved.',
  });
}

function normalizeItemName(name) {
  return String(name || "")
    .replace(/[/\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function sanitizeFileName(name) {
  const cleaned = String(name || "document")
    .replace(/[/\\]/g, "")
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 120)
    .trim();
  return cleaned || "document";
}

function extOf(name = "") {
  const i = String(name).lastIndexOf(".");
  return i >= 0 ? String(name).slice(i).toLowerCase() : "";
}

function splitFileName(name) {
  const ext = extOf(name);
  if (!ext || ext === String(name).toLowerCase()) {
    return { base: name, ext: "" };
  }
  return { base: name.slice(0, -ext.length), ext };
}

function uniqueName(desired, existingNames, { keepExtension = false } = {}) {
  const wanted = String(desired || "").trim();
  const taken = new Set(
    (existingNames || [])
      .map((n) => String(n || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (wanted && !taken.has(wanted.toLowerCase())) return wanted;
  const { base, ext } = keepExtension
    ? splitFileName(wanted || "item")
    : { base: wanted || "item", ext: "" };
  let i = 1;
  let candidate = `${base} (${i})${ext}`;
  while (taken.has(candidate.toLowerCase())) {
    i += 1;
    candidate = `${base} (${i})${ext}`;
  }
  return candidate;
}

function validateFile({ fileName, fileSize }) {
  const ext = extOf(fileName);
  if (!ALLOWED_BY_EXT[ext]) {
    return "Invalid file type. Allowed: PDF, JPG, JPEG, PNG, DOC, DOCX, XLS, XLSX.";
  }
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) return "Empty file.";
  if (size > MAX_BYTES) return "File size exceeds the allowed limit.";
  return null;
}

function resolvedContentType(fileName, contentType) {
  const expected = ALLOWED_BY_EXT[extOf(fileName)];
  const ct = String(contentType || "").toLowerCase();
  if (ct && ct !== "application/octet-stream") return contentType;
  return expected || "application/octet-stream";
}

function decodeFileBody(file = {}) {
  const raw = file.content != null ? file.content : file.body;
  if (raw == null) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw !== "string") return null;
  const marker = "base64,";
  const idx = raw.indexOf(marker);
  const b64 = idx >= 0 ? raw.slice(idx + marker.length) : raw;
  const buf = Buffer.from(b64, "base64");
  return buf.length ? buf : null;
}

function prepareUploadFiles(files) {
  const prepared = [];
  const errors = [];
  files.forEach((file, index) => {
    const fileName = sanitizeFileName(file?.fileName);
    const body = decodeFileBody(file || {});
    const fileSize = Number(file?.fileSize || body?.length || 0);
    const error = validateFile({ fileName, fileSize });
    if (!body) {
      errors.push({
        index,
        fileName,
        error: error || "File content is required.",
      });
      return;
    }
    if (error) {
      errors.push({ index, fileName, error });
      return;
    }
    prepared.push({
      index,
      fileName,
      fileSize: body.length,
      contentType: resolvedContentType(fileName, file?.contentType),
      body,
      description: String(file?.description || "").trim(),
    });
  });
  return { prepared, errors };
}

function pinSystemFoldersFirst(children = []) {
  return [...children].sort((a, b) => {
    const as = isSystemFolder(a) ? 0 : 1;
    const bs = isSystemFolder(b) ? 0 : 1;
    return as - bs;
  });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

module.exports = {
  REQUIRED_DOCUMENTS_NAME,
  REQUIRED_DOCUMENTS_ID,
  MAX_BYTES,
  normalizePath,
  decodeSegment,
  isReservedFolderName,
  isSystemFolder,
  reservedNameError,
  normalizeItemName,
  sanitizeFileName,
  uniqueName,
  validateFile,
  prepareUploadFiles,
  pinSystemFoldersFirst,
  normalizeEmail,
};

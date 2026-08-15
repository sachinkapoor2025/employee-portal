import { apiOptional } from "../services/api";
import { getLoggedInEmail } from "../services/auth";

export function isS3ObjectKey(key) {
  const value = String(key || "").trim();
  if (!value) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) return false;
  if (/^https?:\/\//i.test(value) || value.startsWith("blob:") || value.startsWith("data:")) {
    return false;
  }
  if (value.includes("..")) return false;
  return true;
}

export function s3KeyFromFileUrl(fileUrl) {
  if (!fileUrl || typeof fileUrl !== "string") return "";
  if (fileUrl.startsWith("blob:") || fileUrl.startsWith("data:")) return "";
  const raw = String(fileUrl).split("?")[0];
  const marker = raw.indexOf("/profiles/");
  if (marker >= 0) {
    try {
      return decodeURIComponent(raw.slice(marker + 1).replace(/\+/g, "%20"));
    } catch {
      return raw.slice(marker + 1);
    }
  }
  try {
    const u = new URL(raw.replace(/ /g, "%20"));
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const host = u.hostname.toLowerCase();
    const pathStyle =
      host === "s3.amazonaws.com" ||
      /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host);
    if (pathStyle) {
      const parts = path.split("/");
      parts.shift();
      path = parts.join("/");
    }
    return isS3ObjectKey(path) ? path : "";
  } catch {
    return "";
  }
}

export function persistableDocuments(docs) {
  return (Array.isArray(docs) ? docs : []).map((d) => {
    const next = { ...d };
    delete next.downloadUrl;
    delete next.previewDataUrl;
    if (next.url && String(next.url).includes("X-Amz-Signature")) {
      delete next.url;
    }
    if (next.fileUrl && String(next.fileUrl).includes("X-Amz-Signature")) {
      next.fileUrl = String(next.fileUrl).split("?")[0];
    }
    if (next.s3Key && !next.storageKey) next.storageKey = next.s3Key;
    if (next.storageKey && !next.s3Key) next.s3Key = next.storageKey;
    return next;
  });
}

export function previewKind(fileName = "") {
  const ext = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase()
    : "";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  return "file";
}

export function mimeFromName(fileName = "") {
  const ext = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase()
    : "";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".doc") return "application/msword";
  if (ext === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (ext === ".xls") return "application/vnd.ms-excel";
  if (ext === ".xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return "";
}

export function docS3Key(doc) {
  const candidates = [
    doc?.storageKey,
    doc?.s3Key,
    s3KeyFromFileUrl(doc?.fileUrl),
    s3KeyFromFileUrl(doc?.imageUrl),
    s3KeyFromFileUrl(doc?.url),
  ];
  return candidates.find((key) => isS3ObjectKey(key)) || "";
}

function pickViewUrl(res) {
  if (!res || typeof res !== "object") return "";
  if (res.uploadUrl && !res.url && !res.downloadUrl) {
    console.error(
      "S3_SIGNED_URL_FAILED: /getProfileImageUploadUrl returned a PUT upload URL instead of a GET view URL. Deploy ImageUpload mode=view + s3:GetObject."
    );
    return "";
  }
  return res.url || res.downloadUrl || "";
}

export async function resolveDocumentViewUrl(doc = {}) {
  const email = doc.email || getLoggedInEmail();
  const storageKey = docS3Key({
    ...doc,
    fileUrl: doc.fileUrl || doc.imageUrl || doc.url,
  });

  console.log("View document:", {
    documentId: doc.documentId,
    fileName: doc.fileName,
    storageKey,
    employeeId: doc.employeeId || email,
  });
  console.log("Document ID:", doc.documentId);

  if (!storageKey) {
    console.error("INVALID_STORAGE_KEY");
    throw new Error("INVALID_STORAGE_KEY");
  }

  console.log("Requesting document URL...");
  const kind = previewKind(doc.fileName);
  const res = await apiOptional("/getProfileImageUploadUrl", "POST", {
    documentId: doc.documentId,
    fileName: doc.fileName || "document",
    contentType: doc.fileType || mimeFromName(doc.fileName),
    email,
    mode: kind === "file" ? "download" : "view",
    s3Key: storageKey,
    key: storageKey,
    storageKey,
  });
  console.log("Document URL API response:", {
    success: res?.success,
    keys: res ? Object.keys(res) : [],
    hasUrl: !!(res?.url || res?.downloadUrl),
    expiresIn: res?.expiresIn,
    message: res?.message,
  });

  const url = pickViewUrl(res);
  if (!url) {
    const code = res?.message || "S3_SIGNED_URL_FAILED";
    console.error(code);
    throw new Error(code);
  }
  if (process.env.NODE_ENV !== "production") {
    console.log("Signed URL (dev):", url);
  }
  return url;
}

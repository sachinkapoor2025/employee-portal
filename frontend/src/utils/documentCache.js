import { fetchUserProfile, saveUserProfile } from "../services/api";
import { getLoggedInEmail } from "../services/auth";

const DB_NAME = "dgv-documents";
const STORE = "files";
const memoryFiles = new Map();

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheDocumentFile(id, file) {
  if (!id || !file) return;
  memoryFiles.set(String(id), file);
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(file, String(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore cache failures */
  }
}

export async function getCachedDocumentFile(id) {
  if (!id) return null;
  const mem = memoryFiles.get(String(id));
  if (mem) return mem;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(String(id));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function getCachedDocumentUrl(id) {
  if (!id) return "";
  const mem = memoryFiles.get(String(id));
  if (mem) return URL.createObjectURL(mem);
  try {
    const db = await openDb();
    const file = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(String(id));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!file) return "";
    return URL.createObjectURL(file);
  } catch {
    return "";
  }
}

export function buildPreviewDataUrl(file) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(src);
      const attempts = [
        { max: 900, q: 0.7 },
        { max: 700, q: 0.55 },
        { max: 480, q: 0.45 },
        { max: 360, q: 0.35 },
        { max: 240, q: 0.3 },
      ];
      let last = "";
      for (const { max, q } of attempts) {
        let w = img.width;
        let h = img.height;
        if (w > max) {
          h = Math.round((h * max) / w);
          w = max;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        last = canvas.toDataURL("image/jpeg", q);
        if (last.length < 90000) {
          resolve(last);
          return;
        }
      }
      resolve(last);
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      resolve("");
    };
    img.src = src;
  });
}

export function pickLocalFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept || "*/*";
    input.style.display = "none";
    const done = (file) => {
      input.remove();
      resolve(file || null);
    };
    input.addEventListener("change", () => done(input.files?.[0] || null));
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

export async function persistDocumentPreview(doc, file) {
  if (!doc?.documentId || !file) return "";
  const email = doc.email || getLoggedInEmail();
  const previewDataUrl = await buildPreviewDataUrl(file);
  await cacheDocumentFile(doc.documentId, file);
  if (doc.s3Key) await cacheDocumentFile(doc.s3Key, file);
  if (!email || !previewDataUrl) {
    return previewDataUrl || URL.createObjectURL(file);
  }
  try {
    const profile = await fetchUserProfile(email);
    const existing = Array.isArray(profile?.hrDocuments)
      ? profile.hrDocuments
      : [];
    const hrDocuments = existing.map((d) => {
      const next =
        d.documentId === doc.documentId ? { ...d, previewDataUrl } : { ...d };
      delete next.downloadUrl;
      if (next.url && String(next.url).includes("X-Amz-Signature")) {
        delete next.url;
      }
      return next;
    });
    if (!hrDocuments.some((d) => d.documentId === doc.documentId)) {
      return previewDataUrl;
    }
    await saveUserProfile({
      mode: "EDIT",
      email,
      profile: { ...profile, email, hrDocuments },
    });
  } catch {
    /* preview still opens locally */
  }
  return previewDataUrl;
}

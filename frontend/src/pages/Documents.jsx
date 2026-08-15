import { useEffect, useState } from "react";
import Layout from "../components/Layout";
import {
  fetchMyDocuments,
  fetchUserProfile,
  saveUserProfile,
  getProfileImageUploadUrl,
} from "../services/api";
import { getLoggedInEmail } from "../services/auth";
import DocumentPreview from "../components/DocumentPreview";
import {
  persistableDocuments,
  previewKind,
  resolveDocumentViewUrl,
  s3KeyFromFileUrl,
  docS3Key,
  mimeFromName,
} from "../utils/documentView";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  formLabel,
  formInput,
} from "../theme";

const ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,application/pdf,image/jpeg,image/png,image/webp,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const ALLOWED_EXT = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
];

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatWhen(value) {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T12:00:00`);
    if (!Number.isFinite(d.getTime())) return value;
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function statusLabel(status) {
  if (status === "VERIFIED") return "VERIFIED";
  if (status === "REJECTED") return "REJECTED";
  if (status === "UNDER_REVIEW") return "UNDER REVIEW";
  return status || "UPLOADED";
}

function statusClass(status) {
  if (status === "VERIFIED") return "dgv-badge dgv-badge--success";
  if (status === "REJECTED") return "dgv-badge dgv-badge--danger";
  return "dgv-badge dgv-badge--info";
}

function isViewable(fileName = "") {
  const ext = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase()
    : "";
  return [".pdf", ".jpg", ".jpeg", ".png", ".webp"].includes(ext);
}

function withOwner(documents, email) {
  return (Array.isArray(documents) ? documents : []).map((d) => ({
    ...d,
    email: d.email || email,
    fileUrl: d.fileUrl || d.imageUrl || "",
    s3Key: docS3Key(d),
  }));
}

async function loadFromProfile() {
  const email = getLoggedInEmail();
  const profile = await fetchUserProfile();
  const documents = withOwner(profile?.hrDocuments, email);
  return { documents, maxBytes: 10 * 1024 * 1024 };
}

function uploadWithProgress(url, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("Upload failed. Please try again."));
    };
    xhr.onerror = () => reject(new Error("Upload failed. Please try again."));
    xhr.send(file);
  });
}

export default function Documents() {
  const [docs, setDocs] = useState([]);
  const [maxBytes, setMaxBytes] = useState(10 * 1024 * 1024);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [docDate, setDocDate] = useState(todayKey);
  const [file, setFile] = useState(null);
  const [description, setDescription] = useState("");
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const [preview, setPreview] = useState(null);
  const [viewingId, setViewingId] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const fallback = await loadFromProfile();
      setDocs(fallback.documents);
      setMaxBytes(fallback.maxBytes);
    } catch {
      try {
        const res = await fetchMyDocuments();
        setDocs(withOwner(res?.documents, getLoggedInEmail()));
        if (res?.maxBytes) setMaxBytes(res.maxBytes);
      } catch {
        setDocs([]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openUpload = () => {
    setModalOpen(true);
    setDocDate(todayKey());
    setFile(null);
    setDescription("");
    setProgress(0);
    setFormError("");
    setSuccess("");
  };

  const closeModal = () => {
    if (uploading) return;
    setModalOpen(false);
    setFile(null);
    setDescription("");
    setProgress(0);
    setFormError("");
  };

  const openPreview = (doc, extra = {}) => {
    setPreview({
      url: extra.url || "",
      fileName: doc.fileName || "document",
      kind: previewKind(doc.fileName),
      loading: !!extra.loading,
      error: extra.error || "",
    });
  };

  const viewDoc = async (doc) => {
    setViewingId(doc.documentId || doc.fileName || "doc");
    openPreview(doc, { loading: true });
    try {
      console.log("View document:", {
        documentId: doc.documentId,
        fileName: doc.fileName,
        storageKey: doc.storageKey || doc.s3Key,
      });
      console.log("Document ID:", doc.documentId);
      let full = { ...doc };
      try {
        const profile = await fetchUserProfile();
        const found = (
          Array.isArray(profile?.hrDocuments) ? profile.hrDocuments : []
        ).find((d) => d.documentId === doc.documentId);
        if (found) {
          full = {
            ...full,
            ...found,
            email: doc.email || getLoggedInEmail(),
            fileUrl: found.fileUrl || found.imageUrl || full.fileUrl,
            s3Key: docS3Key({
              ...full,
              ...found,
              fileUrl: found.fileUrl || found.imageUrl || full.fileUrl,
            }),
          };
        }
      } catch {
        /* use table row */
      }
      const url = await resolveDocumentViewUrl(full);
      if (!url) {
        openPreview(doc, {
          error: "Unable to load this document. Please try again.",
        });
        return;
      }
      openPreview(doc, { url });
    } catch (err) {
      const msg = String(err?.message || "S3_SIGNED_URL_FAILED");
      console.error("Document view failed:", msg);
      const error = /NOT_FOUND|not found/i.test(msg)
        ? "Document not found."
        : /UNAUTHORIZED|forbidden|denied|403/i.test(msg)
          ? "Access denied."
          : "Unable to load this document. Please try again.";
      openPreview(doc, { error });
    } finally {
      setViewingId("");
    }
  };

  const submitUpload = async (e) => {
    e.preventDefault();
    setFormError("");
    setSuccess("");
    if (!docDate) {
      setFormError("Please select a date.");
      return;
    }
    if (!file) {
      setFormError("Please choose a file.");
      return;
    }
    const ext = file.name.includes(".")
      ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
      : "";
    if (!ALLOWED_EXT.includes(ext)) {
      setFormError(
        "Invalid file type. Allowed: PDF, JPG, JPEG, PNG, DOC, DOCX, XLS, XLSX."
      );
      return;
    }
    if (file.size <= 0) {
      setFormError("Empty file.");
      return;
    }
    if (file.size > maxBytes) {
      setFormError("File size exceeds the allowed limit.");
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      const email = getLoggedInEmail();
      if (!email) throw new Error("Unable to upload. Please sign in again.");
      const contentType = mimeFromName(file.name) || file.type;
      if (!contentType) {
        setFormError("Invalid file type.");
        setUploading(false);
        return;
      }
      const meta = await getProfileImageUploadUrl(
        { name: file.name, type: contentType },
        email
      );
      await uploadWithProgress(meta.uploadUrl, file, contentType, setProgress);
      const profile = await fetchUserProfile();
      const existing = Array.isArray(profile?.hrDocuments)
        ? profile.hrDocuments
        : [];
      const now = new Date().toISOString();
      const storageKey =
        meta.s3Key ||
        meta.key ||
        s3KeyFromFileUrl(meta.imageUrl) ||
        s3KeyFromFileUrl(meta.uploadUrl);
      if (!storageKey) {
        throw new Error("INVALID_STORAGE_KEY");
      }
      const nextDoc = {
        documentId: `DOC-${Date.now()}`,
        employeeId: email,
        documentType: "OTHER",
        fileName: file.name,
        fileSize: file.size,
        fileType: contentType,
        status: "UNDER_REVIEW",
        description,
        documentDate: docDate,
        uploadedAt: now,
        updatedAt: now,
        viewable: isViewable(file.name),
        email,
        storageKey,
        s3Key: storageKey,
        fileUrl: meta.imageUrl || "",
      };
      await saveUserProfile({
        mode: "EDIT",
        email,
        profile: {
          ...profile,
          email,
          hrDocuments: persistableDocuments([...existing, nextDoc]),
        },
      });
      setSuccess("Uploaded successfully.");
      setProgress(100);
      await load();
      setTimeout(() => {
        setModalOpen(false);
        setUploading(false);
        setSuccess("");
      }, 700);
    } catch (err) {
      setFormError(err.message || "Upload failed.");
      setUploading(false);
    }
  };

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 960 }}>
        <h2 style={pageTitle}>My Documents</h2>
        <p style={pageSubtitle}>Upload and manage your required company documents.</p>

        <button
          type="button"
          className="dgv-btn dgv-btn--primary"
          onClick={openUpload}
        >
          Upload Document
        </button>

        {loading ? (
          <p style={{ color: colors.textMuted, marginTop: 20 }}>Loading documents…</p>
        ) : docs.length === 0 ? (
          <p style={{ color: colors.textMuted, marginTop: 20 }}>
            No documents uploaded yet.
          </p>
        ) : (
          <div className="dgv-table-wrap" style={{ marginTop: 20, overflowX: "auto" }}>
            <table className="dgv-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>File</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.documentId}>
                    <td>{formatWhen(d.documentDate || d.uploadedAt)}</td>
                    <td style={{ wordBreak: "break-word" }}>{d.fileName}</td>
                    <td style={{ wordBreak: "break-word" }}>{d.description || "—"}</td>
                    <td>
                      <span className={statusClass(d.status)}>{statusLabel(d.status)}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="dgv-btn dgv-btn--outline"
                        style={{ padding: "4px 10px", fontSize: 13 }}
                        onClick={() => viewDoc(d)}
                        disabled={!!viewingId}
                      >
                        {viewingId === (d.documentId || d.fileName)
                          ? "Opening…"
                          : d.viewable || isViewable(d.fileName)
                            ? "View"
                            : "Download/View"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.45)",
            zIndex: 80,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={closeModal}
        >
          <form
            onSubmit={submitUpload}
            onClick={(e) => e.stopPropagation()}
            style={{
              ...pageCard,
              maxWidth: 480,
              width: "100%",
              margin: 0,
            }}
          >
            <h3 style={{ marginTop: 0 }}>Upload Document</h3>
            <label style={formLabel}>Date</label>
            <input
              type="date"
              style={formInput}
              value={docDate}
              disabled={uploading}
              onChange={(e) => setDocDate(e.target.value)}
              required
            />
            <label style={formLabel}>Choose file</label>
            <input
              type="file"
              accept={ACCEPT}
              disabled={uploading}
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              style={{ ...formInput, padding: 8 }}
            />
            <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -10, marginBottom: 12 }}>
              PDF, JPG, PNG, DOC, DOCX, XLS, XLSX · max {Math.round(maxBytes / (1024 * 1024))} MB
            </div>
            <label style={formLabel}>Description</label>
            <input
              style={formInput}
              value={description}
              disabled={uploading}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description"
            />
            {uploading ? (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, marginBottom: 6 }}>Uploading... {progress}%</div>
                <div
                  style={{
                    height: 10,
                    borderRadius: 999,
                    background: "var(--dgv-border)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${progress}%`,
                      height: "100%",
                      background: "var(--dgv-accent)",
                    }}
                  />
                </div>
              </div>
            ) : null}
            {formError ? (
              <div className="dgv-alert dgv-alert--error">{formError}</div>
            ) : null}
            {success ? (
              <div style={{ color: "var(--dgv-success)", fontWeight: 700 }}>{success}</div>
            ) : null}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="dgv-btn dgv-btn--outline"
                disabled={uploading}
                onClick={closeModal}
              >
                Cancel
              </button>
              <button type="submit" className="dgv-btn dgv-btn--primary" disabled={uploading}>
                {uploading ? "Uploading…" : "Upload"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      <DocumentPreview
        preview={preview}
        onClose={() => {
          if (preview?.url?.startsWith("blob:")) URL.revokeObjectURL(preview.url);
          setPreview(null);
        }}
      />
    </Layout>
  );
}

import { useEffect, useMemo, useState } from "react";
import Layout from "../../components/Layout";
import {
  fetchAllDocuments,
  fetchUsers,
  fetchUserProfile,
  saveUserProfile,
  reviewDocument,
  updateDocumentTypes,
} from "../../services/api";
import DocumentPreview from "../../components/DocumentPreview";
import { previewKind, persistableDocuments, resolveDocumentViewUrl, docS3Key } from "../../utils/documentView";
import { colors, pageCard, pageTitle, pageSubtitle } from "../../theme";

function formatWhen(value) {
  if (!value) return "—";
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
  return status || "—";
}

function statusClass(status) {
  if (status === "VERIFIED") return "dgv-badge dgv-badge--success";
  if (status === "REJECTED") return "dgv-badge dgv-badge--danger";
  return "dgv-badge dgv-badge--info";
}

async function loadFromProfiles() {
  const users = await fetchUsers();
  const list = Array.isArray(users) ? users : [];
  const documents = [];
  await Promise.all(
    list.map(async (u) => {
      const email = String(u.email || "").toLowerCase();
      if (!email) return;
      try {
        const p = await fetchUserProfile(email);
        const docs = Array.isArray(p?.hrDocuments) ? p.hrDocuments : [];
        for (const d of docs) {
          documents.push({
            ...d,
            email,
            employeeName: p?.name || u.name || email,
            employeeId: p?.empId || d.employeeId,
            fileUrl: d.fileUrl || d.imageUrl || "",
            s3Key: docS3Key(d),
          });
        }
      } catch {
        /* skip employee */
      }
    })
  );
  documents.sort((a, b) =>
    String(b.uploadedAt || b.documentDate || "").localeCompare(
      String(a.uploadedAt || a.documentDate || "")
    )
  );
  return documents;
}

export default function AdminDocuments() {
  const [types, setTypes] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState("");
  const [savingTypes, setSavingTypes] = useState(false);
  const [preview, setPreview] = useState(null);

  const typeLabel = (code) => types.find((t) => t.code === code)?.label || code;

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const docs = await loadFromProfiles();
      setTypes([]);
      setDocuments(docs);
    } catch {
      try {
        const res = await fetchAllDocuments();
        setTypes(Array.isArray(res?.types) ? res.types : []);
        setDocuments(Array.isArray(res?.documents) ? res.documents : []);
      } catch {
        setTypes([]);
        setDocuments([]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const rows = useMemo(() => {
    return documents.filter((d) => !filter || d.status === filter);
  }, [documents, filter]);

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
    openPreview(doc, { loading: true });
    try {
      let full = {
        ...doc,
        fileUrl: doc.fileUrl || doc.imageUrl || "",
        s3Key: docS3Key(doc),
      };
      if (doc.email) {
        try {
          const profile = await fetchUserProfile(doc.email);
          const found = (
            Array.isArray(profile?.hrDocuments) ? profile.hrDocuments : []
          ).find((d) => d.documentId === doc.documentId);
          if (found) {
            full = {
              ...full,
              ...found,
              email: doc.email,
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
      }
      const url = await resolveDocumentViewUrl(full);
      if (!url) {
        console.log("Document view produced no URL");
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
    }
  };

  const reviewInProfile = async (documentId, status, rejectionReason = "") => {
    const doc = documents.find((d) => d.documentId === documentId);
    if (!doc?.email) throw new Error("Document not found");
    const profile = await fetchUserProfile(doc.email);
    const hrDocuments = (
      Array.isArray(profile?.hrDocuments) ? profile.hrDocuments : []
    ).map((d) =>
      d.documentId === documentId
        ? {
            ...d,
            status,
            verifiedAt: status === "VERIFIED" ? new Date().toISOString() : null,
            rejectionReason: status === "REJECTED" ? rejectionReason : "",
          }
        : d
    );
    await saveUserProfile({
      mode: "EDIT",
      email: doc.email,
      profile: {
        ...profile,
        email: doc.email,
        hrDocuments: persistableDocuments(hrDocuments),
      },
    });
  };

  const verify = async (documentId) => {
    setBusyId(documentId);
    try {
      try {
        await reviewDocument(documentId, "VERIFIED");
      } catch {
        await reviewInProfile(documentId, "VERIFIED");
      }
      await load();
    } catch (err) {
      alert(err.message || "Unable to verify");
    } finally {
      setBusyId("");
    }
  };

  const reject = async (documentId) => {
    const rejectionReason = window.prompt("Rejection Reason:") || "";
    if (!rejectionReason.trim()) {
      alert("Rejection reason is required.");
      return;
    }
    setBusyId(documentId);
    try {
      try {
        await reviewDocument(documentId, "REJECTED", rejectionReason.trim());
      } catch {
        await reviewInProfile(documentId, "REJECTED", rejectionReason.trim());
      }
      await load();
    } catch (err) {
      alert(err.message || "Unable to reject");
    } finally {
      setBusyId("");
    }
  };

  const toggleRequired = async (code) => {
    const next = types.map((t) =>
      t.code === code ? { ...t, required: !t.required } : t
    );
    setTypes(next);
    setSavingTypes(true);
    try {
      const res = await updateDocumentTypes(next);
      if (res?.types) setTypes(res.types);
    } catch (err) {
      alert(err.message || "Unable to save document types");
      await load();
    } finally {
      setSavingTypes(false);
    }
  };

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: "100%" }}>
        <h2 style={pageTitle}>Employee Documents</h2>
        <p style={pageSubtitle}>
          Review uploaded documents. Verify or reject with a reason. Required types
          can be configured below.
        </p>

        {error ? <div className="dgv-alert dgv-alert--error">{error}</div> : null}

        {types.length > 0 ? (
          <>
            <h3 style={{ marginTop: 0 }}>Required documents</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
              {types.map((t) => (
                <button
                  key={t.code}
                  type="button"
                  className={`dgv-btn ${t.required ? "dgv-btn--primary" : "dgv-btn--outline"}`}
                  style={{ padding: "6px 12px", fontSize: 13 }}
                  disabled={savingTypes}
                  onClick={() => toggleRequired(t.code)}
                >
                  {t.label} · {t.required ? "Required" : "Optional"}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <div style={{ marginBottom: 12 }}>
          <select
            className="dgv-input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter by status"
            style={{ maxWidth: 240, padding: "8px 10px", borderRadius: 10 }}
          >
            <option value="">All statuses</option>
            <option value="UNDER_REVIEW">Under Review</option>
            <option value="VERIFIED">Verified</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </div>

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading documents…</p>
        ) : (
          <div className="dgv-table-wrap" style={{ overflowX: "auto" }}>
            <table className="dgv-table" style={{ minWidth: 900, width: "100%" }}>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Document Type</th>
                  <th>File</th>
                  <th>Status</th>
                  <th>Uploaded Date</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ color: colors.textMuted }}>
                      No documents found.
                    </td>
                  </tr>
                ) : (
                  rows.map((d) => (
                    <tr key={d.documentId}>
                      <td style={{ wordBreak: "break-word" }}>
                        <div>{d.employeeName || d.email}</div>
                        <div style={{ fontSize: 12, color: colors.textMuted }}>
                          {d.email}
                        </div>
                      </td>
                      <td>{d.description || typeLabel(d.documentType) || "Document"}</td>
                      <td style={{ wordBreak: "break-word" }}>{d.fileName}</td>
                      <td>
                        <span className={statusClass(d.status)}>
                          {statusLabel(d.status)}
                        </span>
                        {d.status === "REJECTED" && d.rejectionReason ? (
                          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
                            {d.rejectionReason}
                          </div>
                        ) : null}
                      </td>
                      <td>{formatWhen(d.documentDate || d.uploadedAt)}</td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          <button
                            type="button"
                            className="dgv-btn dgv-btn--outline"
                            style={{ padding: "4px 10px", fontSize: 13 }}
                            onClick={() => viewDoc(d)}
                          >
                            View
                          </button>
                          {d.status === "UNDER_REVIEW" || d.status === "UPLOADED" ? (
                            <>
                              <button
                                type="button"
                                className="dgv-btn dgv-btn--success"
                                style={{ padding: "4px 10px", fontSize: 13 }}
                                disabled={busyId === d.documentId}
                                onClick={() => verify(d.documentId)}
                              >
                                Verify
                              </button>
                              <button
                                type="button"
                                className="dgv-btn dgv-btn--danger"
                                style={{ padding: "4px 10px", fontSize: 13 }}
                                disabled={busyId === d.documentId}
                                onClick={() => reject(d.documentId)}
                              >
                                Reject
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
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

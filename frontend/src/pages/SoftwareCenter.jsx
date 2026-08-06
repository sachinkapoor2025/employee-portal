import { useCallback, useEffect, useState } from "react";
import Layout from "../components/Layout";
import {
  fetchSoftware,
  fetchAdminSoftware,
  createSoftware,
  updateSoftware,
  deleteSoftware,
  getSoftwareUploadUrl,
} from "../services/api";
import { canAccessAdmin, getViewRole } from "../services/auth";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  formLabel,
  formInput,
  formSelect,
  buttonPrimary,
  alertSuccess,
} from "../theme";

const CATEGORIES = ["Development", "Productivity", "Security", "Communication", "DGV Tools", "General"];
const PLATFORMS = ["Windows", "Mac", "All"];

const emptyForm = {
  name: "",
  description: "",
  category: "Development",
  platform: "Windows",
  vendor: "",
  version: "",
  downloadType: "file",
  downloadUrl: "",
  s3Key: "",
};

export default function SoftwareCenter() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState("create");
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const isAdminView = canAccessAdmin() && getViewRole() === "ADMIN";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = isAdminView ? await fetchAdminSoftware() : await fetchSoftware();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [isAdminView]);

  useEffect(() => {
    load();
  }, [load]);

  const closeForm = () => {
    setShowForm(false);
    setFormMode("create");
    setEditingId(null);
    setForm(emptyForm);
    setFile(null);
    setFileKey((k) => k + 1);
  };

  const openCreate = () => {
    setFormMode("create");
    setEditingId(null);
    setForm(emptyForm);
    setFile(null);
    setFileKey((k) => k + 1);
    setShowForm(true);
  };

  const openUpdateVersion = (item) => {
    setFormMode("update");
    setEditingId(item.softwareId);
    setForm({
      name: item.name,
      description: item.description || "",
      category: item.category || "Development",
      platform: item.platform || "Windows",
      vendor: item.vendor || "",
      version: item.version || "",
      downloadType: item.downloadType || "file",
      downloadUrl: item.downloadType === "external" ? item.downloadUrl || "" : "",
      s3Key: item.s3Key || "",
    });
    setFile(null);
    setFileKey((k) => k + 1);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name) {
      alert("Software name is required");
      return;
    }

    setSaving(true);
    setMsg("");

    try {
      let payload = { ...form, downloadType: "file" };
      let replaceFile = false;

      if (file) {
        const uploadTargetId = formMode === "update" ? editingId : null;
        const { uploadUrl, s3Key } = await getSoftwareUploadUrl(file.name, uploadTargetId);
        await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        });
        payload.s3Key = s3Key;
        replaceFile = true;
      } else if (formMode === "create") {
        alert("Please select an installer file (.exe) to upload");
        setSaving(false);
        return;
      } else if (formMode === "update" && !form.s3Key) {
        alert("Select a new installer file (.exe) to upload");
        setSaving(false);
        return;
      }

      if (formMode === "update" && editingId) {
        await updateSoftware({
          softwareId: editingId,
          ...payload,
          replaceFile,
        });
        setMsg(replaceFile ? "New version uploaded — employees get the latest installer" : "Software updated");
      } else {
        await createSoftware(payload);
        setMsg("Software added to catalog");
      }

      closeForm();
      load();
    } catch (err) {
      console.error(err);
      alert(formMode === "update" ? "Failed to update software" : "Failed to save software");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (item) => {
    await updateSoftware({ softwareId: item.softwareId, active: !item.active });
    load();
  };

  const handleDelete = async (item) => {
    if (item.systemDefault) {
      alert("DGV Work Tracker is a required company tool and cannot be deleted. Use Update Version to replace the installer.");
      return;
    }
    const extra =
      item.downloadType === "file"
        ? " The uploaded installer will also be removed from storage."
        : "";
    if (
      !window.confirm(
        `Permanently delete "${item.name}" from Software Center?${extra}\n\nThis cannot be undone.`
      )
    ) {
      return;
    }
    try {
      await deleteSoftware(item.softwareId);
      setMsg(`"${item.name}" removed from catalog`);
      load();
    } catch (err) {
      console.error(err);
      alert("Failed to delete software");
    }
  };

  const grouped = items.reduce((acc, item) => {
    const cat = item.category || "General";
    acc[cat] = acc[cat] || [];
    if (item.active !== false || isAdminView) acc[cat].push(item);
    return acc;
  }, {});

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 900 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={pageTitle}>Software Center</h2>
            <p style={pageSubtitle}>
              Verified and approved software only — all installers hosted on DGV Portal (no external sites).
            </p>
          </div>
          {isAdminView && (
            <button style={buttonPrimary} onClick={openCreate}>
              + Add Software
            </button>
          )}
        </div>

        {msg && <div style={alertSuccess}>{msg}</div>}

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading...</p>
        ) : Object.keys(grouped).length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: colors.textMuted }}>
            <p>No software listed yet.</p>
            {isAdminView && (
              <p>
                Click <strong>+ Add Software</strong> to upload .exe installers. DGV Work Tracker appears automatically once the installer is on the server.
              </p>
            )}
          </div>
        ) : (
          Object.entries(grouped).map(([category, list]) => (
            <div key={category} style={{ marginTop: 24 }}>
              <h3 style={{ color: colors.primary, borderBottom: `2px solid ${colors.primaryLight}`, paddingBottom: 6 }}>
                {category}
              </h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16, marginTop: 12 }}>
                {list.map((item) => (
                  <SoftwareCard
                    key={item.softwareId}
                    item={item}
                    isAdminView={isAdminView}
                    onUpdateVersion={() => openUpdateVersion(item)}
                    onToggle={() => toggleActive(item)}
                    onDelete={() => handleDelete(item)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {showForm && isAdminView && (
        <div style={overlay}>
          <div style={modal}>
            <h3 style={{ marginTop: 0 }}>
              {formMode === "update" ? `Update — ${form.name}` : "Add Approved Software"}
            </h3>

            <p style={{ fontSize: 13, color: colors.textMuted, marginTop: 0 }}>
              Upload the Windows installer (.exe) here. Employees download only from DGV Portal — never from public websites.
            </p>

            {formMode === "update" && (
              <p style={{ fontSize: 13, color: colors.textMuted, marginTop: 0 }}>
                Upload a new .exe to replace the old installer. Employees get the latest version immediately.
              </p>
            )}

            <label style={formLabel}>Software Name</label>
            <input
              style={formInput}
              placeholder="e.g. Cursor"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              disabled={formMode === "update"}
            />

            <label style={formLabel}>Vendor</label>
            <input style={formInput} value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} />

            <label style={formLabel}>Description</label>
            <textarea style={{ ...formInput, minHeight: 60 }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />

            <label style={formLabel}>Category</label>
            <select style={formSelect} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>

            <label style={formLabel}>Platform</label>
            <select style={formSelect} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>

            <label style={formLabel}>Version</label>
            <input style={formInput} placeholder="e.g. 2.1.0" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />

            <label style={formLabel}>
              {formMode === "update" ? "New installer file (.exe)" : "Installer file (.exe)"}
            </label>
            <input key={fileKey} type="file" accept=".exe,.msi,.zip" style={formInput} onChange={(e) => setFile(e.target.files[0])} />
            {formMode === "update" && form.s3Key && !file && (
              <p style={{ fontSize: 12, color: colors.textMuted, marginTop: -8 }}>
                Current file on server. Select a new file to replace it.
              </p>
            )}
            {!form.s3Key && formMode === "update" && !file && (
              <p style={{ fontSize: 12, color: colors.warning || "#b45309", marginTop: -8 }}>
                No installer uploaded yet — select the .exe file to make this available for download.
              </p>
            )}
            {file && (
              <p style={{ fontSize: 12, color: colors.success, marginTop: -8 }}>
                Selected: {file.name}
              </p>
            )}

            <div style={{ textAlign: "right", marginTop: 8 }}>
              <button onClick={closeForm} style={{ marginRight: 8 }}>Cancel</button>
              <button style={{ ...buttonPrimary, background: colors.success }} onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : formMode === "update" ? "Save New Version" : "Add to Catalog"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

function SoftwareCard({ item, isAdminView, onUpdateVersion, onToggle, onDelete }) {
  const inactive = item.active === false;
  const canDownload = item.downloadType === "external" ? item.downloadUrl : item.fileAvailable && item.downloadUrl;
  const fileLabel = item.s3Key ? item.s3Key.split("/").pop() : null;

  return (
    <div
      style={{
        background: inactive ? "var(--dgv-surface-solid)" : "var(--dgv-card)",
        borderRadius: 12,
        padding: 16,
        border: `1px solid ${colors.border}`,
        opacity: inactive ? 0.75 : 1,
        color: "var(--dgv-text)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{item.name}</div>
          {item.vendor && <div style={{ fontSize: 12, color: colors.textMuted }}>{item.vendor}</div>}
        </div>
        <span className={`dgv-badge ${inactive ? "dgv-badge--neutral" : "dgv-badge--success"}`}>
          {inactive ? "Hidden" : "Verified"}
        </span>
      </div>

      <p style={{ fontSize: 13, color: colors.textMuted, margin: "10px 0" }}>{item.description || "Approved DGV software"}</p>

      <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 8 }}>
        {item.platform}
        {item.version ? ` · v${item.version}` : ""}
        {item.downloadType === "file" ? " · DGV hosted" : " · External link"}
      </div>

      {isAdminView && fileLabel && (
        <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 8, wordBreak: "break-all" }}>
          File: {fileLabel}
        </div>
      )}

      {isAdminView && item.updatedAt && (
        <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 8 }}>
          Updated: {new Date(item.updatedAt).toLocaleString()}
        </div>
      )}

      {canDownload ? (
        <a href={item.downloadUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
          <button style={{ ...buttonPrimary, width: "100%" }}>Download</button>
        </a>
      ) : (
        <button style={{ ...buttonPrimary, width: "100%", opacity: 0.5 }} disabled>
          {isAdminView ? "Upload installer required" : "Coming soon"}
        </button>
      )}

      {isAdminView && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          <button style={{ ...buttonPrimary, width: "100%", padding: "8px 12px", fontSize: 13 }} onClick={onUpdateVersion}>
            Update Version
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              style={{
                flex: 1,
                fontSize: 12,
                padding: "8px",
                borderRadius: 6,
                border: `1px solid ${colors.border}`,
                background: "var(--dgv-surface-solid)",
                color: "var(--dgv-text)",
                cursor: "pointer",
              }}
              onClick={onToggle}
            >
              {inactive ? "Activate" : "Hide"}
            </button>
            <button
              style={{
                flex: 1,
                fontSize: 12,
                padding: "8px",
                borderRadius: 6,
                border: "none",
                background: colors.error,
                color: "#fff",
                cursor: "pointer",
                fontWeight: 600,
                opacity: item.systemDefault ? 0.4 : 1,
              }}
              onClick={onDelete}
              disabled={item.systemDefault}
              title={item.systemDefault ? "Required company software — use Update Version" : "Delete from catalog"}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const overlay = {
  position: "fixed",
  inset: 0,
  background: "var(--dgv-overlay)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
  padding: 16,
};

const modal = {
  background: "var(--dgv-card)",
  color: "var(--dgv-text)",
  padding: 24,
  borderRadius: 12,
  maxWidth: 480,
  width: "100%",
  maxHeight: "90vh",
  overflowY: "auto",
  border: "1px solid var(--dgv-border)",
  boxShadow: "var(--dgv-shadow-lg)",
};

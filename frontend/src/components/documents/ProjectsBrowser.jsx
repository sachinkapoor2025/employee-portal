import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import Button from "../ui/Button";
import Card from "../ui/Card";
import Input from "../ui/Input";
import Modal from "../ui/Modal";
import {
  createDocumentProject,
  createDocumentProjectSubfolder,
  deleteDocumentProject,
  deleteDocumentProjectFile,
  deleteDocumentProjectFolder,
  fetchDocumentProjectFolder,
  fetchDocumentProjects,
  getDocumentProjectDownloadUrl,
  renameDocumentProject,
  renameDocumentProjectFile,
  renameDocumentProjectFolder,
  uploadDocumentProjectFiles,
} from "../../services/api";
import { PORTAL_ROLE_KEY } from "../../services/auth";
import { canManageProjectDocuments } from "../../constants/roles";
import { colors } from "../../theme";

const ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx,application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ALLOWED_EXT = [".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".xls", ".xlsx"];
const MAX_BYTES = 10 * 1024 * 1024;
const NESTING_CAP = 10;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function extOf(name = "") {
  const i = String(name).lastIndexOf(".");
  return i >= 0 ? String(name).slice(i).toLowerCase() : "";
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(value) {
  if (!value) return "";
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
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function isFileChild(child) {
  return child?.type === "file" || Boolean(child?.fileId);
}

async function countNested(projectId, folderId) {
  const data = await fetchDocumentProjectFolder(projectId, folderId);
  const kids = data.children || [];
  let folders = 0;
  let files = 0;
  const nestedIds = [];
  for (const child of kids) {
    if (isFileChild(child)) files += 1;
    else {
      folders += 1;
      nestedIds.push(child.id);
    }
  }
  const nested = await Promise.all(nestedIds.map((id) => countNested(projectId, id)));
  for (const row of nested) {
    folders += row.folders;
    files += row.files;
  }
  return { folders, files };
}

function IconAction({ label, onClick, children }) {
  return (
    <button
      type="button"
      className="dgv-icon-btn"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      style={{ width: 32, height: 32, minWidth: 32, minHeight: 32 }}
    >
      {children}
    </button>
  );
}

export default function ProjectsBrowser() {
  const location = useLocation();
  const canManage =
    location.pathname.startsWith("/admin/documents") &&
    canManageProjectDocuments(localStorage.getItem(PORTAL_ROLE_KEY));
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [trail, setTrail] = useState([]);
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [nameModal, setNameModal] = useState(null);
  const [nameValue, setNameValue] = useState("");
  const [nameError, setNameError] = useState("");

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadDate, setUploadDate] = useState(todayKey);
  const [uploadFiles, setUploadFiles] = useState([]);
  const [uploadDescription, setUploadDescription] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);

  const [deleteModal, setDeleteModal] = useState(null);

  const folderId = trail.length ? trail[trail.length - 1].id : null;
  const atGrid = !project;
  const tooDeep = trail.length >= NESTING_CAP;

  const folders = useMemo(
    () => (children || []).filter((c) => !isFileChild(c)),
    [children]
  );
  const files = useMemo(
    () => (children || []).filter((c) => isFileChild(c)),
    [children]
  );

  const loadGrid = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetchDocumentProjects();
      setProjects(Array.isArray(res?.projects) ? res.projects : []);
    } catch (err) {
      setError(err.message || "Unable to load projects.");
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFolder = useCallback(async (projectId, nextFolderId) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetchDocumentProjectFolder(projectId, nextFolderId);
      setChildren(Array.isArray(res?.children) ? res.children : []);
    } catch (err) {
      setError(err.message || "Unable to load folder.");
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (atGrid) loadGrid();
  }, [atGrid, loadGrid]);

  const openProject = (row) => {
    setProject(row);
    setTrail([{ id: "root", name: row.name }]);
    setChildren([]);
    loadFolder(row.projectId, "root");
  };

  const openFolder = (folder) => {
    if (tooDeep) return;
    setTrail((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setChildren([]);
    loadFolder(project.projectId, folder.id);
  };

  const goToTrail = (index) => {
    if (index < 0) {
      setProject(null);
      setTrail([]);
      setChildren([]);
      return;
    }
    const next = trail.slice(0, index + 1);
    setTrail(next);
    setChildren([]);
    loadFolder(project.projectId, next[next.length - 1].id);
  };

  const goBack = () => {
    if (trail.length <= 1) goToTrail(-1);
    else goToTrail(trail.length - 2);
  };

  const refresh = () => {
    if (atGrid) loadGrid();
    else loadFolder(project.projectId, folderId);
  };

  const openCreateProject = () => {
    setNameModal({ kind: "create-project" });
    setNameValue("");
    setNameError("");
  };

  const openCreateFolder = () => {
    setNameModal({ kind: "create-folder" });
    setNameValue("");
    setNameError("");
  };

  const openRename = (kind, item) => {
    setNameModal({ kind, item });
    setNameValue(item.name || "");
    setNameError("");
  };

  const submitName = async () => {
    const name = String(nameValue || "").trim();
    if (!name) {
      setNameError("Name is required.");
      return;
    }
    setBusy(true);
    setNameError("");
    try {
      if (nameModal.kind === "create-project") {
        await createDocumentProject(name);
      } else if (nameModal.kind === "create-folder") {
        await createDocumentProjectSubfolder(project.projectId, folderId, name);
      } else if (nameModal.kind === "rename-project") {
        await renameDocumentProject(nameModal.item.projectId, name);
      } else if (nameModal.kind === "rename-folder") {
        await renameDocumentProjectFolder(project.projectId, nameModal.item.id, name);
      } else if (nameModal.kind === "rename-file") {
        await renameDocumentProjectFile(
          project.projectId,
          folderId,
          nameModal.item.fileId || nameModal.item.id,
          name
        );
      }
      setNameModal(null);
      if (nameModal.kind === "rename-project" && project?.projectId === nameModal.item.projectId) {
        setProject((p) => (p ? { ...p, name } : p));
        setTrail((prev) =>
          prev.map((step, i) => (i === 0 ? { ...step, name } : step))
        );
      }
      if (nameModal.kind === "rename-folder") {
        setTrail((prev) =>
          prev.map((step) => (step.id === nameModal.item.id ? { ...step, name } : step))
        );
      }
      refresh();
    } catch (err) {
      setNameError(err.message || "Unable to save.");
    } finally {
      setBusy(false);
    }
  };

  const openDelete = async (kind, item) => {
    setDeleteModal({ kind, item, loading: true, folders: 0, files: 0 });
    if (kind === "file") {
      setDeleteModal({ kind, item, loading: false, folders: 0, files: 0 });
      return;
    }
    try {
      const targetFolderId =
        kind === "project" ? "root" : item.id;
      const targetProjectId = kind === "project" ? item.projectId : project.projectId;
      const counts = await countNested(targetProjectId, targetFolderId);
      setDeleteModal({ kind, item, loading: false, ...counts });
    } catch (err) {
      setDeleteModal({
        kind,
        item,
        loading: false,
        folders: 0,
        files: 0,
        error: err.message || "Unable to count items.",
      });
    }
  };

  const confirmDelete = async () => {
    if (!deleteModal) return;
    setBusy(true);
    try {
      if (deleteModal.kind === "project") {
        const deletedId = deleteModal.item.projectId;
        await deleteDocumentProject(deletedId);
        setDeleteModal(null);
        setProject(null);
        setTrail([]);
        setChildren([]);
        await loadGrid();
        return;
      }
      if (deleteModal.kind === "folder") {
        await deleteDocumentProjectFolder(project.projectId, deleteModal.item.id);
      } else {
        await deleteDocumentProjectFile(
          project.projectId,
          folderId,
          deleteModal.item.fileId || deleteModal.item.id
        );
      }
      setDeleteModal(null);
      refresh();
    } catch (err) {
      setError(err.message || "Unable to delete.");
      setDeleteModal(null);
    } finally {
      setBusy(false);
    }
  };

  const downloadFile = async (file) => {
    try {
      const res = await getDocumentProjectDownloadUrl(
        project.projectId,
        folderId,
        file.fileId || file.id
      );
      if (res?.downloadUrl) {
        const a = document.createElement("a");
        a.href = res.downloadUrl;
        a.rel = "noopener noreferrer";
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (err) {
      setError(err.message || "Unable to download file.");
    }
  };

  const submitUpload = async (e) => {
    e.preventDefault();
    setUploadError("");
    if (!uploadDate) {
      setUploadError("Please select a date.");
      return;
    }
    if (!uploadFiles.length) {
      setUploadError("Please choose at least one file.");
      return;
    }
    for (const file of uploadFiles) {
      if (!ALLOWED_EXT.includes(extOf(file.name))) {
        setUploadError(
          "Invalid file type. Allowed: PDF, JPG, JPEG, PNG, DOC, DOCX, XLS, XLSX."
        );
        return;
      }
      if (file.size > MAX_BYTES) {
        setUploadError("File size exceeds the allowed limit of 10 MB.");
        return;
      }
      if (file.size <= 0) {
        setUploadError("Empty file.");
        return;
      }
    }
    setUploading(true);
    try {
      const encoded = [];
      for (const file of uploadFiles) {
        encoded.push({
          fileName: file.name,
          contentType: file.type,
          fileSize: file.size,
          content: await fileToBase64(file),
        });
      }
      await uploadDocumentProjectFiles(project.projectId, folderId, {
        description: uploadDescription,
        date: uploadDate,
        files: encoded,
      });
      setUploadOpen(false);
      setUploadFiles([]);
      setUploadDescription("");
      refresh();
    } catch (err) {
      setUploadError(err.message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const nameTitle =
    nameModal?.kind === "create-project"
      ? "New project folder"
      : nameModal?.kind === "create-folder"
        ? "New folder"
        : "Rename";

  const deleteCopy = () => {
    if (!deleteModal) return "";
    const label = deleteModal.item?.name || "this item";
    if (deleteModal.kind === "file") {
      return `Delete “${label}”? This cannot be undone.`;
    }
    if (deleteModal.loading) return `Counting items inside “${label}”…`;
    const { folders: folderCount, files: fileCount } = deleteModal;
    const parts = [];
    if (folderCount) parts.push(`${folderCount} folder${folderCount === 1 ? "" : "s"}`);
    if (fileCount) parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
    const nested = parts.length ? parts.join(" and ") : "no nested items";
    const noun = deleteModal.kind === "project" ? "project folder" : "folder";
    return `Delete ${noun} “${label}”? It contains ${nested}. This cannot be undone.`;
  };

  const renderFolderCard = (item, { projectCard = false } = {}) => (
    <Card
      key={item.projectId || item.id}
      className="dgv-folder-card"
      onClick={() => (projectCard ? openProject(item) : openFolder(item))}
      style={{
        padding: 16,
        cursor: "pointer",
        minHeight: 120,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <Folder size={28} color="var(--dgv-accent)" />
        {canManage ? (
          <div
            className="dgv-folder-card__actions"
            style={{ display: "flex", gap: 4 }}
            onClick={(e) => e.stopPropagation()}
          >
            <IconAction
              label="Rename"
              onClick={() =>
                openRename(projectCard ? "rename-project" : "rename-folder", item)
              }
            >
              <Pencil size={14} />
            </IconAction>
            <IconAction
              label="Delete"
              onClick={() => openDelete(projectCard ? "project" : "folder", item)}
            >
              <Trash2 size={14} />
            </IconAction>
          </div>
        ) : null}
      </div>
      <div style={{ fontWeight: 600, wordBreak: "break-word" }}>{item.name}</div>
    </Card>
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {!atGrid ? (
            <button
              type="button"
              className="dgv-icon-btn"
              aria-label="Back"
              title="Back"
              onClick={goBack}
            >
              <ArrowLeft size={18} />
            </button>
          ) : null}
          <nav className="dgv-breadcrumb" style={{ marginBottom: 0, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => goToTrail(-1)}
              style={{
                border: "none",
                background: "none",
                color: atGrid ? "var(--dgv-text-secondary)" : "var(--dgv-text-muted)",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 12,
                padding: 0,
              }}
            >
              Projects
            </button>
            {trail.map((step, index) => (
              <span key={`${step.id}-${index}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <ChevronRight size={12} />
                <button
                  type="button"
                  onClick={() => goToTrail(index)}
                  style={{
                    border: "none",
                    background: "none",
                    color:
                      index === trail.length - 1
                        ? "var(--dgv-text-secondary)"
                        : "var(--dgv-text-muted)",
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: 12,
                    padding: 0,
                    maxWidth: 180,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {step.name}
                </button>
              </span>
            ))}
          </nav>
        </div>
        {canManage ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {atGrid ? (
              <Button onClick={openCreateProject}>New project folder</Button>
            ) : (
              <>
                {!tooDeep ? (
                  <Button variant="outline" onClick={openCreateFolder}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <FolderPlus size={16} /> New folder
                    </span>
                  </Button>
                ) : null}
                <Button onClick={() => {
                  setUploadOpen(true);
                  setUploadDate(todayKey());
                  setUploadFiles([]);
                  setUploadDescription("");
                  setUploadError("");
                }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Upload size={16} /> Upload files
                  </span>
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>

      {error ? <div className="dgv-alert dgv-alert--error">{error}</div> : null}

      {loading ? (
        <p style={{ color: colors.textMuted }}>Loading…</p>
      ) : atGrid ? (
        projects.length === 0 ? (
          <p style={{ color: colors.textMuted }}>
            {canManage
              ? "No project folders yet. Create one to get started."
              : "No project folders yet."}
          </p>
        ) : (
          <div className="dgv-kpi-grid">
            {projects.map((row) => renderFolderCard(row, { projectCard: true }))}
          </div>
        )
      ) : (
        <>
          {folders.length === 0 && files.length === 0 ? (
            <p style={{ color: colors.textMuted }}>This folder is empty.</p>
          ) : null}
          {folders.length ? (
            <div className="dgv-kpi-grid">
              {folders.map((folder) => renderFolderCard(folder))}
            </div>
          ) : null}
          {files.map((file) => (
            <div key={file.fileId || file.id} className="dgv-list-row" style={{ cursor: "default" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                <FileText size={18} color="var(--dgv-text-muted)" />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, wordBreak: "break-word" }}>{file.name}</div>
                  <div style={{ fontSize: 12, color: colors.textMuted }}>
                    {[formatSize(file.size), formatWhen(file.uploadedAt), file.description]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <IconAction label="Download" onClick={() => downloadFile(file)}>
                  <Download size={14} />
                </IconAction>
                {canManage ? (
                  <>
                    <IconAction label="Rename" onClick={() => openRename("rename-file", file)}>
                      <Pencil size={14} />
                    </IconAction>
                    <IconAction label="Delete" onClick={() => openDelete("file", file)}>
                      <Trash2 size={14} />
                    </IconAction>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </>
      )}

      <Modal
        open={!!nameModal}
        onClose={() => !busy && setNameModal(null)}
        title={nameTitle}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitName();
          }}
        >
          <Input
            label="Name"
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            disabled={busy}
            maxLength={120}
            autoFocus
          />
          {nameError ? <div className="dgv-alert dgv-alert--error">{nameError}</div> : null}
          <div className="dgv-modal__footer">
            <Button variant="outline" disabled={busy} onClick={() => setNameModal(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {nameModal?.kind?.startsWith("create") ? "Create" : "Save"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={uploadOpen}
        onClose={() => !uploading && setUploadOpen(false)}
        title="Upload files"
      >
        <form onSubmit={submitUpload}>
          <Input
            id="project-upload-date"
            label="Date"
            type="date"
            value={uploadDate}
            disabled={uploading}
            onChange={(e) => setUploadDate(e.target.value)}
            required
          />
          <Input
            id="project-upload-files"
            label="Choose files"
            type="file"
            accept={ACCEPT}
            multiple
            disabled={uploading}
            onChange={(e) => setUploadFiles(Array.from(e.target.files || []))}
            hint="PDF, JPG, PNG, DOC, DOCX, XLS, XLSX · max 10 MB each · multiple files allowed"
          />
          {uploadFiles.length ? (
            <p style={{ fontSize: 13, color: colors.textMuted, marginTop: 0 }}>
              {uploadFiles.length} file{uploadFiles.length === 1 ? "" : "s"} selected
            </p>
          ) : null}
          <Input
            label="Description"
            value={uploadDescription}
            disabled={uploading}
            onChange={(e) => setUploadDescription(e.target.value)}
            placeholder="Description"
          />
          {uploadError ? <div className="dgv-alert dgv-alert--error">{uploadError}</div> : null}
          <div className="dgv-modal__footer">
            <Button
              variant="outline"
              disabled={uploading}
              onClick={() => setUploadOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={uploading}>
              Upload
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!deleteModal}
        onClose={() => !busy && setDeleteModal(null)}
        title="Delete"
      >
        <p style={{ marginTop: 0, color: "var(--dgv-text-secondary)" }}>{deleteCopy()}</p>
        {deleteModal?.error ? (
          <div className="dgv-alert dgv-alert--error">{deleteModal.error}</div>
        ) : null}
        <div className="dgv-modal__footer">
          <Button variant="outline" disabled={busy} onClick={() => setDeleteModal(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy || deleteModal?.loading}
            loading={busy}
            onClick={confirmDelete}
          >
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
}

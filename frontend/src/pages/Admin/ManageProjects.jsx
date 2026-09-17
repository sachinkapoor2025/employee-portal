import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import Modal from "../../components/ui/Modal";
import CreateProjectModal from "../../components/CreateProjectModal";
import {
  createProject,
  deleteProject,
  fetchProjects,
  updateProject,
} from "../../services/api";
import {
  colors,
  formInput,
  formLabel,
  formSelect,
  pageCard,
  pageSubtitle,
  pageTitle,
} from "../../theme";
import {
  archiveProjectConfirmCopy,
  deleteProjectConfirmCopy,
  deleteProjectErrorCopy,
  deleteProjectResultCopy,
  emptyProjectsCopy,
  isDeletedProjectAction,
  projectNamesMatch,
  projectStatusLabel,
  restoreProjectConfirmCopy,
  unexpectedDeleteActionCopy,
} from "../../utils/workProjectManage";

function formatCreated(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function isArchivedProject(project) {
  return String(project?.status || "ACTIVE").toUpperCase() === "ARCHIVED";
}

export default function ManageProjects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [actionMenuId, setActionMenuId] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [confirmName, setConfirmName] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState("create");
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await fetchProjects({ status: statusFilter });
      setProjects(Array.isArray(list) ? list : []);
    } catch (err) {
      setProjects([]);
      setError(err?.message || "Unable to load projects.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    if (!actionMenuId) return undefined;
    const onPointerDown = (event) => {
      if (event.target.closest?.(".dgv-employees-edit-menu")) return;
      setActionMenuId("");
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [actionMenuId]);

  const closeConfirm = () => {
    if (busy) return;
    setConfirm(null);
    setConfirmName("");
    setConfirmError("");
  };

  const openCreate = () => {
    setMessage("");
    setError("");
    setActionMenuId("");
    setFormMode("create");
    setEditing(null);
    setShowForm(true);
  };

  const openEdit = (project) => {
    setMessage("");
    setError("");
    setActionMenuId("");
    setFormMode("edit");
    setEditing(project);
    setShowForm(true);
  };

  const openConfirm = (type, project) => {
    setMessage("");
    setError("");
    setActionMenuId("");
    setConfirmName("");
    setConfirmError("");
    setConfirm({ type, project });
  };

  const handleFormSubmit = async (data) => {
    setSaving(true);
    try {
      if (formMode === "edit" && editing?.projectId) {
        await updateProject(editing.projectId, data);
        setShowForm(false);
        setEditing(null);
        setMessage("Project updated.");
        await load();
        return;
      }
      const created = await createProject(data);
      setShowForm(false);
      setMessage(
        created?.name
          ? `${created.name} created.`
          : "Project created."
      );
      await load();
    } finally {
      setSaving(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm?.project || busy) return;
    const project = confirm.project;
    if (
      confirm.type === "delete" &&
      !projectNamesMatch(confirmName, project.name)
    ) {
      return;
    }
    setBusy(true);
    setConfirmError("");
    try {
      if (confirm.type === "archive") {
        await updateProject(project.projectId, { status: "ARCHIVED" });
        setConfirm(null);
        setMessage("Project archived.");
        await load();
        return;
      }
      if (confirm.type === "restore") {
        await updateProject(project.projectId, { status: "ACTIVE" });
        setConfirm(null);
        setMessage("Project restored.");
        await load();
        return;
      }
      const result = await deleteProject(project.projectId, confirmName);
      if (!isDeletedProjectAction(result?.action)) {
        const failed = unexpectedDeleteActionCopy();
        setConfirmError(failed);
        setMessage("");
        setError(failed);
        return;
      }
      setConfirm(null);
      setConfirmName("");
      setConfirmError("");
      setMessage(deleteProjectResultCopy(result?.action));
      await load();
    } catch (err) {
      setMessage("");
      if (confirm.type === "delete") {
        const failed = deleteProjectErrorCopy(err);
        setConfirmError(failed);
        setError(failed);
        return;
      }
      setConfirm(null);
      setError(err?.message || "Unable to update project.");
    } finally {
      setBusy(false);
    }
  };

  const confirmCopy =
    confirm?.type === "archive"
      ? archiveProjectConfirmCopy(confirm.project?.name)
      : confirm?.type === "restore"
        ? restoreProjectConfirmCopy(confirm.project?.name)
        : deleteProjectConfirmCopy(confirm?.project?.name);

  const deleteNameMatches = projectNamesMatch(
    confirmName,
    confirm?.project?.name
  );
  const confirmActionDisabled =
    busy || (confirm?.type === "delete" && !deleteNameMatches);

  const confirmActionLabel =
    confirm?.type === "archive"
      ? busy
        ? "Archiving..."
        : "Archive Project"
      : confirm?.type === "restore"
        ? busy
          ? "Restoring..."
          : "Restore Project"
        : busy
          ? "Deleting..."
          : "Delete Project";

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 960 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={pageTitle}>Project Management</h1>
            <p style={{ ...pageSubtitle, marginBottom: 16 }}>
              Manage your work projects, their status, and lifecycle.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="dgv-btn dgv-btn--outline"
              onClick={() => navigate("/admin/tasks")}
            >
              Back to Tasks
            </button>
            <button
              type="button"
              className="dgv-btn dgv-btn--primary"
              onClick={openCreate}
            >
              + Create Project
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 16, maxWidth: 220 }}>
          <label style={formLabel} htmlFor="project-status-filter">
            Status
          </label>
          <select
            id="project-status-filter"
            style={{ ...formSelect, marginBottom: 0 }}
            value={statusFilter}
            onChange={(e) => {
              setMessage("");
              setStatusFilter(e.target.value);
            }}
          >
            <option value="ALL">All</option>
            <option value="ACTIVE">Active</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </div>

        {error ? (
          <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        ) : null}
        {message ? (
          <p style={{ color: colors.textMuted, fontSize: 14, margin: "0 0 16px" }}>
            {message}
          </p>
        ) : null}

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading projects...</p>
        ) : projects.length === 0 ? (
          <p style={{ color: colors.textMuted }}>
            {emptyProjectsCopy(statusFilter)}
          </p>
        ) : (
          <div className="dgv-projects-table-wrap">
            <table className="dgv-table dgv-projects-table">
              <thead>
                <tr>
                  <th className="dgv-projects-table__name" style={thStyle}>
                    Name
                  </th>
                  <th className="dgv-projects-table__client" style={thStyle}>
                    Client
                  </th>
                  <th className="dgv-projects-table__created" style={thStyle}>
                    Created
                  </th>
                  <th className="dgv-projects-table__status" style={thStyle}>
                    Status
                  </th>
                  <th className="dgv-projects-table__action" style={thStyle}>
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const archived = isArchivedProject(project);
                  const menuOpen = actionMenuId === project.projectId;
                  const name = project.name || "—";
                  const client = project.client || "—";
                  return (
                    <tr key={project.projectId}>
                      <td
                        className="dgv-projects-table__name"
                        style={tdStyle}
                        title={name}
                      >
                        {name}
                      </td>
                      <td
                        className="dgv-projects-table__client"
                        style={tdStyle}
                        title={client}
                      >
                        {client}
                      </td>
                      <td className="dgv-projects-table__created" style={tdStyle}>
                        {formatCreated(project.createdAt)}
                      </td>
                      <td className="dgv-projects-table__status" style={tdStyle}>
                        <span
                          className={`dgv-badge ${
                            archived
                              ? "dgv-badge--neutral"
                              : "dgv-badge--success"
                          }`}
                        >
                          {projectStatusLabel(project.status)}
                        </span>
                      </td>
                      <td className="dgv-projects-table__action" style={tdStyle}>
                        <div className="dgv-employees-table__action-btns">
                          <div
                            className="dgv-employees-edit-menu"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="dgv-btn dgv-btn--outline"
                              aria-expanded={menuOpen}
                              aria-haspopup="menu"
                              onClick={() =>
                                setActionMenuId(menuOpen ? "" : project.projectId)
                              }
                            >
                              Take Action
                            </button>
                            {menuOpen ? (
                              <div
                                className="dgv-employees-edit-menu__dropdown"
                                role="menu"
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => openEdit(project)}
                                >
                                  Edit Project
                                </button>
                                {archived ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() =>
                                      openConfirm("restore", project)
                                    }
                                  >
                                    Restore Project
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() =>
                                      openConfirm("archive", project)
                                    }
                                  >
                                    Archive Project
                                  </button>
                                )}
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="is-danger"
                                  onClick={() => openConfirm("delete", project)}
                                >
                                  Delete Project
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateProjectModal
        open={showForm}
        mode={formMode}
        initial={
          formMode === "edit"
            ? {
                name: editing?.name || "",
                client: editing?.client || "",
                description: editing?.description || "",
              }
            : undefined
        }
        existingProjects={projects}
        excludeProjectId={formMode === "edit" ? editing?.projectId : ""}
        saving={saving}
        onClose={() => {
          if (saving) return;
          setShowForm(false);
          setEditing(null);
        }}
        onSubmit={handleFormSubmit}
      />

      <Modal
        open={Boolean(confirm)}
        title={confirmCopy.title}
        closeDisabled={busy}
        onClose={closeConfirm}
        footer={
          <>
            <button
              type="button"
              className="dgv-btn dgv-btn--outline"
              disabled={busy}
              onClick={closeConfirm}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dgv-btn dgv-btn--primary"
              disabled={confirmActionDisabled}
              onClick={runConfirm}
            >
              {confirmActionLabel}
            </button>
          </>
        }
      >
        {confirm?.type === "delete" ? (
          <div className="dgv-project-delete-confirm">
            <label style={formLabel} htmlFor="delete-project-confirm-name">
              {confirmCopy.confirmLabel}
            </label>
            <p
              id="delete-project-name-intro"
              className="dgv-project-delete-confirm__hint"
            >
              {confirmCopy.confirmIntro}
            </p>
            {confirm.project?.name ? (
              <p
                id="delete-project-name"
                data-testid="delete-project-name"
                className="dgv-project-delete-confirm__name"
              >
                {confirm.project.name}
              </p>
            ) : null}
            <p
              id="delete-project-name-hint"
              className="dgv-project-delete-confirm__hint"
            >
              {confirmCopy.confirmHint}
            </p>
            <input
              id="delete-project-confirm-name"
              className="dgv-input"
              style={{ ...formInput, marginBottom: 0 }}
              type="text"
              value={confirmName}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy}
              placeholder={
                confirmCopy.confirmPlaceholder || "Enter project name"
              }
              aria-describedby={[
                "delete-project-name-intro",
                confirm.project?.name ? "delete-project-name" : null,
                "delete-project-name-hint",
              ]
                .filter(Boolean)
                .join(" ")}
              onChange={(e) => setConfirmName(e.target.value)}
            />
          </div>
        ) : null}
        {confirm?.type === "delete" ? (
          <div className="dgv-project-delete-warning" role="status">
            <p>{confirmCopy.body}</p>
            {confirmCopy.detail ? <p>{confirmCopy.detail}</p> : null}
          </div>
        ) : (
          <>
            <p style={{ margin: 0, color: colors.text, lineHeight: 1.5 }}>
              {confirmCopy.body}
            </p>
            {confirmCopy.detail ? (
              <p
                style={{
                  margin: "12px 0 0",
                  color: colors.text,
                  lineHeight: 1.5,
                }}
              >
                {confirmCopy.detail}
              </p>
            ) : null}
          </>
        )}
        {confirm?.type === "delete" && confirmCopy.retain ? (
          <p className="dgv-project-delete-retain">{confirmCopy.retain}</p>
        ) : null}
        {confirmError ? (
          <div className="dgv-alert dgv-alert--error" style={{ marginTop: 16 }}>
            {confirmError}
          </div>
        ) : null}
      </Modal>
    </Layout>
  );
}

const thStyle = {
  textAlign: "left",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--dgv-text-muted)",
  padding: "10px 12px",
  borderBottom: "1px solid var(--dgv-border)",
};

const tdStyle = {
  fontSize: 14,
  color: "var(--dgv-text)",
  padding: "12px",
  borderBottom: "1px solid var(--dgv-border)",
  verticalAlign: "middle",
};

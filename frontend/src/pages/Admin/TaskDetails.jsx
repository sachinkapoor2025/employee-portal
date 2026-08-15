import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import {
  fetchTaskById,
  fetchTaskActivity,
  updateTask,
  fetchUsers,
  fetchUserProfile,
} from "../../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  formLabel,
  formInput,
  formSelect,
} from "../../theme";
import {
  TASK_STATUSES,
  displayTaskId,
  formatTaskDate,
  formatTaskDateTime,
  formatTaskDuration,
  formatTaskTime,
  friendlyActivityText,
  getStoredStatus,
  isTaskOverdue,
  joinDueParts,
  personLabel,
  splitDueParts,
  statusBadgeStyle,
  statusLabel,
} from "../../utils/taskStatus";

function StatusBadge({ taskOrStatus }) {
  const style = statusBadgeStyle(taskOrStatus);
  const label =
    typeof taskOrStatus === "object"
      ? statusLabel(taskOrStatus)
      : statusLabel(taskOrStatus);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: 0.3,
        background: style.bg,
        color: style.color,
        border: `1px solid ${style.border}`,
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: style.dot,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}

export default function TaskDetails() {
  const { taskId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [task, setTask] = useState(location.state?.task || null);
  const [activity, setActivity] = useState([]);
  const [users, setUsers] = useState([]);
  const [creatorName, setCreatorName] = useState("");
  const [loading, setLoading] = useState(!location.state?.task);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState(null); // edit | status | reassign
  const [editForm, setEditForm] = useState({
    title: "",
    description: "",
    assignee: "",
    dueDate: "",
    dueTime: "",
    status: "TODO",
  });

  const enrichTask = useCallback(async (t, userList) => {
    let assigneeProfile = t.assigneeProfile || null;
    if (t.assignee && !assigneeProfile?.name) {
      try {
        const profile = await fetchUserProfile(t.assignee);
        assigneeProfile = {
          email: t.assignee,
          name: profile?.name || "",
        };
      } catch {
        const row = userList.find(
          (x) =>
            String(x.email).toLowerCase() === String(t.assignee).toLowerCase()
        );
        assigneeProfile = {
          email: t.assignee,
          name: row?.name || "",
        };
      }
    }

    let createdByName = "";
    if (t.createdBy) {
      const fromList = personLabel(userList, t.createdBy);
      if (fromList.name && fromList.name !== t.createdBy.split("@")[0]) {
        createdByName = fromList.name;
      } else {
        try {
          const profile = await fetchUserProfile(t.createdBy);
          createdByName = profile?.name || fromList.name;
        } catch {
          createdByName = fromList.name;
        }
      }
    }

    return {
      ...t,
      assigneeProfile,
      createdByName,
      overdue: isTaskOverdue(t),
    };
  }, []);

  const load = useCallback(async () => {
    if (!taskId) return;
    setError("");
    setLoading((was) => was || !location.state?.task);
    try {
      const [t, u] = await Promise.all([
        fetchTaskById(taskId),
        fetchUsers().catch(() => []),
      ]);
      const userList = Array.isArray(u) ? u : [];
      const enriched = await enrichTask(t, userList);
      setUsers(userList);
      setTask(enriched);
      setCreatorName(enriched.createdByName || "");

      const dueParts = splitDueParts(enriched.dueDate);
      setEditForm({
        title: enriched.title || "",
        description: enriched.description || "",
        assignee: enriched.assignee || "",
        dueDate: dueParts.date,
        dueTime: dueParts.time,
        status: getStoredStatus(enriched),
      });

      const a = await fetchTaskActivity(taskId).catch(() => []);
      setActivity(Array.isArray(a) ? a : []);
    } catch (err) {
      console.error(err);
      setError(err.message || "Unable to load task details. Please try again.");
      if (!location.state?.task) setTask(null);
    } finally {
      setLoading(false);
    }
  }, [taskId, location.state?.task, enrichTask]);

  useEffect(() => {
    load();
  }, [load]);

  const patchTask = async (updates) => {
    const updated = await updateTask({
      taskId,
      projectId: task.projectId,
      ...updates,
    });
    const enriched = await enrichTask(
      { ...task, ...updated, overdue: isTaskOverdue({ ...task, ...updated }) },
      users
    );
    setTask(enriched);
    setCreatorName(enriched.createdByName || creatorName);
    const a = await fetchTaskActivity(taskId).catch(() => []);
    setActivity(Array.isArray(a) ? a : []);
    return enriched;
  };

  const openEdit = () => {
    const dueParts = splitDueParts(task.dueDate);
    setEditForm({
      title: task.title || "",
      description: task.description || "",
      assignee: task.assignee || "",
      dueDate: dueParts.date,
      dueTime: dueParts.time,
      status: getStoredStatus(task),
    });
    setModal("edit");
  };

  const openStatus = () => {
    setEditForm((f) => ({ ...f, status: getStoredStatus(task) }));
    setModal("status");
  };

  const openReassign = () => {
    setEditForm((f) => ({ ...f, assignee: task.assignee || "" }));
    setModal("reassign");
  };

  const handleSaveEdit = async () => {
    if (!editForm.title?.trim()) {
      alert("Task name is required");
      return;
    }
    setSaving(true);
    try {
      await patchTask({
        title: editForm.title.trim(),
        description: editForm.description || "",
        assignee: editForm.assignee,
        status: editForm.status,
        dueDate: joinDueParts(editForm.dueDate, editForm.dueTime),
      });
      setModal(null);
    } catch (err) {
      alert(err.message || "Failed to save task");
    } finally {
      setSaving(false);
    }
  };

  const handleChangeStatus = async () => {
    setSaving(true);
    try {
      await patchTask({ status: editForm.status });
      setModal(null);
    } catch (err) {
      alert(err.message || "Failed to update status");
    } finally {
      setSaving(false);
    }
  };

  const handleReassign = async () => {
    setSaving(true);
    try {
      await patchTask({ assignee: editForm.assignee });
      setModal(null);
    } catch (err) {
      alert(err.message || "Failed to reassign");
    } finally {
      setSaving(false);
    }
  };

  if (loading && !task) {
    return (
      <Layout>
        <div style={pageCard}>
          <p style={{ color: colors.textMuted }}>Loading task details...</p>
        </div>
      </Layout>
    );
  }

  if (!task) {
    return (
      <Layout>
        <div style={pageCard}>
          <p style={{ color: colors.error }}>{error || "Task not found."}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate("/admin/tasks")}
          >
            Back to Tasks
          </Button>
        </div>
      </Layout>
    );
  }

  const assigneeInfo = personLabel(users, task.assignee);
  const assignee = {
    name: task.assigneeProfile?.name || assigneeInfo.name,
    email: assigneeInfo.email,
  };
  const creator = creatorName || personLabel(users, task.createdBy).name;
  const overdue = isTaskOverdue(task);
  const timeline = [...activity].sort((a, b) => {
    const ta = new Date(a.timestamp || 0).getTime();
    const tb = new Date(b.timestamp || 0).getTime();
    return ta - tb;
  });

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 760 }}>
        {error ? (
          <div
            className="dgv-alert dgv-alert--error"
            style={{ marginBottom: 12 }}
          >
            {error}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 20,
            alignItems: "flex-start",
          }}
        >
          <div>
            <h2 style={{ ...pageTitle, marginBottom: 8 }}>Task Details</h2>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate("/admin/tasks")}
            >
              Back to Tasks
            </Button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Button type="button" onClick={openEdit}>
              Edit Task
            </Button>
            <Button type="button" variant="outline" onClick={openStatus}>
              Change Status
            </Button>
            <Button type="button" variant="outline" onClick={openReassign}>
              Reassign
            </Button>
          </div>
        </div>

        <section style={sectionBox}>
          <Label>TASK NAME</Label>
          <h3 style={{ margin: "0 0 16px", fontSize: 22, fontWeight: 700 }}>
            {task.title}
          </h3>
          <Label>STATUS</Label>
          <StatusBadge taskOrStatus={task} />
        </section>

        <section style={{ ...sectionBox, marginTop: 14 }}>
          <h3 style={sectionTitle}>TASK INFORMATION</h3>
          <InfoRow label="Task ID" value={displayTaskId(task.taskId)} />
          <InfoRow
            label="Created By"
            value={
              task.createdBy
                ? `${creator}${
                    creator !== task.createdBy ? `\n${task.createdBy}` : ""
                  }`
                : "—"
            }
          />
          <InfoRow
            label="Assigned To"
            value={
              task.assignee
                ? `${assignee.name}\n${assignee.email}`
                : "Unassigned"
            }
          />
          <InfoRow label="Created Date" value={formatTaskDate(task.createdAt)} />
          <InfoRow label="Created Time" value={formatTaskTime(task.createdAt)} />
          <InfoRow
            label="Due Date"
            value={formatTaskDate(task.dueDate)}
            danger={overdue}
          />
          <InfoRow
            label="Due Time"
            value={formatTaskTime(task.dueDate)}
            danger={overdue}
          />
          <InfoRow
            label="Duration"
            value={formatTaskDuration(task) || "—"}
          />
        </section>

        <section style={{ ...sectionBox, marginTop: 14 }}>
          <h3 style={sectionTitle}>TASK DESCRIPTION</h3>
          <p
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              lineHeight: 1.6,
              color: colors.text,
            }}
          >
            {task.description?.trim()
              ? task.description
              : "No description added."}
          </p>
        </section>

        <section style={{ ...sectionBox, marginTop: 14 }}>
          <h3 style={sectionTitle}>Task Timeline</h3>
          {timeline.length === 0 ? (
            <p style={{ margin: 0, color: colors.textMuted }}>
              No timeline events yet.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {timeline.map((ev) => (
                <li
                  key={ev.activityId || ev.SK}
                  style={{
                    padding: "12px 0 12px 14px",
                    borderLeft: "2px solid var(--dgv-accent)",
                    marginBottom: 4,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      color: colors.textMuted,
                      marginBottom: 4,
                    }}
                  >
                    {formatTaskDateTime(ev.timestamp)}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {friendlyActivityText(ev, users)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {modal === "edit" ? (
        <Modal title="Edit Task" onClose={() => setModal(null)}>
          <label style={formLabel}>Task Name</label>
          <input
            style={formInput}
            value={editForm.title}
            onChange={(e) =>
              setEditForm({ ...editForm, title: e.target.value })
            }
          />
          <label style={formLabel}>Task Description</label>
          <textarea
            style={{ ...formInput, minHeight: 90 }}
            value={editForm.description}
            onChange={(e) =>
              setEditForm({ ...editForm, description: e.target.value })
            }
          />
          <label style={formLabel}>Assigned Employee</label>
          <select
            style={formSelect}
            value={editForm.assignee}
            onChange={(e) =>
              setEditForm({ ...editForm, assignee: e.target.value })
            }
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.email} value={u.email}>
                {u.name ? `${u.name} (${u.email})` : u.email}
              </option>
            ))}
          </select>
          <label style={formLabel}>Due Date</label>
          <input
            type="date"
            style={formInput}
            value={editForm.dueDate}
            onChange={(e) =>
              setEditForm({ ...editForm, dueDate: e.target.value })
            }
          />
          <label style={formLabel}>Due Time</label>
          <input
            type="time"
            style={formInput}
            value={editForm.dueTime}
            onChange={(e) =>
              setEditForm({ ...editForm, dueTime: e.target.value })
            }
          />
          <label style={formLabel}>Status</label>
          <select
            style={formSelect}
            value={
              editForm.status === "BACKLOG" ? "TODO" : editForm.status
            }
            onChange={(e) =>
              setEditForm({ ...editForm, status: e.target.value })
            }
          >
            {TASK_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <div style={modalActions}>
            <Button type="button" variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={handleSaveEdit}
            >
              Save Changes
            </Button>
          </div>
        </Modal>
      ) : null}

      {modal === "status" ? (
        <Modal title="Change Status" onClose={() => setModal(null)}>
          <p style={{ marginTop: 0, color: colors.textMuted, fontSize: 13 }}>
            Current: <StatusBadge taskOrStatus={task} />
          </p>
          <label style={formLabel}>New Status</label>
          <select
            style={formSelect}
            value={
              editForm.status === "BACKLOG" ? "TODO" : editForm.status
            }
            onChange={(e) =>
              setEditForm({ ...editForm, status: e.target.value })
            }
          >
            {TASK_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label} — {s.hint}
              </option>
            ))}
          </select>
          <div style={modalActions}>
            <Button type="button" variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={handleChangeStatus}
            >
              Update Status
            </Button>
          </div>
        </Modal>
      ) : null}

      {modal === "reassign" ? (
        <Modal title="Reassign Task" onClose={() => setModal(null)}>
          <label style={formLabel}>Assigned Employee</label>
          <select
            style={formSelect}
            value={editForm.assignee}
            onChange={(e) =>
              setEditForm({ ...editForm, assignee: e.target.value })
            }
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.email} value={u.email}>
                {u.name ? `${u.name} (${u.email})` : u.email}
              </option>
            ))}
          </select>
          <div style={modalActions}>
            <Button type="button" variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={handleReassign}
            >
              Save
            </Button>
          </div>
        </Modal>
      ) : null}
    </Layout>
  );
}

function Label({ children }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.6,
        color: colors.textMuted,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function InfoRow({ label, value, danger }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 2 }}>
        {label}:
      </div>
      <div
        style={{
          fontWeight: 600,
          fontSize: 14,
          whiteSpace: "pre-line",
          color: danger ? "var(--dgv-danger)" : colors.text,
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

const sectionBox = {
  padding: 18,
  borderRadius: 12,
  border: "1px solid var(--dgv-border)",
  background: "var(--dgv-surface-solid)",
};

const sectionTitle = {
  margin: "0 0 14px",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 0.5,
  color: colors.textMuted,
};

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
  padding: 16,
};

const modalStyle = {
  background: "var(--dgv-card)",
  color: "var(--dgv-text)",
  padding: 24,
  borderRadius: 12,
  maxHeight: "90vh",
  overflowY: "auto",
  width: "100%",
  maxWidth: 480,
  border: "1px solid var(--dgv-border)",
  boxShadow: "var(--dgv-shadow-lg)",
};

const modalActions = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 16,
};

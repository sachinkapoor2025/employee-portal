import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
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
  TASK_PRIORITIES,
  TASK_CATEGORIES,
  displayTaskId,
  formatTaskDate,
  formatTaskDateTime,
  formatTaskDuration,
  formatTaskTime,
  friendlyActivityText,
  getStoredStatus,
  getTaskAssignees,
  getTaskTiming,
  getTaskZone,
  joinDueParts,
  isQuarterHourTime,
  personLabel,
  priorityLabel,
  splitDueParts,
  statusBadgeStyle,
  statusLabel,
  zoneDisplay,
} from "../../utils/taskStatus";
import ZoneBadge from "../../components/ZoneBadge";

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
  const employeeView = location.pathname.startsWith("/work");
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
    assignees: [],
    dueDate: "",
    dueTime: "",
    startDate: "",
    startTime: "",
    status: "TODO",
    priority: "MEDIUM",
    assignmentEmail: "",
    category: "",
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

    let createdByName = String(t.createdByName || "").trim();
    if (createdByName && createdByName.includes("@")) createdByName = "";
    if (!createdByName && t.createdBy) {
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
      const startParts = splitDueParts(enriched.startDate);
      const assigneeEmails = getTaskAssignees(enriched).map((a) => a.email);
      setEditForm({
        title: enriched.title || "",
        description: enriched.description || "",
        assignees: assigneeEmails,
        dueDate: dueParts.date,
        dueTime: dueParts.time,
        startDate: startParts.date,
        startTime: startParts.time,
        status: getStoredStatus(enriched),
        priority:
          String(enriched.priority || "MEDIUM").toUpperCase() === "URGENT"
            ? "CRITICAL"
            : enriched.priority || "MEDIUM",
        assignmentEmail: assigneeEmails[0] || "",
        category: enriched.category || "",
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
      { ...task, ...updated },
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
    const startParts = splitDueParts(task.startDate);
    setEditForm({
      title: task.title || "",
      description: task.description || "",
      assignees: getTaskAssignees(task).map((a) => a.email),
      dueDate: dueParts.date,
      dueTime: dueParts.time,
      startDate: startParts.date,
      startTime: startParts.time,
      status: getStoredStatus(task),
      priority:
        String(task.priority || "MEDIUM").toUpperCase() === "URGENT"
          ? "CRITICAL"
          : task.priority || "MEDIUM",
      assignmentEmail: getTaskAssignees(task)[0]?.email || "",
      category: task.category || "",
    });
    setModal("edit");
  };

  const openStatus = () => {
    setEditForm((f) => ({
      ...f,
      status: getStoredStatus(task),
      assignmentEmail: f.assignmentEmail || getTaskAssignees(task)[0]?.email || "",
    }));
    setModal("status");
  };

  const openReassign = () => {
    setEditForm((f) => ({
      ...f,
      assignees: getTaskAssignees(task).map((a) => a.email),
    }));
    setModal("reassign");
  };

  const toggleAssignee = (email) => {
    setEditForm((f) => {
      const current = f.assignees || [];
      const has = current.includes(email);
      return {
        ...f,
        assignees: has
          ? current.filter((x) => x !== email)
          : [...current, email],
      };
    });
  };

  const handleSaveEdit = async () => {
    if (!editForm.title?.trim()) {
      alert("Task name is required");
      return;
    }
    const nextStart = joinDueParts(editForm.startDate, editForm.startTime);
    const nextDue = joinDueParts(editForm.dueDate, editForm.dueTime);
    const originalStart = splitDueParts(task.startDate);
    const originalDue = splitDueParts(task.dueDate);
    if (
      editForm.startTime !== originalStart.time &&
      !isQuarterHourTime(editForm.startTime)
    ) {
      alert("Start time must be in 15-minute intervals (00, 15, 30, or 45).");
      return;
    }
    if (
      editForm.dueTime !== originalDue.time &&
      !isQuarterHourTime(editForm.dueTime)
    ) {
      alert("Deadline time must be in 15-minute intervals (00, 15, 30, or 45).");
      return;
    }
    if (nextStart && nextDue && new Date(nextDue).getTime() < new Date(nextStart).getTime()) {
      alert("Deadline must be after the start date and time.");
      return;
    }
    if (nextDue !== (task.dueDate || null)) {
      const ok = window.confirm(
        "Changing the deadline will recalculate Green/Orange/Red for incomplete assignees. Continue?"
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      await patchTask({
        title: editForm.title.trim(),
        description: editForm.description || "",
        assignees: editForm.assignees,
        assignee: editForm.assignees[0] || "",
        status: editForm.status,
        priority: editForm.priority,
        category: editForm.category || "",
        startDate: nextStart,
        dueDate: nextDue,
      });
      setModal(null);
    } catch (err) {
      alert(err.message || "Failed to save task");
    } finally {
      setSaving(false);
    }
  };

  const handleChangeStatus = async () => {
    if (editForm.status === "DONE") {
      const ok = window.confirm(
        "Mark this assignment as completed? Completed work will not move to Orange or Red."
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      await patchTask({
        status: editForm.status,
        assignmentEmail: editForm.assignmentEmail || undefined,
      });
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
      await patchTask({
        assignees: editForm.assignees,
        assignee: editForm.assignees[0] || "",
      });
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

  const assignees = getTaskAssignees(task);
  const assigneeNames = assignees
    .map((a) => {
      const info = personLabel(users, a.email);
      const profile = (task.assigneeProfiles || []).find(
        (p) => String(p.email).toLowerCase() === String(a.email).toLowerCase()
      );
      return profile?.name || info.name;
    })
    .join(", ");
  const creator = task.createdByName || creatorName || personLabel(users, task.createdBy).name;
  const zone = getTaskZone(task);
  const timing = getTaskTiming(task);
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
              onClick={() => navigate(employeeView ? "/work" : "/admin/tasks")}
            >
              {employeeView ? "Back to My Tasks" : "Back to Tasks"}
            </Button>
          </div>
          {employeeView ? null : (
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
          )}
        </div>

        <section style={sectionBox}>
          <Label>TASK NAME</Label>
          <h3 style={{ margin: "0 0 16px", fontSize: 22, fontWeight: 700 }}>
            {task.title}
          </h3>
          <Label>STATUS</Label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <StatusBadge taskOrStatus={task} />
            <ZoneBadge zone={zone} status={task.status} size="md" />
          </div>
          {timing ? (
            <p style={{ margin: "10px 0 0", fontSize: 13, color: colors.textMuted }}>
              {timing}
            </p>
          ) : null}
        </section>

        <section style={{ ...sectionBox, marginTop: 14 }}>
          <h3 style={sectionTitle}>TASK INFORMATION</h3>
          <InfoRow label="Task ID" value={displayTaskId(task.taskId)} />
          <InfoRow
            label="Author"
            value={
              creator || task.createdByName || task.createdBy
                ? `${creator || task.createdByName || task.createdBy}${
                    task.createdBy &&
                    creator &&
                    creator !== task.createdBy
                      ? `\n${task.createdBy}`
                      : ""
                  }`
                : "—"
            }
          />
          <InfoRow
            label="Assigned To"
            value={
              assignees.length
                ? `${assigneeNames}\n${assignees.map((a) => a.email).join("\n")}`
                : "Unassigned"
            }
          />
          <InfoRow label="Priority" value={priorityLabel(task.priority)} />
          <InfoRow label="Category" value={task.category || "—"} />
          <InfoRow label="Created Date" value={formatTaskDate(task.createdAt)} />
          <InfoRow label="Created Time" value={formatTaskTime(task.createdAt)} />
          <InfoRow
            label="Assigned / Start Date"
            value={formatTaskDate(task.startDate || task.createdAt)}
          />
          <InfoRow
            label="Assigned / Start Time"
            value={formatTaskTime(task.startDate || task.createdAt)}
          />
          <InfoRow
            label="Due Date"
            value={formatTaskDate(task.dueDate)}
            danger={zone === "RED" || zone === "ORANGE"}
          />
          <InfoRow
            label="Due Time"
            value={formatTaskTime(task.dueDate)}
            danger={zone === "RED" || zone === "ORANGE"}
          />
          <InfoRow
            label="Current Zone"
            value={`${zoneDisplay(zone, task.status).emoji} ${zoneDisplay(zone, task.status).label}`.trim()}
          />
          <InfoRow
            label="Duration"
            value={formatTaskDuration(task) || "—"}
          />
        </section>

        <section style={{ ...sectionBox, marginTop: 14 }}>
          <h3 style={sectionTitle}>INDIVIDUAL EMPLOYEE PROGRESS</h3>
          {assignees.length === 0 ? (
            <p style={{ margin: 0, color: colors.textMuted }}>No assignees yet.</p>
          ) : (
            assignees.map((a) => {
              const info = personLabel(users, a.email);
              const profile = (task.assigneeProfiles || []).find(
                (p) =>
                  String(p.email).toLowerCase() === String(a.email).toLowerCase()
              );
              const name = profile?.name || info.name;
              return (
                <div
                  key={a.email}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "center",
                    flexWrap: "wrap",
                    padding: "10px 0",
                    borderBottom: "1px solid var(--dgv-border)",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700 }}>{name}</div>
                    <div style={{ fontSize: 12, color: colors.textMuted }}>
                      {a.email}
                    </div>
                    {a.completedAt ? (
                      <div style={{ fontSize: 12, color: colors.textMuted }}>
                        Completed {formatTaskDateTime(a.completedAt)}
                      </div>
                    ) : a.timing ? (
                      <div style={{ fontSize: 12, color: colors.textMuted }}>
                        {a.timing}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <ZoneBadge zone={a.zone} status={a.status} />
                    <StatusBadge taskOrStatus={a.status} />
                  </div>
                </div>
              );
            })
          )}
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
          <label style={formLabel}>Assigned Employees</label>
          <div
            style={{
              maxHeight: 160,
              overflowY: "auto",
              border: "1px solid var(--dgv-border)",
              borderRadius: 10,
              padding: 8,
              marginBottom: 16,
            }}
          >
            {users.map((u) => (
              <label
                key={u.email}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  padding: "4px 2px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                    checked={(editForm.assignees || []).includes(u.email)}
                  onChange={() => toggleAssignee(u.email)}
                />
                {u.name ? `${u.name} (${u.email})` : u.email}
              </label>
            ))}
          </div>
          <label style={formLabel}>Priority</label>
          <select
            style={formSelect}
            value={
              editForm.priority === "URGENT" ? "CRITICAL" : editForm.priority
            }
            onChange={(e) =>
              setEditForm({ ...editForm, priority: e.target.value })
            }
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <label style={formLabel}>Category</label>
          <select
            style={formSelect}
            value={editForm.category || ""}
            onChange={(e) =>
              setEditForm({ ...editForm, category: e.target.value })
            }
          >
            <option value="">Select category</option>
            {TASK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label style={formLabel}>Start Date</label>
          <input
            type="date"
            style={formInput}
            value={editForm.startDate}
            onChange={(e) =>
              setEditForm({ ...editForm, startDate: e.target.value })
            }
          />
          <label style={formLabel}>Start Time</label>
          <input
            type="time"
            step={900}
            style={formInput}
            value={editForm.startTime}
            onChange={(e) =>
              setEditForm({ ...editForm, startTime: e.target.value })
            }
          />
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
            step={900}
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
          {assignees.length > 1 ? (
            <>
              <label style={formLabel}>Employee</label>
              <select
                style={formSelect}
                value={editForm.assignmentEmail}
                onChange={(e) =>
                  setEditForm({ ...editForm, assignmentEmail: e.target.value })
                }
              >
                {assignees.map((a) => (
                  <option key={a.email} value={a.email}>
                    {personLabel(users, a.email).name} ({a.email})
                  </option>
                ))}
              </select>
            </>
          ) : null}
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
          <label style={formLabel}>Assigned Employees</label>
          <div
            style={{
              maxHeight: 220,
              overflowY: "auto",
              border: "1px solid var(--dgv-border)",
              borderRadius: 10,
              padding: 8,
              marginBottom: 16,
            }}
          >
            {users.map((u) => (
              <label
                key={u.email}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  padding: "4px 2px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                    checked={(editForm.assignees || []).includes(u.email)}
                  onChange={() => toggleAssignee(u.email)}
                />
                {u.name ? `${u.name} (${u.email})` : u.email}
              </label>
            ))}
          </div>
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

const modalActions = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 16,
};

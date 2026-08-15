import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import {
  fetchProjects,
  fetchTasks,
  createProject,
  createTask,
  fetchUsers,
} from "../../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  formLabel,
  formInput,
  formSelect,
  buttonPrimary,
} from "../../theme";
import {
  KANBAN_COLUMNS,
  formatTaskDateTime,
  formatTaskDuration,
  isTaskOverdue,
  personLabel,
  statusBadgeStyle,
  statusLabel,
} from "../../utils/taskStatus";

function StatusBadge({ task }) {
  const style = statusBadgeStyle(task);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.3,
        background: style.bg,
        color: style.color,
        border: `1px solid ${style.border}`,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: style.dot,
          flexShrink: 0,
        }}
      />
      {statusLabel(task)}
    </span>
  );
}

export default function ManageTasks() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [showProject, setShowProject] = useState(false);
  const [showTask, setShowTask] = useState(false);
  const [projectForm, setProjectForm] = useState({
    name: "",
    client: "",
    description: "",
  });
  const [taskForm, setTaskForm] = useState({
    title: "",
    description: "",
    assignee: "",
    priority: "MEDIUM",
    status: "TODO",
    durationType: "",
    durationHours: "",
    durationDays: "",
    durationStart: "",
    durationEnd: "",
  });

  const load = useCallback(async () => {
    const [p, t, u] = await Promise.all([
      fetchProjects(),
      fetchTasks(projectId ? { projectId } : {}),
      fetchUsers(),
    ]);
    setProjects(p);
    setTasks((Array.isArray(t) ? t : []).filter((x) => !x.archived));
    setUsers(u);
    if (!projectId && p.length) setProjectId(p[0].projectId);
  }, [projectId]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const saveProject = async () => {
    await createProject(projectForm);
    setShowProject(false);
    setProjectForm({ name: "", client: "", description: "" });
    load();
  };

  const saveTask = async () => {
    await createTask({
      title: taskForm.title,
      description: taskForm.description,
      assignee: taskForm.assignee,
      priority: taskForm.priority,
      projectId,
      status: taskForm.status || "TODO",
      durationType: taskForm.durationType || null,
      durationHours: taskForm.durationHours
        ? Number(taskForm.durationHours)
        : null,
      durationDays: taskForm.durationDays ? Number(taskForm.durationDays) : null,
      durationStart: taskForm.durationStart || null,
      durationEnd: taskForm.durationEnd || null,
    });
    setShowTask(false);
    setTaskForm({
      title: "",
      description: "",
      assignee: "",
      priority: "MEDIUM",
      status: "TODO",
      durationType: "",
      durationHours: "",
      durationDays: "",
      durationStart: "",
      durationEnd: "",
    });
    load();
  };

  const byStatus = (status) =>
    tasks.filter((t) => (t.status || "TODO").toUpperCase() === status);

  const openTask = (task) => {
    navigate(`/admin/tasks/${encodeURIComponent(task.taskId)}`, {
      state: { task },
    });
  };

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 1200 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <h2 style={pageTitle}>Projects & Tasks</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={buttonPrimary}
              onClick={() => setShowProject(true)}
            >
              + Project
            </button>
            <button
              type="button"
              style={buttonPrimary}
              onClick={() => setShowTask(true)}
            >
              + Task
            </button>
          </div>
        </div>

        <label style={formLabel}>Project</label>
        <select
          style={{ ...formSelect, maxWidth: 320 }}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.projectId} value={p.projectId}>
              {p.name}
            </option>
          ))}
        </select>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 12,
            marginTop: 20,
            overflowX: "auto",
          }}
        >
          {KANBAN_COLUMNS.map((col) => (
            <div
              key={col.key}
              style={{
                background: colors.background,
                borderRadius: 10,
                padding: 10,
                minWidth: 200,
              }}
            >
              <h4
                style={{
                  margin: "0 0 10px",
                  fontSize: 13,
                  color: colors.textMuted,
                }}
              >
                {col.label}
              </h4>
              {byStatus(col.key).map((task) => {
                const person = personLabel(users, task.assignee);
                const overdue = isTaskOverdue(task);
                return (
                  <div
                    key={task.taskId}
                    role="button"
                    tabIndex={0}
                    onClick={() => openTask(task)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openTask(task);
                      }
                    }}
                    style={{
                      background: "var(--dgv-surface-solid)",
                      borderRadius: 8,
                      padding: 12,
                      marginBottom: 8,
                      boxShadow: "var(--dgv-shadow)",
                      border: `1px solid ${
                        overdue ? "rgba(239,68,68,0.45)" : colors.border
                      }`,
                      color: colors.text,
                      cursor: "pointer",
                      transition: "transform 0.2s ease, box-shadow 0.2s ease",
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
                      {task.title}
                    </div>

                    <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 2 }}>
                      Assigned to:
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                      {person.name}
                    </div>
                    {person.email ? (
                      <div
                        style={{
                          fontSize: 11,
                          color: colors.textMuted,
                          marginBottom: 10,
                          wordBreak: "break-all",
                        }}
                      >
                        {person.email}
                      </div>
                    ) : (
                      <div style={{ marginBottom: 10 }} />
                    )}

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ fontSize: 12, color: colors.textMuted }}>
                        Status:
                      </span>
                      <StatusBadge task={task} />
                    </div>

                    <div style={{ fontSize: 12, color: colors.textMuted }}>
                      Due:{" "}
                      <span
                        style={{
                          color: overdue ? "var(--dgv-danger)" : colors.text,
                          fontWeight: 600,
                        }}
                      >
                        {task.dueDate ? formatTaskDateTime(task.dueDate) : "—"}
                      </span>
                    </div>
                    {formatTaskDuration(task) ? (
                      <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 6 }}>
                        Duration:{" "}
                        <span style={{ color: colors.text, fontWeight: 600 }}>
                          {formatTaskDuration(task)}
                        </span>
                      </div>
                    ) : null}

                    <div
                      style={{
                        marginTop: 10,
                        fontSize: 11,
                        color: "var(--dgv-accent)",
                        fontWeight: 600,
                      }}
                    >
                      Click to view details →
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {showProject && (
        <Modal title="New Project" onClose={() => setShowProject(false)}>
          <Field
            label="Name"
            value={projectForm.name}
            onChange={(v) => setProjectForm({ ...projectForm, name: v })}
          />
          <Field
            label="Client"
            value={projectForm.client}
            onChange={(v) => setProjectForm({ ...projectForm, client: v })}
          />
          <Field
            label="Description"
            value={projectForm.description}
            onChange={(v) =>
              setProjectForm({ ...projectForm, description: v })
            }
          />
          <button type="button" style={buttonPrimary} onClick={saveProject}>
            Create
          </button>
        </Modal>
      )}

      {showTask && (
        <Modal title="New Task" onClose={() => setShowTask(false)}>
          <Field
            label="Title"
            value={taskForm.title}
            onChange={(v) => setTaskForm({ ...taskForm, title: v })}
          />
          <Field
            label="Description"
            value={taskForm.description}
            onChange={(v) => setTaskForm({ ...taskForm, description: v })}
          />
          <label style={formLabel}>Assignee</label>
          <select
            style={formSelect}
            value={taskForm.assignee}
            onChange={(e) =>
              setTaskForm({ ...taskForm, assignee: e.target.value })
            }
          >
            <option value="">Select</option>
            {users.map((u) => (
              <option key={u.email} value={u.email}>
                {u.name ? `${u.name} (${u.email})` : u.email}
              </option>
            ))}
          </select>
          <label style={formLabel}>Status</label>
          <select
            style={formSelect}
            value={taskForm.status}
            onChange={(e) =>
              setTaskForm({ ...taskForm, status: e.target.value })
            }
          >
            {KANBAN_COLUMNS.map((col) => (
              <option key={col.key} value={col.key}>
                {col.label}
              </option>
            ))}
          </select>
          <label style={formLabel}>Duration</label>
          <select
            style={formSelect}
            value={taskForm.durationType}
            onChange={(e) =>
              setTaskForm({
                ...taskForm,
                durationType: e.target.value,
                durationHours: "",
                durationDays: "",
                durationStart: "",
                durationEnd: "",
              })
            }
          >
            <option value="">None</option>
            <option value="HOURS">Hours</option>
            <option value="DAYS">Days</option>
            <option value="DATES">Dates</option>
          </select>
          {taskForm.durationType === "HOURS" ? (
            <Field
              label="Hours"
              type="number"
              value={taskForm.durationHours}
              onChange={(v) => setTaskForm({ ...taskForm, durationHours: v })}
            />
          ) : null}
          {taskForm.durationType === "DAYS" ? (
            <Field
              label="Days"
              type="number"
              value={taskForm.durationDays}
              onChange={(v) => setTaskForm({ ...taskForm, durationDays: v })}
            />
          ) : null}
          {taskForm.durationType === "DATES" ? (
            <>
              <Field
                label="Start Date"
                type="date"
                value={taskForm.durationStart}
                onChange={(v) =>
                  setTaskForm({ ...taskForm, durationStart: v })
                }
              />
              <Field
                label="End Date"
                type="date"
                value={taskForm.durationEnd}
                onChange={(v) => setTaskForm({ ...taskForm, durationEnd: v })}
              />
            </>
          ) : null}
          <button type="button" style={buttonPrimary} onClick={saveTask}>
            Create Task
          </button>
        </Modal>
      )}
    </Layout>
  );
}

function Modal({ title, children, onClose }) {
  return createPortal(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: 16,
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--dgv-card)",
          color: "var(--dgv-text)",
          padding: 24,
          borderRadius: 12,
          width: "100%",
          maxWidth: 440,
          border: `1px solid ${colors.border}`,
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {children}
      </div>
    </div>,
    document.body
  );
}

function Field({ label, value, onChange, type = "text" }) {
  return (
    <>
      <label style={formLabel}>{label}</label>
      <input
        style={formInput}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  );
}

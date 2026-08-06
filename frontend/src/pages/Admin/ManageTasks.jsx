import { useEffect, useState, useCallback } from "react";
import Layout from "../../components/Layout";
import {
  fetchProjects,
  fetchTasks,
  createProject,
  createTask,
  updateTask,
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

const COLUMNS = [
  { key: "BACKLOG", label: "Backlog" },
  { key: "TODO", label: "To Do" },
  { key: "IN_PROGRESS", label: "In Progress" },
  { key: "REVIEW", label: "Review" },
  { key: "DONE", label: "Done" },
];

export default function ManageTasks() {
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [showProject, setShowProject] = useState(false);
  const [showTask, setShowTask] = useState(false);
  const [projectForm, setProjectForm] = useState({ name: "", client: "", description: "" });
  const [taskForm, setTaskForm] = useState({
    title: "",
    description: "",
    assignee: "",
    priority: "MEDIUM",
    dueDate: "",
  });

  const load = useCallback(async () => {
    const [p, t, u] = await Promise.all([
      fetchProjects(),
      fetchTasks(projectId ? { projectId } : {}),
      fetchUsers(),
    ]);
    setProjects(p);
    setTasks(t);
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
    await createTask({ ...taskForm, projectId, status: "TODO" });
    setShowTask(false);
    setTaskForm({ title: "", description: "", assignee: "", priority: "MEDIUM", dueDate: "" });
    load();
  };

  const moveTask = async (task, status) => {
    await updateTask({ taskId: task.taskId, projectId: task.projectId, status });
    load();
  };

  const byStatus = (status) =>
    tasks.filter((t) => (t.status || "TODO").toUpperCase() === status);

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 1200 }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <h2 style={pageTitle}>Projects & Tasks</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={buttonPrimary} onClick={() => setShowProject(true)}>+ Project</button>
            <button style={buttonPrimary} onClick={() => setShowTask(true)}>+ Task</button>
          </div>
        </div>

        <label style={formLabel}>Project</label>
        <select style={{ ...formSelect, maxWidth: 320 }} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.projectId} value={p.projectId}>{p.name}</option>
          ))}
        </select>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginTop: 20, overflowX: "auto" }}>
          {COLUMNS.map((col) => (
            <div key={col.key} style={{ background: colors.background, borderRadius: 10, padding: 10, minWidth: 180 }}>
              <h4 style={{ margin: "0 0 10px", fontSize: 13, color: colors.textMuted }}>{col.label}</h4>
              {byStatus(col.key).map((task) => (
                <div key={task.taskId} style={{ background: "var(--dgv-surface-solid)", borderRadius: 8, padding: 10, marginBottom: 8, boxShadow: "var(--dgv-shadow)", border: `1px solid ${colors.border}`, color: colors.text, transition: "transform 0.3s ease, box-shadow 0.3s ease" }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{task.title}</div>
                  <div style={{ fontSize: 12, color: colors.textMuted, margin: "4px 0" }}>{task.assignee || "Unassigned"}</div>
                  <select
                    style={{ width: "100%", fontSize: 12, marginTop: 6 }}
                    value={task.status}
                    onChange={(e) => moveTask(task, e.target.value)}
                  >
                    {COLUMNS.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {showProject && (
        <Modal title="New Project" onClose={() => setShowProject(false)}>
          <Field label="Name" value={projectForm.name} onChange={(v) => setProjectForm({ ...projectForm, name: v })} />
          <Field label="Client" value={projectForm.client} onChange={(v) => setProjectForm({ ...projectForm, client: v })} />
          <Field label="Description" value={projectForm.description} onChange={(v) => setProjectForm({ ...projectForm, description: v })} />
          <button style={buttonPrimary} onClick={saveProject}>Create</button>
        </Modal>
      )}

      {showTask && (
        <Modal title="New Task" onClose={() => setShowTask(false)}>
          <Field label="Title" value={taskForm.title} onChange={(v) => setTaskForm({ ...taskForm, title: v })} />
          <Field label="Description" value={taskForm.description} onChange={(v) => setTaskForm({ ...taskForm, description: v })} />
          <label style={formLabel}>Assignee</label>
          <select style={formSelect} value={taskForm.assignee} onChange={(e) => setTaskForm({ ...taskForm, assignee: e.target.value })}>
            <option value="">Select</option>
            {users.map((u) => (
              <option key={u.email} value={u.email}>{u.email}</option>
            ))}
          </select>
          <Field label="Due Date" type="date" value={taskForm.dueDate} onChange={(v) => setTaskForm({ ...taskForm, dueDate: v })} />
          <button style={buttonPrimary} onClick={saveTask}>Create Task</button>
        </Modal>
      )}
    </Layout>
  );
}

const Modal = ({ title, children, onClose }) => (
  <div style={{ position: "fixed", inset: 0, background: "var(--dgv-overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000 }}>
    <div style={{ background: "var(--dgv-card)", color: "var(--dgv-text)", padding: 24, borderRadius: 12, width: 400, maxWidth: "90vw", border: "1px solid var(--dgv-border)", boxShadow: "var(--dgv-shadow-lg)" }}>
      <h3>{title}</h3>
      {children}
      <button onClick={onClose} style={{ marginTop: 12, color: "var(--dgv-text)", background: "transparent", border: "1px solid var(--dgv-border)", borderRadius: 8, padding: "8px 12px", cursor: "pointer" }}>Cancel</button>
    </div>
  </div>
);

const Field = ({ label, value, onChange, type = "text" }) => (
  <>
    <label style={formLabel}>{label}</label>
    <input type={type} style={formInput} value={value} onChange={(e) => onChange(e.target.value)} />
  </>
);

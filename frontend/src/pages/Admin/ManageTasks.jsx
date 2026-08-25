import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import { fetchProjects, fetchTaskList, createProject, createTask, fetchUsers } from "../../services/api";
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
  getTaskAssignees,
  getTaskZone,
  getTaskTiming,
  joinDueParts,
  personLabel,
  priorityLabel,
  statusBadgeStyle,
  statusLabel,
  applyClientZoneFilter,
  countZones,
  emptyZoneMessage,
  taskMatchesSearch,
  taskMatchesPriority,
  taskAssignedToClient,
  TASK_PRIORITIES,
} from "../../utils/taskStatus";
import ZoneBadge from "../../components/ZoneBadge";
import ZoneFilter from "../../components/ZoneFilter";

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

const FILTER_KEYS = {
  zone: "dgv.tasks.zone",
  search: "dgv.tasks.search",
  priority: "dgv.tasks.priority",
  employee: "dgv.tasks.employee",
};

function readFilter(key, fallback) {
  try {
    return sessionStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writeFilter(key, value) {
  try {
    if (!value) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export default function ManageTasks() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [zone, setZone] = useState(() => readFilter(FILTER_KEYS.zone, "ALL"));
  const [search, setSearch] = useState(() => readFilter(FILTER_KEYS.search, ""));
  const [searchInput, setSearchInput] = useState(() =>
    readFilter(FILTER_KEYS.search, "")
  );
  const [priorityFilter, setPriorityFilter] = useState(() =>
    readFilter(FILTER_KEYS.priority, "")
  );
  const [employeeFilter, setEmployeeFilter] = useState(() =>
    readFilter(FILTER_KEYS.employee, "")
  );
  const [zoneCounts, setZoneCounts] = useState({
    ALL: 0,
    GREEN: 0,
    ORANGE: 0,
    RED: 0,
    COMPLETED: 0,
  });
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
    assignees: [],
    priority: "MEDIUM",
    status: "TODO",
    startDate: "",
    startTime: "",
    dueDate: "",
    dueTime: "",
    durationType: "",
    durationHours: "",
    durationDays: "",
    durationStart: "",
    durationEnd: "",
  });

  const load = useCallback(async () => {
    const [p, list, u] = await Promise.all([
      fetchProjects(),
      fetchTaskList({
        ...(projectId ? { projectId } : {}),
        ...(search.trim() ? { q: search.trim() } : {}),
        ...(priorityFilter ? { priority: priorityFilter } : {}),
        ...(employeeFilter ? { assignee: employeeFilter } : {}),
        ...(zone && zone !== "ALL" ? { zone } : {}),
      }),
      fetchUsers(),
    ]);
    const raw = (Array.isArray(list.tasks) ? list.tasks : []).filter(
      (x) => !x.archived
    );
    const scoped = raw.filter(
      (t) =>
        taskMatchesSearch(t, search) &&
        taskMatchesPriority(t, priorityFilter) &&
        taskAssignedToClient(t, employeeFilter)
    );
    const filtered = applyClientZoneFilter(
      scoped,
      zone,
      employeeFilter || ""
    );
    setProjects(p);
    setTasks(filtered);
    setZoneCounts(
      list.zoneCounts || countZones(scoped, employeeFilter || "")
    );
    setUsers(Array.isArray(u) ? u : []);
    if (!projectId && p.length) setProjectId(p[0].projectId);
  }, [projectId, zone, search, priorityFilter, employeeFilter]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    writeFilter(FILTER_KEYS.zone, zone === "ALL" ? "" : zone);
  }, [zone]);
  useEffect(() => {
    writeFilter(FILTER_KEYS.search, search);
  }, [search]);
  useEffect(() => {
    writeFilter(FILTER_KEYS.priority, priorityFilter);
  }, [priorityFilter]);
  useEffect(() => {
    writeFilter(FILTER_KEYS.employee, employeeFilter);
  }, [employeeFilter]);

  const saveProject = async () => {
    await createProject(projectForm);
    setShowProject(false);
    setProjectForm({ name: "", client: "", description: "" });
    load();
  };

  const saveTask = async () => {
    if (!projectId) {
      alert("Select a project before creating a task.");
      return;
    }
    if (!taskForm.title?.trim()) {
      alert("Task title is required");
      return;
    }
    await createTask({
      title: taskForm.title,
      description: taskForm.description,
      assignees: taskForm.assignees,
      assignee: taskForm.assignees[0] || "",
      priority: taskForm.priority,
      projectId,
      status: taskForm.status || "TODO",
      startDate: joinDueParts(taskForm.startDate, taskForm.startTime),
      dueDate: joinDueParts(taskForm.dueDate, taskForm.dueTime),
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
      assignees: [],
      priority: "MEDIUM",
      status: "TODO",
      startDate: "",
      startTime: "",
      dueDate: "",
      dueTime: "",
      durationType: "",
      durationHours: "",
      durationDays: "",
      durationStart: "",
      durationEnd: "",
    });
    load();
  };

  const toggleAssignee = (email) => {
    setTaskForm((f) => {
      const has = f.assignees.includes(email);
      return {
        ...f,
        assignees: has
          ? f.assignees.filter((x) => x !== email)
          : [...f.assignees, email],
      };
    });
  };

  const byStatus = (status) => {
    if (zone === "COMPLETED") {
      return status === "DONE" ? tasks : [];
    }
    return tasks.filter((t) => (t.status || "TODO").toUpperCase() === status);
  };

  const filtersActive =
    zone !== "ALL" ||
    !!searchInput.trim() ||
    !!priorityFilter ||
    !!employeeFilter;

  const clearFilters = () => {
    setZone("ALL");
    setSearch("");
    setSearchInput("");
    setPriorityFilter("");
    setEmployeeFilter("");
  };

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

        <label style={formLabel}>Search tasks</label>
        <input
          style={{ ...formInput, maxWidth: 420 }}
          placeholder="Search tasks..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >
          <div style={{ minWidth: 180, flex: "1 1 180px" }}>
            <label style={formLabel}>Priority</label>
            <select
              style={formSelect}
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
            >
              <option value="">All priorities</option>
              {TASK_PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ minWidth: 220, flex: "1 1 220px" }}>
            <label style={formLabel}>Employee</label>
            <select
              style={formSelect}
              value={employeeFilter}
              onChange={(e) => setEmployeeFilter(e.target.value)}
            >
              <option value="">All employees</option>
              {users.map((u) => (
                <option key={u.email} value={u.email}>
                  {u.name ? `${u.name} (${u.email})` : u.email}
                </option>
              ))}
            </select>
          </div>
          {filtersActive ? (
            <button
              type="button"
              onClick={clearFilters}
              style={{
                ...buttonPrimary,
                background: "transparent",
                color: colors.text,
                border: `1px solid ${colors.border}`,
                boxShadow: "none",
                marginBottom: 16,
              }}
            >
              Clear Filters
            </button>
          ) : null}
        </div>

        <label style={formLabel}>Zone</label>
        <ZoneFilter
          value={zone}
          onChange={setZone}
          counts={{
            ALL: zoneCounts.ALL ?? zoneCounts.all,
            GREEN: zoneCounts.GREEN ?? zoneCounts.green,
            ORANGE: zoneCounts.ORANGE ?? zoneCounts.orange,
            RED: zoneCounts.RED ?? zoneCounts.red,
            COMPLETED: zoneCounts.COMPLETED ?? zoneCounts.completed,
          }}
        />

        {tasks.length === 0 ? (
          <p style={{ color: colors.textMuted, marginTop: 16 }}>
            {emptyZoneMessage(zone)}
          </p>
        ) : (
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
                const shown =
                  task.matchedAssignments || getTaskAssignees(task);
                const people = shown.map((a) => personLabel(users, a.email));
                const zoneKey =
                  shown.length === 1
                    ? shown[0].zone || getTaskZone(task)
                    : getTaskZone(task);
                const timing =
                  shown.length === 1
                    ? shown[0].timing || getTaskTiming(task)
                    : getTaskTiming(task);
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
                        zoneKey === "RED"
                          ? "rgba(239,68,68,0.45)"
                          : zoneKey === "ORANGE"
                          ? "rgba(249,115,22,0.45)"
                          : colors.border
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
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                      {people.length
                        ? people.map((p) => p.name).join(", ")
                        : "Unassigned"}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <ZoneBadge
                        zone={zoneKey}
                        status={
                          shown.length === 1 ? shown[0].status : task.status
                        }
                      />
                      <StatusBadge task={task} />
                    </div>
                    <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 6 }}>
                      Priority:{" "}
                      <span style={{ color: colors.text, fontWeight: 600 }}>
                        {priorityLabel(task.priority)}
                      </span>
                    </div>

                    <div style={{ fontSize: 12, color: colors.textMuted }}>
                      Due:{" "}
                      <span
                        style={{
                          color:
                            zoneKey === "RED" || zoneKey === "ORANGE"
                              ? "var(--dgv-danger)"
                              : colors.text,
                          fontWeight: 600,
                        }}
                      >
                        {task.dueDate ? formatTaskDateTime(task.dueDate) : "—"}
                      </span>
                    </div>
                    {timing ? (
                      <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                        {timing}
                      </div>
                    ) : null}
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
        )}
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
          <label style={formLabel}>Assignees</label>
          <div
            style={{
              maxHeight: 160,
              overflowY: "auto",
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
              padding: 8,
              marginBottom: 16,
            }}
          >
            {users.length === 0 ? (
              <div style={{ fontSize: 13, color: colors.textMuted }}>No users loaded</div>
            ) : (
              users.map((u) => (
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
                    checked={taskForm.assignees.includes(u.email)}
                    onChange={() => toggleAssignee(u.email)}
                  />
                  {u.name ? `${u.name} (${u.email})` : u.email}
                </label>
              ))
            )}
          </div>
          <label style={formLabel}>Priority</label>
          <select
            style={formSelect}
            value={
              taskForm.priority === "URGENT" ? "CRITICAL" : taskForm.priority
            }
            onChange={(e) =>
              setTaskForm({ ...taskForm, priority: e.target.value })
            }
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <Field
            label="Start date"
            type="date"
            value={taskForm.startDate}
            onChange={(v) => setTaskForm({ ...taskForm, startDate: v })}
          />
          <Field
            label="Start time"
            type="time"
            value={taskForm.startTime}
            onChange={(v) => setTaskForm({ ...taskForm, startTime: v })}
          />
          <Field
            label="Deadline date"
            type="date"
            value={taskForm.dueDate}
            onChange={(v) => setTaskForm({ ...taskForm, dueDate: v })}
          />
          <Field
            label="Deadline time"
            type="time"
            value={taskForm.dueTime}
            onChange={(v) => setTaskForm({ ...taskForm, dueTime: v })}
          />
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

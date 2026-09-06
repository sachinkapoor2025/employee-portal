import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import Modal, { confirmDiscardIfDirty } from "../../components/ui/Modal";
import TaskTimePicker, {
  nextQuarterHourKolkata,
} from "../../components/TaskTimePicker";
import TaskDatePicker from "../../components/TaskDatePicker";
import { fetchProjects, fetchTaskList, createProject, createTask, fetchUsers } from "../../services/api";
import { getLoggedInDisplayName, getLoggedInEmail } from "../../services/auth";
import { displayNameFromEmail } from "../../utils/meetings";
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
  isQuarterHourTime,
  personLabel,
  priorityLabel,
  statusBadgeStyle,
  statusLabel,
  applyClientZoneFilter,
  countZones,
  emptyZoneMessage,
  taskMatchesSearch,
  taskAssignedToClient,
  TASK_PRIORITIES,
  TASK_CATEGORIES,
  TITLE_MAX,
  DESCRIPTION_MAX,
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

const COLUMN_PREVIEW_LIMIT = 4;
const AUTHOR_MAX = 80;

function currentAuthorName(users) {
  const email = getLoggedInEmail();
  const fromJwt = getLoggedInDisplayName();
  if (fromJwt) return fromJwt;
  const row = (users || []).find(
    (u) => String(u.email).toLowerCase() === String(email).toLowerCase()
  );
  const profileName = String(row?.name || "").trim();
  if (profileName && !profileName.includes("@")) return profileName;
  return displayNameFromEmail(email);
}

function taskAuthorLabel(task, users) {
  const stored = String(task?.createdByName || "").trim();
  if (stored && !stored.includes("@")) return stored;
  if (task?.createdBy) return personLabel(users, task.createdBy).name;
  return "";
}

function TaskCard({ task, users, onOpen }) {
  const shown = task.matchedAssignments || getTaskAssignees(task);
  const people = shown.map((a) => personLabel(users, a.email));
  const author = taskAuthorLabel(task, users);
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
      role="button"
      tabIndex={0}
      onClick={() => onOpen(task)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(task);
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
        {people.length ? people.map((p) => p.name).join(", ") : "Unassigned"}
      </div>
      {task.category ? (
        <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 6 }}>
          Category:{" "}
          <span style={{ color: colors.text, fontWeight: 600 }}>
            {task.category}
          </span>
        </div>
      ) : null}
      {author ? (
        <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 6 }}>
          Author:{" "}
          <span style={{ color: colors.text, fontWeight: 600 }}>
            {author}
          </span>
        </div>
      ) : null}
      {shown.length > 1 ? (
        <div style={{ marginBottom: 8 }}>
          {shown.map((a) => (
            <div
              key={a.email}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
                marginBottom: 4,
                fontSize: 12,
              }}
            >
              <span style={{ fontWeight: 600 }}>
                {personLabel(users, a.email).name}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                <StatusBadge task={a} />
                <ZoneBadge zone={a.zone} status={a.status} />
              </span>
            </div>
          ))}
        </div>
      ) : (
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
            status={shown[0]?.status || task.status}
          />
          <StatusBadge task={task} />
        </div>
      )}
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
}

const FILTER_KEYS = {
  zone: "dgv.tasks.zone",
  search: "dgv.tasks.search",
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
  const emptyProjectForm = { name: "", client: "", description: "" };
  const [showProject, setShowProject] = useState(false);
  const [showTask, setShowTask] = useState(false);
  const [projectForm, setProjectForm] = useState(emptyProjectForm);
  const [taskBaseline, setTaskBaseline] = useState(null);
  const [taskForm, setTaskForm] = useState({
    title: "",
    description: "",
    category: "",
    assignees: [],
    priority: "MEDIUM",
    startDate: "",
    startTime: "",
    dueDate: "",
    dueTime: "",
    projectId: "",
  });
  const [projectModalSource, setProjectModalSource] = useState("page");
  const [creatingProject, setCreatingProject] = useState(false);
  const [assigneeQuery, setAssigneeQuery] = useState("");
  const [showAllAssignees, setShowAllAssignees] = useState(false);
  const [showAllResults, setShowAllResults] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [savingTask, setSavingTask] = useState(false);

  const load = useCallback(async () => {
    const [p, list, u] = await Promise.all([
      fetchProjects(),
      fetchTaskList({
        ...(projectId ? { projectId } : {}),
        ...(search.trim() ? { q: search.trim() } : {}),
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
  }, [projectId, zone, search, employeeFilter]);

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
    writeFilter(FILTER_KEYS.employee, employeeFilter);
  }, [employeeFilter]);

  const resumeTaskAfterProject = (project) => {
    if (project?.projectId) {
      setProjects((prev) =>
        prev.some((p) => p.projectId === project.projectId)
          ? prev
          : [...prev, project]
      );
      setTaskForm((f) => ({ ...f, projectId: project.projectId }));
      setFormErrors((e) => {
        const next = { ...e };
        delete next.projectId;
        return next;
      });
    }
    setShowProject(false);
    setProjectForm(emptyProjectForm);
    setProjectModalSource("page");
    setShowTask(true);
  };

  const saveProject = async () => {
    const name = String(projectForm.name || "").trim();
    if (!name) return;
    const existing = projects.find(
      (p) => String(p.name || "").trim().toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      if (projectModalSource === "task") {
        resumeTaskAfterProject(existing);
        return;
      }
      setProjectId(existing.projectId);
      setShowProject(false);
      setProjectForm(emptyProjectForm);
      return;
    }
    setCreatingProject(true);
    try {
      const created = await createProject({ ...projectForm, name });
      if (projectModalSource === "task") {
        resumeTaskAfterProject(created);
        return;
      }
      setShowProject(false);
      setProjectForm(emptyProjectForm);
      if (created?.projectId) setProjectId(created.projectId);
      load();
    } catch (err) {
      alert(err?.message || "Unable to create project.");
    } finally {
      setCreatingProject(false);
    }
  };

  const emptyTaskForm = {
    title: "",
    description: "",
    category: "",
    authorName: currentAuthorName(users),
    assignees: [],
    priority: "MEDIUM",
    startDate: "",
    startTime: "",
    dueDate: "",
    dueTime: "",
    projectId: "",
  };

  const saveTask = async () => {
    const errors = {};
    const title = taskForm.title.trim();
    if (!taskForm.projectId) {
      errors.projectId = "Please select a project.";
    }
    if (!title) errors.title = "Task title is required.";
    else if (title.length > TITLE_MAX) {
      errors.title = `Title must be ${TITLE_MAX} characters or fewer.`;
    }
    if ((taskForm.description || "").length > DESCRIPTION_MAX) {
      errors.description = `Description must be ${DESCRIPTION_MAX} characters or fewer.`;
    }
    const authorName = (taskForm.authorName || "").trim();
    if (!authorName) errors.authorName = "Author name is required.";
    else if (authorName.length > AUTHOR_MAX) {
      errors.authorName = `Author name must be ${AUTHOR_MAX} characters or fewer.`;
    }
    if (!taskForm.assignees.length) {
      errors.assignees = "Please select at least one assignee.";
    }
    if (!taskForm.priority) errors.priority = "Please select a priority.";
    if (!taskForm.startDate || !taskForm.startTime) {
      errors.startDate = "Start date and time are required.";
    } else if (!isQuarterHourTime(taskForm.startTime)) {
      errors.startTime = "Start time must be in 15-minute intervals (00, 15, 30, or 45).";
    }
    if (!taskForm.dueDate || !taskForm.dueTime) {
      errors.dueDate = "Deadline date and time are required.";
    } else if (!isQuarterHourTime(taskForm.dueTime)) {
      errors.dueTime = "Deadline time must be in 15-minute intervals (00, 15, 30, or 45).";
    }
    const startIso = joinDueParts(taskForm.startDate, taskForm.startTime);
    const dueIso = joinDueParts(taskForm.dueDate, taskForm.dueTime);
    if (startIso && dueIso && new Date(dueIso).getTime() < new Date(startIso).getTime()) {
      errors.dueDate = "Deadline must be after the start date and time.";
    }
    if (Object.keys(errors).length) {
      setFormErrors(errors);
      return;
    }

    setSavingTask(true);
    setFormErrors({});
    try {
      await createTask({
        title,
        description: taskForm.description || "",
        category: taskForm.category || "",
        authorName,
        createdByName: authorName,
        assignees: taskForm.assignees,
        assignee: taskForm.assignees[0] || "",
        priority: taskForm.priority,
        projectId: taskForm.projectId,
        startDate: startIso,
        dueDate: dueIso,
      });
      setShowTask(false);
      setTaskForm(emptyTaskForm);
      setAssigneeQuery("");
      setShowAllAssignees(false);
      load();
    } catch (err) {
      setFormErrors({
        form: err.message || "Unable to create task. Please try again.",
      });
    } finally {
      setSavingTask(false);
    }
  };

  const CREATE_PROJECT_VALUE = "__create_project__";

  const openProjectFromTask = () => {
    setProjectModalSource("task");
    setProjectForm(emptyProjectForm);
    setShowTask(false);
    setShowProject(true);
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

  const assigneeMatches = users.filter((u) => {
    const q = assigneeQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      String(u.name || "").toLowerCase().includes(q) ||
      String(u.email || "").toLowerCase().includes(q)
    );
  });
  const showAssigneeList = showAllAssignees || !!assigneeQuery.trim();

  const byStatus = (status) => {
    if (zone === "COMPLETED") {
      return status === "DONE" ? tasks : [];
    }
    return tasks.filter((t) => (t.status || "TODO").toUpperCase() === status);
  };

  const columnGroups = KANBAN_COLUMNS.map((col) => {
    const items = byStatus(col.key);
    return {
      ...col,
      items,
      preview: items.slice(0, COLUMN_PREVIEW_LIMIT),
      overflow: items.slice(COLUMN_PREVIEW_LIMIT),
    };
  });
  const overflowGroups = columnGroups.filter((g) => g.overflow.length > 0);

  const filtersActive =
    zone !== "ALL" || !!searchInput.trim() || !!employeeFilter;

  const clearFilters = () => {
    setZone("ALL");
    setSearch("");
    setSearchInput("");
    setEmployeeFilter("");
  };

  const openTask = (task) => {
    navigate(`/admin/tasks/${encodeURIComponent(task.taskId)}`, {
      state: { task },
    });
  };

  const projectDirty = Boolean(
    String(projectForm.name || "").trim() ||
      String(projectForm.client || "").trim() ||
      String(projectForm.description || "").trim()
  );
  const taskDirty =
    !!taskBaseline && JSON.stringify(taskForm) !== JSON.stringify(taskBaseline);

  const closeProjectModal = () => {
    const fromTask = projectModalSource === "task";
    setShowProject(false);
    setProjectForm(emptyProjectForm);
    setProjectModalSource("page");
    if (fromTask) setShowTask(true);
  };

  const closeTaskModal = () => {
    if (savingTask) return;
    setShowTask(false);
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
              className="dgv-btn dgv-btn--secondary"
              onClick={() => {
                setProjectModalSource("page");
                setProjectForm(emptyProjectForm);
                setShowProject(true);
              }}
            >
              + Project
            </button>
            <button
              type="button"
              className="dgv-btn dgv-btn--primary"
              onClick={() => {
                const next = {
                  ...emptyTaskForm,
                  projectId: projectId || "",
                  startTime: nextQuarterHourKolkata(),
                  dueTime: nextQuarterHourKolkata(),
                };
                setTaskForm(next);
                setTaskBaseline(next);
                setFormErrors({});
                setAssigneeQuery("");
                setShowAllAssignees(false);
                setShowTask(true);
              }}
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
          <option value="">All Projects</option>
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
        <>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 12,
            marginTop: 20,
            overflowX: "auto",
          }}
        >
          {columnGroups.map((col) => (
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
                {col.label} ({col.items.length})
              </h4>
              {col.preview.map((task) => (
                <TaskCard
                  key={task.taskId}
                  task={task}
                  users={users}
                  onOpen={openTask}
                />
              ))}
              {col.overflow.length ? (
                <button
                  type="button"
                  onClick={() => setShowAllResults(true)}
                  style={{
                    display: "block",
                    width: "100%",
                    border: "none",
                    background: "transparent",
                    fontSize: 12,
                    color: "var(--dgv-accent)",
                    fontWeight: 600,
                    padding: "4px 2px 2px",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  +{col.overflow.length} more in All Results
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {overflowGroups.length ? (
          <div style={{ marginTop: 20 }}>
            <button
              type="button"
              onClick={() => setShowAllResults((v) => !v)}
              style={{
                ...buttonPrimary,
                background: "transparent",
                color: colors.text,
                border: `1px solid ${colors.border}`,
                boxShadow: "none",
              }}
            >
              {showAllResults ? "Hide all results" : "Show all results"}
            </button>
          </div>
        ) : null}
        {showAllResults && overflowGroups.length ? (
          <div style={{ marginTop: 28 }}>
            <h3
              style={{
                margin: "0 0 8px",
                fontSize: 18,
                fontWeight: 700,
              }}
            >
              All Results
            </h3>
            <p
              style={{
                margin: "0 0 14px",
                fontSize: 13,
                color: colors.textMuted,
              }}
            >
              Tasks beyond the top {COLUMN_PREVIEW_LIMIT} in each column.
            </p>
            {overflowGroups.map((col) => (
              <div key={`all-${col.key}`} style={{ marginBottom: 18 }}>
                <h4
                  style={{
                    margin: "0 0 10px",
                    fontSize: 13,
                    color: colors.textMuted,
                  }}
                >
                  {col.label} ({col.overflow.length})
                </h4>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                    gap: 12,
                  }}
                >
                  {col.overflow.map((task) => (
                    <TaskCard
                      key={task.taskId}
                      task={task}
                      users={users}
                      onOpen={openTask}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        </>
        )}
      </div>

      <Modal
        open={showProject}
        title="New Project"
        dirty={projectDirty}
        closeDisabled={creatingProject}
        onClose={closeProjectModal}
        footer={
          <>
            <button
              type="button"
              className="dgv-btn dgv-btn--outline"
              disabled={creatingProject}
              onClick={() => {
                if (creatingProject) return;
                if (!confirmDiscardIfDirty(projectDirty)) return;
                closeProjectModal();
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dgv-btn dgv-btn--primary"
              onClick={saveProject}
              disabled={creatingProject}
            >
              {creatingProject ? "Creating..." : "Create"}
            </button>
          </>
        }
      >
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
      </Modal>

      <Modal
        open={showTask}
        title="New Task"
        maxWidth={720}
        dirty={taskDirty}
        closeDisabled={savingTask}
        onClose={closeTaskModal}
        footer={
          <>
            <button
              type="button"
              className="dgv-btn dgv-btn--outline"
              disabled={savingTask}
              onClick={() => {
                if (savingTask) return;
                if (!confirmDiscardIfDirty(taskDirty)) return;
                closeTaskModal();
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dgv-btn dgv-btn--primary"
              onClick={saveTask}
              disabled={savingTask}
            >
              {savingTask ? "Creating..." : "Create Task"}
            </button>
          </>
        }
      >
          {formErrors.form ? (
            <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 12 }}>
              {formErrors.form}
            </div>
          ) : null}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              columnGap: 16,
            }}
          >
            <Field
              label="Title *"
              value={taskForm.title}
              error={formErrors.title}
              maxLength={TITLE_MAX}
              onChange={(v) => setTaskForm({ ...taskForm, title: v })}
            />
            <div>
              <label style={formLabel}>Project *</label>
              <select
                style={{
                  ...formSelect,
                  border: formErrors.projectId
                    ? "1px solid var(--dgv-danger)"
                    : formSelect.border,
                }}
                value={taskForm.projectId}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === CREATE_PROJECT_VALUE) {
                    openProjectFromTask();
                    return;
                  }
                  setTaskForm({ ...taskForm, projectId: value });
                }}
              >
                <option value="">Select project</option>
                {projects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.name}
                  </option>
                ))}
                <option value={CREATE_PROJECT_VALUE}>+ Create New Project</option>
              </select>
              {formErrors.projectId ? (
                <div
                  style={{
                    color: "var(--dgv-danger)",
                    fontSize: 12,
                    marginTop: -10,
                    marginBottom: 12,
                  }}
                >
                  {formErrors.projectId}
                </div>
              ) : null}
            </div>
            <Field
              label="Author *"
              value={taskForm.authorName}
              error={formErrors.authorName}
              maxLength={AUTHOR_MAX}
              onChange={(v) => setTaskForm({ ...taskForm, authorName: v })}
            />
            <div>
              <label style={formLabel}>Category</label>
              <select
                style={formSelect}
                value={taskForm.category}
                onChange={(e) =>
                  setTaskForm({ ...taskForm, category: e.target.value })
                }
              >
                <option value="">Select category</option>
                {TASK_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={formLabel}>Assignees *</label>
              <input
                style={{
                  ...formInput,
                  marginBottom: 8,
                }}
                placeholder="Search employees by name or email"
                value={assigneeQuery}
                onChange={(e) => {
                  setAssigneeQuery(e.target.value);
                  if (e.target.value.trim()) setShowAllAssignees(false);
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setShowAllAssignees((open) => !open);
                  if (showAllAssignees) setAssigneeQuery("");
                }}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  marginBottom: 10,
                  cursor: "pointer",
                  color: "var(--dgv-accent)",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {showAllAssignees ? "Hide employee list" : "Show all employees"}
              </button>
              {taskForm.assignees.length ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                  {taskForm.assignees.map((email) => {
                    const person = personLabel(users, email);
                    return (
                      <span
                        key={email}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "4px 8px",
                          borderRadius: 999,
                          background: "var(--dgv-accent-soft)",
                          border: `1px solid ${colors.border}`,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {person.name}
                        <button
                          type="button"
                          onClick={() => toggleAssignee(email)}
                          aria-label={`Remove ${person.name}`}
                          style={{
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            color: colors.text,
                            fontWeight: 700,
                            padding: 0,
                            lineHeight: 1,
                          }}
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              ) : null}
              {showAssigneeList ? (
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
                  ) : assigneeMatches.length === 0 ? (
                    <div style={{ fontSize: 13, color: colors.textMuted }}>
                      No employees found
                    </div>
                  ) : (
                    assigneeMatches.map((u) => (
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
              ) : null}
              {formErrors.assignees ? (
                <div style={{ color: "var(--dgv-danger)", fontSize: 12, marginBottom: 12 }}>
                  {formErrors.assignees}
                </div>
              ) : null}
            </div>
            <div>
              <label style={formLabel}>Priority *</label>
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
            </div>
            <TaskDatePicker
              id="task-start-date"
              label="Start Date *"
              value={taskForm.startDate}
              error={formErrors.startDate}
              onChange={(v) => setTaskForm({ ...taskForm, startDate: v })}
            />
            <TaskTimePicker
              id="task-start-time"
              label="Start Time *"
              value={taskForm.startTime}
              error={formErrors.startTime}
              onChange={(v) => setTaskForm({ ...taskForm, startTime: v })}
            />
            <TaskDatePicker
              id="task-deadline-date"
              label="Deadline Date *"
              value={taskForm.dueDate}
              error={formErrors.dueDate}
              onChange={(v) => setTaskForm({ ...taskForm, dueDate: v })}
            />
            <TaskTimePicker
              id="task-deadline-time"
              label="Deadline Time *"
              value={taskForm.dueTime}
              fallbackValue={taskForm.startTime}
              error={formErrors.dueTime}
              onChange={(v) => setTaskForm({ ...taskForm, dueTime: v })}
            />
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={formLabel}>Description</label>
              <textarea
                style={{ ...formInput, minHeight: 90, resize: "vertical" }}
                value={taskForm.description}
                maxLength={DESCRIPTION_MAX}
                onChange={(e) =>
                  setTaskForm({ ...taskForm, description: e.target.value })
                }
              />
              {formErrors.description ? (
                <div style={{ color: "var(--dgv-danger)", fontSize: 12, marginTop: -10, marginBottom: 12 }}>
                  {formErrors.description}
                </div>
              ) : null}
            </div>
          </div>
      </Modal>
    </Layout>
  );
}

function Field({ label, value, onChange, type = "text", error, maxLength, step }) {
  return (
    <div>
      <label style={formLabel}>{label}</label>
      <input
        style={{
          ...formInput,
          border: error
            ? "1px solid var(--dgv-danger)"
            : formInput.border,
        }}
        type={type}
        value={value}
        maxLength={maxLength}
        step={step}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <div style={{ color: "var(--dgv-danger)", fontSize: 12, marginTop: -10, marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

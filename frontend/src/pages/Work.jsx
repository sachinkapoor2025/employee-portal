import { useCallback, useEffect, useState } from "react";
import Layout from "../components/Layout";
import { fetchTaskList, updateTask } from "../services/api";
import { canAccessAdmin } from "../services/auth";
import {
  formatTaskDateTime,
  formatTaskDuration,
  getTaskTiming,
  getTaskZone,
  employeeCanChangeStatus,
  priorityLabel,
  applyClientZoneFilter,
  countZones,
  emptyZoneMessage,
  taskMatchesSearch,
} from "../utils/taskStatus";
import { displayNameFromEmail } from "../utils/meetings";
import ZoneBadge from "../components/ZoneBadge";
import ZoneFilter from "../components/ZoneFilter";
import {
  colors,
  pageTitle,
  formLabel,
  formInput,
  buttonPrimary,
} from "../theme";

const STATUSES = ["TODO", "IN_PROGRESS", "REVIEW", "DONE"];
const ZONE_KEY = "dgv.mytasks.zone";
const SEARCH_KEY = "dgv.mytasks.search";

function readStored(key, fallback) {
  try {
    return sessionStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export default function Work() {
  const [tasks, setTasks] = useState([]);
  const [zoneCounts, setZoneCounts] = useState({
    ALL: 0,
    GREEN: 0,
    ORANGE: 0,
    RED: 0,
    COMPLETED: 0,
  });
  const [loading, setLoading] = useState(true);
  const [zone, setZone] = useState(() => readStored(ZONE_KEY, "ALL"));
  const [search, setSearch] = useState(() => readStored(SEARCH_KEY, ""));
  const [searchInput, setSearchInput] = useState(() =>
    readStored(SEARCH_KEY, "")
  );

  const load = useCallback(() => {
    setLoading(true);
    return fetchTaskList({
      mine: "true",
      ...(search.trim() ? { q: search.trim() } : {}),
      ...(zone && zone !== "ALL" ? { zone } : {}),
    })
      .then((list) => {
        const raw = Array.isArray(list.tasks) ? list.tasks : [];
        const scoped = raw.filter((t) => taskMatchesSearch(t, search));
        const myEmail =
          scoped.find((t) => t.myAssignment)?.myAssignment?.email || "";
        setZoneCounts(list.zoneCounts || countZones(scoped, myEmail));
        const filtered = applyClientZoneFilter(scoped, zone, myEmail);
        filtered.sort((left, right) => {
          const leftMs = Date.parse(left.createdAt || 0);
          const rightMs = Date.parse(right.createdAt || 0);
          return (Number.isFinite(rightMs) ? rightMs : 0) -
            (Number.isFinite(leftMs) ? leftMs : 0);
        });
        setTasks(filtered);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [search, zone]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    try {
      if (!zone || zone === "ALL") sessionStorage.removeItem(ZONE_KEY);
      else sessionStorage.setItem(ZONE_KEY, zone);
      if (!search) sessionStorage.removeItem(SEARCH_KEY);
      else sessionStorage.setItem(SEARCH_KEY, search);
    } catch {
      /* ignore */
    }
  }, [zone, search]);

  const changeStatus = async (task, status) => {
    const mine = task.myAssignment;
    if (
      !canAccessAdmin() &&
      !employeeCanChangeStatus(mine || task, task.dueDate)
    ) {
      alert("Red Zone tasks can only be updated by an administrator.");
      return;
    }
    if (status === "DONE") {
      const ok = window.confirm(
        "Mark this task as completed? Once completed it will stay completed and will not move to Orange or Red."
      );
      if (!ok) return;
    }
    if (mine && String(mine.status).toUpperCase() === "DONE" && status !== "DONE") {
      alert("Completed assignments cannot be reopened.");
      return;
    }
    try {
      await updateTask({
        taskId: task.taskId,
        projectId: task.projectId,
        status,
        assignmentEmail: mine?.email,
      });
      load();
    } catch (err) {
      alert(err.message || "Failed to update task status.");
    }
  };

  const clearFilters = () => {
    setZone("ALL");
    setSearch("");
    setSearchInput("");
  };

  if (loading && tasks.length === 0) {
    return (
      <Layout>
        <p>Loading tasks...</p>
      </Layout>
    );
  }

  return (
    <Layout>
      <h1 style={pageTitle}>My Tasks</h1>

      <div className="dgv-card" style={{ padding: 20, marginBottom: 20 }}>
        <label style={formLabel}>Search tasks</label>
        <input
          style={formInput}
          placeholder="Search tasks..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />

        <label style={formLabel}>Zone</label>
        <ZoneFilter
          value={zone}
          onChange={setZone}
          counts={{
            ALL: zoneCounts.ALL,
            GREEN: zoneCounts.GREEN,
            ORANGE: zoneCounts.ORANGE,
            RED: zoneCounts.RED,
            COMPLETED: zoneCounts.COMPLETED,
          }}
        />
        {zone !== "ALL" || searchInput.trim() ? (
          <button
            type="button"
            onClick={clearFilters}
            style={{
              ...buttonPrimary,
              background: "transparent",
              color: colors.text,
              border: `1px solid ${colors.border}`,
              boxShadow: "none",
              marginBottom: 0,
            }}
          >
            Clear Filters
          </button>
        ) : null}
      </div>

      {tasks.length === 0 ? (
        <p style={{ color: colors.textMuted }}>
          {search || zone !== "ALL"
            ? emptyZoneMessage(zone)
            : "No tasks assigned yet. Your admin will assign tasks from Manage Tasks."}
        </p>
      ) : (
        tasks.map((task) => {
          const mine = task.myAssignment || task.matchedAssignments?.[0];
          const status = mine?.status || task.status || "TODO";
          const taskZone = mine?.zone || getTaskZone(task);
          const timing = mine?.timing || getTaskTiming(task);
          const allowStatusChange =
            canAccessAdmin() || employeeCanChangeStatus(mine || task, task.dueDate);
          const zoneClass =
            String(status).toUpperCase() === "DONE"
              ? ""
              : taskZone === "RED"
                ? " is-red"
                : taskZone === "ORANGE"
                  ? " is-orange"
                  : "";
          return (
            <div
              key={task.taskId}
              className={`dgv-task-card${zoneClass}`}
            >
              <h3 className="dgv-task-card__title">{task.title}</h3>
              {task.description ? (
                <p style={{ color: colors.textMuted, fontSize: 14, margin: "8px 0 0" }}>
                  {task.description}
                </p>
              ) : null}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 12,
                  alignItems: "center",
                }}
              >
                <ZoneBadge zone={taskZone} status={status} />
              </div>
              <div className="dgv-task-card__meta">
                {task.category ? (
                  <span>
                    <strong>Category</strong> {task.category}
                  </span>
                ) : null}
                {task.createdByName || task.createdBy ? (
                  <span>
                    <strong>Author</strong>{" "}
                    {task.createdByName || displayNameFromEmail(task.createdBy)}
                  </span>
                ) : null}
                <span>
                  <strong>Priority</strong> {priorityLabel(task.priority)}
                </span>
                <span>
                  <strong>Deadline</strong>{" "}
                  {task.dueDate ? formatTaskDateTime(task.dueDate) : "—"}
                </span>
                {formatTaskDuration(task) ? (
                  <span>
                    <strong>Duration</strong> {formatTaskDuration(task)}
                  </span>
                ) : null}
                {timing ? (
                  <span>
                    <strong>Timing</strong> {timing}
                  </span>
                ) : null}
                {mine?.completedAt ? (
                  <span>
                    <strong>Completed</strong> {formatTaskDateTime(mine.completedAt)}
                  </span>
                ) : null}
              </div>
              <div className="dgv-task-card__actions">
                <select
                  className="dgv-select"
                  value={status}
                  onChange={(e) => changeStatus(task, e.target.value)}
                  style={{ maxWidth: 240, marginBottom: 0 }}
                  disabled={
                    String(status).toUpperCase() === "DONE" || !allowStatusChange
                  }
                  aria-label="Update task status"
                >
                  {STATUSES.map((s) => (
                    <option
                      key={s}
                      value={s}
                      disabled={!allowStatusChange}
                    >
                      {s.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })
      )}
    </Layout>
  );
}

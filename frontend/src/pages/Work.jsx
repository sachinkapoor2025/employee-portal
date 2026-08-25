import { useCallback, useEffect, useState } from "react";
import Layout from "../components/Layout";
import { fetchTaskList, updateTask, logTimeEntry } from "../services/api";
import {
  formatTaskDateTime,
  formatTaskDuration,
  getTaskTiming,
  getTaskZone,
  priorityLabel,
  applyClientZoneFilter,
  countZones,
  emptyZoneMessage,
  taskMatchesSearch,
} from "../utils/taskStatus";
import ZoneBadge from "../components/ZoneBadge";
import ZoneFilter from "../components/ZoneFilter";
import {
  colors,
  pageCard,
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
  const [timeForm, setTimeForm] = useState({ taskId: "", minutes: "", note: "" });

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
        setTasks(applyClientZoneFilter(scoped, zone, myEmail));
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
    if (status === "DONE") {
      const ok = window.confirm(
        "Mark this task as completed? Once completed it will stay completed and will not move to Orange or Red."
      );
      if (!ok) return;
    }
    const mine = task.myAssignment;
    if (mine && String(mine.status).toUpperCase() === "DONE" && status !== "DONE") {
      alert("Completed assignments cannot be reopened.");
      return;
    }
    await updateTask({
      taskId: task.taskId,
      projectId: task.projectId,
      status,
    });
    load();
  };

  const logTime = async () => {
    if (!timeForm.taskId || !timeForm.minutes) return;
    const task = tasks.find((t) => t.taskId === timeForm.taskId);
    await logTimeEntry({
      taskId: timeForm.taskId,
      projectId: task?.projectId,
      minutes: Number(timeForm.minutes),
      note: timeForm.note,
    });
    setTimeForm({ taskId: "", minutes: "", note: "" });
    alert("Time logged!");
  };

  const clearFilters = () => {
    setZone("ALL");
    setSearch("");
    setSearchInput("");
  };

  if (loading && tasks.length === 0) {
    return (
      <Layout>
        <div style={pageCard}><p>Loading tasks...</p></div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>My Tasks</h2>

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
              marginBottom: 12,
            }}
          >
            Clear Filters
          </button>
        ) : null}

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
            return (
              <div
                key={task.taskId}
                style={{
                  border: `1px solid ${
                    taskZone === "RED"
                      ? "rgba(239,68,68,0.45)"
                      : taskZone === "ORANGE"
                      ? "rgba(249,115,22,0.4)"
                      : colors.border
                  }`,
                  borderRadius: 10,
                  padding: 16,
                  marginBottom: 12,
                }}
              >
                <div style={{ fontWeight: 700 }}>{task.title}</div>
                <p style={{ color: colors.textMuted, fontSize: 14 }}>{task.description}</p>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    marginBottom: 8,
                    alignItems: "center",
                  }}
                >
                  <ZoneBadge zone={taskZone} status={status} />
                </div>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  Priority: {priorityLabel(task.priority)} | Deadline:{" "}
                  {task.dueDate ? formatTaskDateTime(task.dueDate) : "—"}
                  {formatTaskDuration(task)
                    ? ` | Duration: ${formatTaskDuration(task)}`
                    : ""}
                </div>
                {timing ? (
                  <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 8 }}>
                    {timing}
                  </div>
                ) : null}
                {mine?.completedAt ? (
                  <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 8 }}>
                    Completed: {formatTaskDateTime(mine.completedAt)}
                  </div>
                ) : null}
                <select
                  value={status}
                  onChange={(e) => changeStatus(task, e.target.value)}
                  style={{ padding: 6, borderRadius: 6 }}
                  disabled={String(status).toUpperCase() === "DONE"}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{s.replace("_", " ")}</option>
                  ))}
                </select>
              </div>
            );
          })
        )}

        <h3 style={{ marginTop: 24 }}>Log Time on Task</h3>
        <label style={formLabel}>Task</label>
        <select
          style={formInput}
          value={timeForm.taskId}
          onChange={(e) => setTimeForm({ ...timeForm, taskId: e.target.value })}
        >
          <option value="">Select task</option>
          {tasks.map((t) => (
            <option key={t.taskId} value={t.taskId}>{t.title}</option>
          ))}
        </select>
        <label style={formLabel}>Minutes</label>
        <input
          type="number"
          style={formInput}
          value={timeForm.minutes}
          onChange={(e) => setTimeForm({ ...timeForm, minutes: e.target.value })}
        />
        <label style={formLabel}>Note</label>
        <input
          style={formInput}
          value={timeForm.note}
          onChange={(e) => setTimeForm({ ...timeForm, note: e.target.value })}
        />
        <button style={buttonPrimary} onClick={logTime}>Log Time</button>
      </div>
    </Layout>
  );
}

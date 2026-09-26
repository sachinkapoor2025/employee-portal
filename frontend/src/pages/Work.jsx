import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { fetchTaskList } from "../services/api";
import {
  formatTaskDateTime,
  formatTaskDuration,
  getTaskTiming,
  getTaskZone,
  applyClientZoneFilter,
  countZones,
  emptyZoneMessage,
  taskMatchesSearch,
  priorityLabel,
  statusLabel,
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

const ZONE_KEY = "dgv.mytasks.zone";
const SEARCH_KEY = "dgv.mytasks.search";
const MY_TASK_ZONES = ["GREEN", "ORANGE", "RED", "COMPLETED"];

function readStored(key, fallback = "") {
  try {
    return sessionStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function normalizeZone(value) {
  const key = String(value || "").trim().toUpperCase();
  return MY_TASK_ZONES.includes(key) ? key : "GREEN";
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
  const [zone, setZone] = useState(() => normalizeZone(readStored(ZONE_KEY)));
  const [search, setSearch] = useState(() => readStored(SEARCH_KEY, ""));
  const [searchInput, setSearchInput] = useState(() =>
    readStored(SEARCH_KEY, "")
  );

  const load = useCallback(() => {
    setLoading(true);
    const selectedZone = normalizeZone(zone);
    return fetchTaskList({
      mine: "true",
      ...(search.trim() ? { q: search.trim() } : {}),
      zone: selectedZone,
    })
      .then((list) => {
        const raw = Array.isArray(list.tasks) ? list.tasks : [];
        const scoped = raw.filter((t) => taskMatchesSearch(t, search));
        const myEmail =
          scoped.find((t) => t.myAssignment)?.myAssignment?.email || "";
        setZoneCounts(list.zoneCounts || countZones(scoped, myEmail));
        const filtered = applyClientZoneFilter(scoped, selectedZone, myEmail);
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
      sessionStorage.setItem(ZONE_KEY, normalizeZone(zone));
      if (!search) sessionStorage.removeItem(SEARCH_KEY);
      else sessionStorage.setItem(SEARCH_KEY, search);
    } catch {
      /* ignore */
    }
  }, [zone, search]);

  const clearFilters = () => {
    setZone("GREEN");
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
          value={normalizeZone(zone)}
          onChange={(next) => setZone(normalizeZone(next))}
          includeAll={false}
          counts={{
            GREEN: zoneCounts.GREEN,
            ORANGE: zoneCounts.ORANGE,
            RED: zoneCounts.RED,
            COMPLETED: zoneCounts.COMPLETED,
          }}
        />
        {normalizeZone(zone) !== "GREEN" || searchInput.trim() ? (
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
        <p style={{ color: colors.textMuted }}>{emptyZoneMessage(zone)}</p>
      ) : (
        tasks.map((task) => {
          const mine = task.myAssignment || task.matchedAssignments?.[0];
          const status = mine?.status || task.status || "TODO";
          const taskZone = mine?.zone || getTaskZone(task);
          const timing = mine?.timing || getTaskTiming(task);
          const zoneClass =
            String(status).toUpperCase() === "DONE"
              ? ""
              : taskZone === "RED"
                ? " is-red"
                : taskZone === "ORANGE"
                  ? " is-orange"
                  : "";
          return (
            <Link
              key={task.taskId}
              to={`/work/${task.taskId}`}
              className={`dgv-task-card${zoneClass}`}
              aria-label={`View task ${task.title || task.taskId}`}
              style={{
                display: "block",
                textDecoration: "none",
                color: "inherit",
                cursor: "pointer",
              }}
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
                  <strong>Status</strong> {statusLabel(status)}
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
            </Link>
          );
        })
      )}
    </Layout>
  );
}

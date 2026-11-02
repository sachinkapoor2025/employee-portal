import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  ClipboardList,
  Clock3,
  ListTodo,
  Play,
} from "lucide-react";
import Layout from "../components/Layout";
import { fetchTaskList, updateTask } from "../services/api";
import { displayTaskId } from "../utils/taskStatus";
import { parseRequiredHours } from "../utils/taskTime";
import {
  assignmentInPeriod,
  assignmentPeriodRange,
  createRequestGate,
  employeeStatus,
  employeeStatusCounts,
  employeeZone,
  emptyEmployeeMessage,
  formatAssignmentPeriod,
  formatEmployeeDueDate,
  sortEmployeeTasks,
  taskMatchesMyTasksView,
} from "../utils/employeeTaskVisibility";

const ZONE_KEY = "dgv.mytasks.zone";
const STATUS_KEY = "dgv.mytasks.status";
const SEARCH_KEY = "dgv.mytasks.search";
const PAGE_SIZE = 8;
const ZONES = new Set(["ALL", "GREEN", "ORANGE", "RED", "NONE"]);
const STATUSES = new Set(["ALL", "TODO", "IN_PROGRESS", "REVIEW", "DONE"]);
const STALE_ASSIGNMENT_MESSAGE =
  "This assignment was not saved because it changed. Refresh the task and try again.";
const RED_ZONE_MESSAGE =
  "Red Zone tasks can only be updated by an administrator.";

const STATUS_LABEL = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  REVIEW: "In review",
  DONE: "Completed",
  CANCELLED: "Cancelled",
};

const ZONE_LABEL = {
  GREEN: "On time",
  ORANGE: "Due soon",
  RED: "Overdue",
  NONE: "No deadline",
  UNZONED: "Deadline",
};

function readStored(key, fallback = "") {
  try {
    return sessionStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function normalizeZone(value) {
  const key = String(value || "").trim().toUpperCase();
  return ZONES.has(key) ? key : "ALL";
}

function normalizeStatus(value) {
  const key = String(value || "").trim().toUpperCase();
  return STATUSES.has(key) ? key : "ALL";
}

function readInitialFilters() {
  const storedZone = String(readStored(ZONE_KEY) || "").trim().toUpperCase();
  if (storedZone === "COMPLETED") {
    return { zone: "ALL", status: "DONE", tab: "DONE" };
  }
  const status = normalizeStatus(readStored(STATUS_KEY));
  return {
    zone: normalizeZone(storedZone),
    status,
    tab: status === "DONE" ? "DONE" : "ALL",
  };
}

function projectLabel(task) {
  return String(task?.projectName || "").trim();
}

export default function Work() {
  const navigate = useNavigate();
  const initial = readInitialFilters();
  const [tasks, setTasks] = useState([]);
  const [resultQuery, setResultQuery] = useState(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [zone, setZone] = useState(initial.zone);
  const [status, setStatus] = useState(initial.status);
  const [tab, setTab] = useState(initial.tab);
  const [project, setProject] = useState("");
  const [sortMode, setSortMode] = useState("earliest");
  const [period, setPeriod] = useState("ALL");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState("");
  const [search, setSearch] = useState(() => readStored(SEARCH_KEY, ""));
  const [searchInput, setSearchInput] = useState(() =>
    readStored(SEARCH_KEY, "")
  );
  const requests = useRef(createRequestGate());
  const actionLock = useRef(false);

  const load = useCallback((query) => {
    const requestId = requests.current.next();
    const q = String(query || "").trim();
    setError("");
    return fetchTaskList({
      mine: "true",
      ...(q ? { q } : {}),
    })
      .then((list) => {
        if (!requests.current.isLatest(requestId)) return;
        setTasks(Array.isArray(list?.tasks) ? list.tasks : []);
        setResultQuery(q);
      })
      .catch(() => {
        if (!requests.current.isLatest(requestId)) return;
        setError("Unable to load tasks. Please try again.");
      });
  }, []);

  useEffect(() => {
    load(search);
  }, [load, search]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    try {
      sessionStorage.setItem(ZONE_KEY, normalizeZone(zone));
      sessionStorage.setItem(STATUS_KEY, normalizeStatus(status));
      if (!search) sessionStorage.removeItem(SEARCH_KEY);
      else sessionStorage.setItem(SEARCH_KEY, search);
    } catch {
      /* ignore */
    }
  }, [zone, status, search]);

  useEffect(() => {
    setPage(1);
  }, [zone, status, tab, project, sortMode, search, period, periodStart, periodEnd]);

  const ready = resultQuery === search.trim();
  const periodRange = assignmentPeriodRange(period, {
    now: Date.now(),
    start: periodStart,
    end: periodEnd,
  });
  const dated = ready
    ? tasks.filter((task) => assignmentInPeriod(task, periodRange))
    : [];
  const counts = employeeStatusCounts(dated);
  const openCount = counts.TODO + counts.IN_PROGRESS + counts.REVIEW;
  const projects = useMemo(() => {
    const names = new Set();
    for (const task of dated) {
      const name = projectLabel(task);
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [dated]);

  const visible = ready
    ? sortEmployeeTasks(
        dated.filter((task) =>
          taskMatchesMyTasksView(task, { tab, status, zone, project })
        ),
        sortMode
      )
    : [];
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const filtersActive =
    normalizeZone(zone) !== "ALL" ||
    normalizeStatus(status) !== "ALL" ||
    Boolean(project) ||
    Boolean(searchInput.trim());

  const clearFilters = () => {
    setZone("ALL");
    setStatus("ALL");
    setProject("");
    setSearch("");
    setSearchInput("");
    setTab("ALL");
  };

  const startWork = async (task) => {
    if (actionLock.current || busyId) return;
    const planned = parseRequiredHours(task.myAssignment?.plannedHours);
    if (!planned.ok) {
      navigate(`/work/${encodeURIComponent(task.taskId)}`);
      return;
    }
    actionLock.current = true;
    setBusyId(task.taskId);
    setActionError("");
    try {
      await updateTask({
        taskId: task.taskId,
        projectId: task.projectId,
        status: "IN_PROGRESS",
        assignmentEmail: task.myAssignment?.email,
        plannedHours: planned.value,
      });
      await load(search);
    } catch (err) {
      setActionError(
        Number(err?.status) === 409
          ? STALE_ASSIGNMENT_MESSAGE
          : err?.message || "Unable to start this task."
      );
    } finally {
      actionLock.current = false;
      setBusyId("");
    }
  };

  return (
    <Layout>
      <div className="dgv-my-tasks">
        <div className="dgv-my-tasks__heading">
          <div>
            <p className="dgv-my-tasks__crumb">
              <Link to="/">Portal</Link>
              <span aria-hidden="true">/</span>
              My Tasks
            </p>
            <h1 className="dgv-my-tasks__title">My Tasks</h1>
            <p className="dgv-my-tasks__subtitle">
              Your assigned work, deadlines, and progress in one place.
            </p>
          </div>
          <AssignedPeriod
            period={period}
            start={periodStart}
            end={periodEnd}
            range={periodRange}
            onPeriod={setPeriod}
            onStart={setPeriodStart}
            onEnd={setPeriodEnd}
            onReset={() => {
              setPeriod("ALL");
              setPeriodStart("");
              setPeriodEnd("");
            }}
          />
        </div>

        <div className="dgv-my-tasks__stats">
          <SummaryCard label="Total Tasks" value={counts.ALL} tone="neutral" icon={<ListTodo size={18} />} />
          <SummaryCard label="To Do" value={counts.TODO} tone="info" icon={<ClipboardList size={18} />} />
          <SummaryCard label="In Progress" value={counts.IN_PROGRESS} tone="accent" icon={<Play size={18} />} />
          <SummaryCard label="In Review" value={counts.REVIEW} tone="warning" icon={<Clock3 size={18} />} />
          <SummaryCard label="Completed" value={counts.DONE} tone="success" icon={<CheckCircle2 size={18} />} />
        </div>

        <div className="dgv-my-tasks__tabs" role="tablist" aria-label="Task lists">
          <button type="button" role="tab" aria-selected={tab === "ALL"} onClick={() => setTab("ALL")}>
            All Tasks <span>({counts.ALL})</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "OPEN"} onClick={() => setTab("OPEN")}>
            My Open Tasks <span>({openCount})</span>
            <small>To do, in progress, and in review</small>
          </button>
          <button type="button" role="tab" aria-selected={tab === "DONE"} onClick={() => setTab("DONE")}>
            Completed <span>({counts.DONE})</span>
          </button>
        </div>

        <div className="dgv-my-tasks__filters">
          <input
            id="my-tasks-search"
            aria-label="Search tasks"
            placeholder="Search tasks, project, or ID..."
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <select
            aria-label="Status"
            value={normalizeStatus(status)}
            onChange={(event) => setStatus(normalizeStatus(event.target.value))}
          >
            <option value="ALL">Status: All</option>
            <option value="TODO">Status: To do</option>
            <option value="IN_PROGRESS">Status: In progress</option>
            <option value="REVIEW">Status: In review</option>
            <option value="DONE">Status: Completed</option>
          </select>
          <select
            aria-label="Deadline"
            value={normalizeZone(zone)}
            onChange={(event) => setZone(normalizeZone(event.target.value))}
          >
            <option value="ALL">Deadline: All deadlines</option>
            <option value="GREEN">Deadline: On time</option>
            <option value="ORANGE">Deadline: Due soon</option>
            <option value="RED">Deadline: Overdue</option>
            <option value="NONE">Deadline: No deadline</option>
          </select>
          <select
            aria-label="Project"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">Project: All projects</option>
            {projects.map((name) => (
              <option key={name} value={name}>
                Project: {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort"
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value)}
          >
            <option value="earliest">Sort: Deadline (earliest)</option>
            <option value="latest">Sort: Deadline (latest)</option>
          </select>
        </div>

        <div className="dgv-my-tasks__filter-bar">
          <div className="dgv-my-tasks__chips">
            {normalizeStatus(status) !== "ALL" ? (
              <button type="button" onClick={() => setStatus("ALL")}>
                Status: {STATUS_LABEL[status]} <span aria-hidden="true">×</span>
              </button>
            ) : null}
            {normalizeZone(zone) !== "ALL" ? (
              <button type="button" onClick={() => setZone("ALL")}>
                Deadline: {ZONE_LABEL[zone]} <span aria-hidden="true">×</span>
              </button>
            ) : null}
            {project ? (
              <button type="button" onClick={() => setProject("")}>
                Project: {project} <span aria-hidden="true">×</span>
              </button>
            ) : null}
            {filtersActive ? (
              <button type="button" className="dgv-my-tasks__clear" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
          </div>
          <p className="dgv-my-tasks__legend">
            <span>Deadline zones:</span>
            <i className="is-green" /> On time (Green)
            <i className="is-orange" /> Due soon (Orange)
            <i className="is-red" /> Overdue (Red)
          </p>
        </div>

        {error ? (
          <p className="dgv-my-tasks__alert" role="alert">
            {error}{" "}
            <button type="button" onClick={() => load(search)}>
              Retry
            </button>
          </p>
        ) : null}
        {actionError ? (
          <p className="dgv-my-tasks__alert" role="alert">
            {actionError}{" "}
            {actionError === STALE_ASSIGNMENT_MESSAGE ? (
              <button type="button" onClick={() => load(search)}>
                Refresh task
              </button>
            ) : null}
          </p>
        ) : null}
        {!ready && !error ? <p role="status">Loading tasks...</p> : null}

        {ready && !error && visible.length === 0 ? (
          <p className="dgv-my-tasks__empty">
            {dated.length === 0 && period !== "ALL"
              ? periodRange?.invalid
                ? "Choose an end date on or after the start date."
                : "No tasks assigned in this period."
              : emptyEmployeeMessage(
                  zone,
                  status === "ALL" && tab === "DONE" ? "DONE" : status
                )}
          </p>
        ) : null}

        {pageRows.length > 0 ? (
          <div className="dgv-my-tasks__table-wrap">
            <table className="dgv-my-tasks__table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Project</th>
                  <th>Due Date</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((task) => (
                  <TaskRow
                    key={task.taskId}
                    task={task}
                    busy={busyId === task.taskId}
                    onStart={() => startWork(task)}
                    onSubmit={() => navigate(`/work/${encodeURIComponent(task.taskId)}`)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {visible.length > 0 ? (
          <div className="dgv-my-tasks__pager">
            <span>
              Showing {(safePage - 1) * PAGE_SIZE + 1}–
              {Math.min(safePage * PAGE_SIZE, visible.length)} of {visible.length}
              {filtersActive || tab !== "ALL" ? " (filtered)" : ""}
            </span>
            <div>
              <button type="button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                Prev
              </button>
              <span>{safePage}</span>
              <button
                type="button"
                disabled={safePage >= pageCount}
                onClick={() => setPage(safePage + 1)}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Layout>
  );
}

function AssignedPeriod({
  period,
  start,
  end,
  range,
  onPeriod,
  onStart,
  onEnd,
  onReset,
}) {
  const concrete = formatAssignmentPeriod(range);
  const caption =
    period === "ALL"
      ? "All time"
      : range?.invalid
        ? "End date is before the start date"
        : range?.pending
          ? "Select a start and end date"
          : concrete;
  return (
    <div className="dgv-my-tasks__range">
      <label htmlFor="my-tasks-period">Assigned</label>
      <select
        id="my-tasks-period"
        aria-label="Assigned period"
        value={period}
        onChange={(event) => onPeriod(event.target.value)}
      >
        <option value="ALL">All time</option>
        <option value="LAST_7">Last 7 days</option>
        <option value="THIS_MONTH">This month</option>
        <option value="LAST_MONTH">Last month</option>
        <option value="CUSTOM">Custom range</option>
      </select>
      {period === "CUSTOM" ? (
        <>
          <input
            aria-label="Assigned from"
            type="date"
            value={start}
            onChange={(event) => onStart(event.target.value)}
          />
          <input
            aria-label="Assigned to"
            type="date"
            value={end}
            onChange={(event) => onEnd(event.target.value)}
          />
        </>
      ) : null}
      <p className="dgv-my-tasks__range-label">{caption}</p>
      {period !== "ALL" ? (
        <button type="button" onClick={onReset}>
          All time
        </button>
      ) : null}
    </div>
  );
}

function SummaryCard({ label, value, tone, icon }) {
  return (
    <article className={`dgv-my-tasks__stat is-${tone}`}>
      <span className="dgv-my-tasks__stat-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </article>
  );
}

function TaskRow({ task, busy, onStart, onSubmit }) {
  const status = employeeStatus(task);
  const zone = employeeZone(task);
  const closed = status === "DONE" || status === "CANCELLED";
  const rail = closed ? "none" : zone === "RED" || zone === "ORANGE" || zone === "GREEN" ? zone.toLowerCase() : "none";
  const project = projectLabel(task);
  const timing = task.myAssignment?.timing || "";
  return (
    <tr className={`is-rail-${rail}`}>
      <td data-label="Task">
        <Link
          to={`/work/${encodeURIComponent(task.taskId)}`}
          aria-label={`View task ${task.title || "Untitled task"}`}
        >
          {task.title || "Untitled task"}
        </Link>
        <small>{displayTaskId(task.taskId)}</small>
      </td>
      <td data-label="Project">{project || "—"}</td>
      <td data-label="Due Date">
        <span className={`dgv-my-tasks__due is-${closed ? "done" : zone.toLowerCase()}`}>
          {formatEmployeeDueDate(task.dueDate)}
          {!closed && zone !== "NONE" && zone !== "UNZONED" ? (
            <em>{timing || ZONE_LABEL[zone]}</em>
          ) : null}
        </span>
      </td>
      <td data-label="Status">
        <span className={`dgv-my-tasks__status is-${status.toLowerCase()}`}>
          {STATUS_LABEL[status] || status}
        </span>
        {status === "REVIEW" ? <small>Awaiting admin review</small> : null}
      </td>
      <td data-label="Action">
        <RowAction status={status} zone={zone} busy={busy} onStart={onStart} onSubmit={onSubmit} />
      </td>
    </tr>
  );
}

function RowAction({ status, zone, busy, onStart, onSubmit }) {
  if (status === "DONE" || status === "CANCELLED") return <span className="dgv-my-tasks__quiet">—</span>;
  if (status === "REVIEW") return <span className="dgv-my-tasks__quiet">Awaiting admin review</span>;
  if (zone === "RED") {
    return <span className="dgv-my-tasks__quiet">{RED_ZONE_MESSAGE}</span>;
  }
  if (status === "TODO") {
    return (
      <button type="button" className="dgv-btn dgv-btn--primary" onClick={onStart} disabled={busy}>
        {busy ? "Starting..." : "Start work"}
      </button>
    );
  }
  if (status === "IN_PROGRESS") {
    return (
      <button type="button" className="dgv-btn dgv-btn--primary" onClick={onSubmit} disabled={busy}>
        Submit for review
      </button>
    );
  }
  return null;
}

/** Shared task status helpers for Admin Tasks UI. */

export const TASK_STATUSES = [
  { value: "TODO", label: "TODO", hint: "Created but work has not started" },
  {
    value: "IN_PROGRESS",
    label: "IN PROGRESS",
    hint: "Employee is currently working on it",
  },
  {
    value: "REVIEW",
    label: "IN REVIEW",
    hint: "Ready for Admin/Manager review",
  },
  {
    value: "DONE",
    label: "COMPLETED",
    hint: "Approved / completed",
  },
  {
    value: "CANCELLED",
    label: "CANCELLED",
    hint: "Cancelled by Admin/Manager",
  },
];

/** Kanban columns keep BACKLOG for existing data. */
export const KANBAN_COLUMNS = [
  { key: "BACKLOG", label: "Backlog" },
  { key: "TODO", label: "To Do" },
  { key: "IN_PROGRESS", label: "In Progress" },
  { key: "REVIEW", label: "Review" },
  { key: "DONE", label: "Done" },
];

const LABEL_BY_VALUE = {
  BACKLOG: "TODO",
  TODO: "TODO",
  IN_PROGRESS: "IN PROGRESS",
  REVIEW: "IN REVIEW",
  DONE: "COMPLETED",
  CANCELLED: "CANCELLED",
  OVERDUE: "OVERDUE",
};

function parseDue(dueDate) {
  if (!dueDate) return null;
  const raw = String(dueDate);
  // Date-only → end of that local day so "due today" is not overdue until midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T23:59:59`);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function isTaskOverdue(task) {
  if (!task) return false;
  const status = String(task?.myAssignment?.status || task.status || "").toUpperCase();
  if (status === "DONE" || status === "CANCELLED") return false;
  const zone = task.myAssignment?.zone || task.zone;
  if (zone === "ORANGE" || zone === "RED") return true;
  const due = parseDue(task.dueDate);
  if (!due) return false;
  return Date.now() > due.getTime();
}

/** Stored status (never overwrites with OVERDUE). */
export function getStoredStatus(task) {
  return String(task?.status || "TODO").toUpperCase();
}

/** Stored workflow status. Lateness is shown via Green/Orange/Red zone, not OVERDUE. */
export function getDisplayStatus(task) {
  const s = getStoredStatus(task);
  if (s === "BACKLOG") return "TODO";
  return s;
}

export function statusLabel(statusOrTask) {
  const s =
    typeof statusOrTask === "object"
      ? getDisplayStatus(statusOrTask)
      : String(statusOrTask || "").toUpperCase();
  return LABEL_BY_VALUE[s] || s || "—";
}

export function statusBadgeStyle(statusOrTask) {
  const s =
    typeof statusOrTask === "object"
      ? getDisplayStatus(statusOrTask)
      : String(statusOrTask || "").toUpperCase();

  const map = {
    TODO: { bg: "rgba(59,130,246,0.18)", color: "#60a5fa", border: "rgba(59,130,246,0.35)", dot: "#3b82f6" },
    IN_PROGRESS: { bg: "rgba(234,179,8,0.18)", color: "#facc15", border: "rgba(234,179,8,0.35)", dot: "#eab308" },
    REVIEW: { bg: "rgba(168,85,247,0.18)", color: "#c084fc", border: "rgba(168,85,247,0.35)", dot: "#a855f7" },
    DONE: { bg: "rgba(34,197,94,0.18)", color: "#4ade80", border: "rgba(34,197,94,0.35)", dot: "#22c55e" },
    OVERDUE: { bg: "rgba(239,68,68,0.18)", color: "#f87171", border: "rgba(239,68,68,0.35)", dot: "#ef4444" },
    CANCELLED: { bg: "rgba(148,163,184,0.18)", color: "#94a3b8", border: "rgba(148,163,184,0.35)", dot: "#64748b" },
  };
  return map[s] || map.TODO;
}

export function formatTaskDate(value) {
  if (!value) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T12:00:00`)
    : new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatTaskTime(value) {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatTaskDuration(task) {
  if (!task) return "";
  const type = String(task.durationType || "").toUpperCase();
  if (type === "HOURS" && Number(task.durationHours) > 0) {
    const n = Number(task.durationHours);
    return `${n} ${n === 1 ? "hour" : "hours"}`;
  }
  if (type === "DAYS" && Number(task.durationDays) > 0) {
    const n = Number(task.durationDays);
    return `${n} ${n === 1 ? "day" : "days"}`;
  }
  if (type === "DATES" && (task.durationStart || task.durationEnd)) {
    const start = task.durationStart ? formatTaskDate(task.durationStart) : "";
    const end = task.durationEnd ? formatTaskDate(task.durationEnd) : "";
    if (start && end) return `${start} – ${end}`;
    return start || end;
  }
  return "";
}

export function formatTaskDateTime(value) {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return formatTaskDate(value);
  }
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return `${formatTaskDate(value)} · ${formatTaskTime(value)}`;
}

export function splitDueParts(dueDate) {
  if (!dueDate) return { date: "", time: "" };
  const raw = String(dueDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { date: raw, time: "" };
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return { date: "", time: "" };
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

export function joinDueParts(date, time) {
  if (!date) return null;
  if (!time) return date;
  const d = new Date(`${date}T${time}`);
  if (!Number.isFinite(d.getTime())) return date;
  return d.toISOString();
}

export const TASK_CATEGORIES = [
  "Development",
  "Design",
  "HR",
  "Sales",
  "Marketing",
  "Support",
  "Meeting",
  "Administrative",
  "Other",
];

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 5000;
export const TASK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const TASK_ATTACHMENT_EXTS = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
];

export function validateTaskAttachmentFile(file) {
  if (!file) return "";
  const name = String(file.name || "").toLowerCase();
  const ok = TASK_ATTACHMENT_EXTS.some((ext) => name.endsWith(ext));
  if (!ok) {
    return "Invalid file type. Allowed: PDF, JPG, JPEG, PNG, DOC, DOCX, XLS, XLSX.";
  }
  if (file.size > TASK_ATTACHMENT_MAX_BYTES) {
    return "File must be 10 MB or smaller.";
  }
  return "";
}

export const TASK_PRIORITIES = [
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
  { value: "CRITICAL", label: "Critical" },
];

export function priorityLabel(value) {
  const p = String(value || "").toUpperCase();
  if (p === "URGENT" || p === "CRITICAL") return "Critical";
  const found = TASK_PRIORITIES.find((x) => x.value === p);
  return found?.label || p || "—";
}

export const TASK_ZONES = [
  { value: "GREEN", label: "Green", emoji: "🟢" },
  { value: "ORANGE", label: "Orange", emoji: "🟠" },
  { value: "RED", label: "Red", emoji: "🔴" },
];

const ZONE_STYLE = {
  GREEN: {
    bg: "rgba(34,197,94,0.16)",
    color: "#4ade80",
    border: "rgba(34,197,94,0.4)",
    dot: "#22c55e",
  },
  ORANGE: {
    bg: "rgba(249,115,22,0.16)",
    color: "#fb923c",
    border: "rgba(249,115,22,0.45)",
    dot: "#f97316",
  },
  RED: {
    bg: "rgba(239,68,68,0.16)",
    color: "#f87171",
    border: "rgba(239,68,68,0.45)",
    dot: "#ef4444",
  },
  COMPLETED: {
    bg: "rgba(34,197,94,0.16)",
    color: "#4ade80",
    border: "rgba(34,197,94,0.4)",
    dot: "#22c55e",
  },
  NONE: {
    bg: "rgba(148,163,184,0.16)",
    color: "#94a3b8",
    border: "rgba(148,163,184,0.35)",
    dot: "#64748b",
  },
};

function parseDeadlineMs(dueDate) {
  if (!dueDate) return null;
  const raw = String(dueDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T23:59:59`);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

/** Display-only fallback. Server zone/timing is the source of truth. */
export function computeZoneFallback(taskOrAssignment, dueDate, now = Date.now()) {
  const status = String(
    taskOrAssignment?.status || taskOrAssignment?.myAssignment?.status || ""
  ).toUpperCase();
  if (status === "DONE") {
    return (
      taskOrAssignment.completedZone ||
      taskOrAssignment.myAssignment?.completedZone ||
      taskOrAssignment.zone ||
      "GREEN"
    );
  }
  if (status === "CANCELLED") return "NONE";
  const deadline = parseDeadlineMs(dueDate || taskOrAssignment?.dueDate);
  if (!deadline) return "NONE";
  if (now < deadline) return "GREEN";
  if (now < deadline + 24 * 60 * 60 * 1000) return "ORANGE";
  return "RED";
}

export function getAssignmentZone(assignment, dueDate) {
  if (assignment?.zone) return assignment.zone;
  return computeZoneFallback(assignment, dueDate);
}

export function getTaskZone(task) {
  if (task?.myAssignment?.zone) return task.myAssignment.zone;
  if (task?.zone) return task.zone;
  return computeZoneFallback(task, task?.dueDate);
}

export function zoneDisplay(zone, status) {
  if (String(status || "").toUpperCase() === "DONE") {
    return { key: "COMPLETED", emoji: "✅", label: "Completed" };
  }
  const z = String(zone || "NONE").toUpperCase();
  if (z === "GREEN") return { key: "GREEN", emoji: "🟢", label: "Green" };
  if (z === "ORANGE") return { key: "ORANGE", emoji: "🟠", label: "Orange" };
  if (z === "RED") return { key: "RED", emoji: "🔴", label: "Red" };
  return { key: "NONE", emoji: "", label: "No deadline" };
}

export function zoneBadgeStyle(zone, status) {
  const { key } = zoneDisplay(zone, status);
  return ZONE_STYLE[key] || ZONE_STYLE.NONE;
}

export function getTaskAssignees(task) {
  if (Array.isArray(task?.assignments) && task.assignments.length) {
    return task.assignments.filter((a) => a && !a.removed);
  }
  if (Array.isArray(task?.assignees) && task.assignees.length) {
    return task.assignees.map((email) => ({ email, status: task.status }));
  }
  if (task?.assignee) {
    return [{ email: task.assignee, status: task.status, zone: task.zone }];
  }
  return [];
}

export function getTaskTiming(task) {
  return task?.myAssignment?.timing || task?.timing || "";
}

export function assignmentMatchesZoneFilter(assignment, zoneFilter, dueDate) {
  const key = String(zoneFilter || "ALL").trim().toUpperCase();
  if (!key || key === "ALL") return true;
  const status = String(assignment?.status || "").toUpperCase();
  if (key === "COMPLETED" || key === "DONE") return status === "DONE";
  if (status === "DONE" || status === "CANCELLED") return false;
  return getAssignmentZone(assignment, dueDate) === key;
}

export function applyClientZoneFilter(tasks, zoneFilter, viewerEmail) {
  const key = String(zoneFilter || "ALL").trim().toUpperCase();
  const viewer = String(viewerEmail || "").trim().toLowerCase();
  return (tasks || [])
    .map((task) => {
      let people = getTaskAssignees(task);
      if (viewer) {
        people = people.filter(
          (a) => String(a.email || "").toLowerCase() === viewer
        );
      }
      const matched =
        !key || key === "ALL"
          ? people
          : people.filter((a) =>
              assignmentMatchesZoneFilter(a, key, task.dueDate)
            );
      if (key && key !== "ALL" && !matched.length) return null;
      return { ...task, matchedAssignments: matched };
    })
    .filter(Boolean);
}

export function countZones(tasks, viewerEmail) {
  const counts = { ALL: 0, GREEN: 0, ORANGE: 0, RED: 0, COMPLETED: 0 };
  const viewer = String(viewerEmail || "").trim().toLowerCase();
  for (const task of tasks || []) {
    let people = getTaskAssignees(task);
    if (viewer) {
      people = people.filter(
        (a) => String(a.email || "").toLowerCase() === viewer
      );
    }
    if (!people.length) {
      counts.ALL += 1;
      continue;
    }
    for (const a of people) {
      const status = String(a.status || "").toUpperCase();
      if (status === "CANCELLED") continue;
      counts.ALL += 1;
      if (status === "DONE") counts.COMPLETED += 1;
      else {
        const zone = getAssignmentZone(a, task.dueDate);
        if (counts[zone] !== undefined) counts[zone] += 1;
      }
    }
  }
  return counts;
}

export function emptyZoneMessage(zoneFilter) {
  const key = String(zoneFilter || "ALL").toUpperCase();
  if (key === "GREEN") return "No Green Zone tasks found.";
  if (key === "ORANGE") return "No Orange Zone tasks found.";
  if (key === "RED") return "No Red Zone tasks found.";
  if (key === "COMPLETED") return "No completed tasks found.";
  return "No tasks found.";
}

export function taskMatchesSearch(task, q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    task.title,
    task.description,
    task.assignee,
    task.createdBy,
    task.createdByName,
    ...(Array.isArray(task.assignees) ? task.assignees : []),
  ];
  return hay.some((v) => String(v || "").toLowerCase().includes(needle));
}

export function taskMatchesPriority(task, priority) {
  if (!priority) return true;
  const want = String(priority).toUpperCase();
  const have = String(task.priority || "").toUpperCase();
  if (want === "CRITICAL" || want === "URGENT") {
    return have === "CRITICAL" || have === "URGENT";
  }
  return have === want;
}

export function taskAssignedToClient(task, email) {
  if (!email) return true;
  const e = String(email).toLowerCase();
  if (String(task.assignee || "").toLowerCase() === e) return true;
  return getTaskAssignees(task).some(
    (a) => String(a.email || "").toLowerCase() === e
  );
}

export function displayTaskId(taskId) {
  if (!taskId) return "—";
  const short = String(taskId).replace(/-/g, "").slice(0, 8).toUpperCase();
  return `TASK-${short}`;
}

export function personLabel(users, email) {
  if (!email) return { name: "Unassigned", email: "" };
  const row = (users || []).find(
    (u) => String(u.email).toLowerCase() === String(email).toLowerCase()
  );
  return {
    name: row?.name || email.split("@")[0] || email,
    email,
  };
}

export function friendlyActivityText(ev, users) {
  const action = String(ev?.action || "").toLowerCase();
  const detail = String(ev?.detail || "");
  const actor = personLabel(users, ev?.actorEmail).name || ev?.actorEmail || "Admin";

  if (action === "task_created") {
    return `Task created by ${actor}`;
  }
  if (action === "task_assigned") {
    const m = detail.match(/Assigned to (.+)/i);
    const who = m?.[1] || "";
    if (!who || who === "Unassigned") return `Task unassigned by ${actor}`;
    const names = who
      .split(",")
      .map((part) => personLabel(users, part.trim()).name || part.trim())
      .join(", ");
    return `Task assigned to ${names}`;
  }
  if (action === "task_reassigned") {
    return detail || `Task reassigned by ${actor}`;
  }
  if (action === "zone_orange") {
    return detail || "Green → Orange";
  }
  if (action === "zone_red") {
    return detail || "Orange → Red";
  }
  if (action === "deadline_changed") {
    return detail || "Deadline changed";
  }
  if (action === "task_completed") {
    return detail || `Task completed by ${actor}`;
  }
  if (action === "status_changed") {
    const m = detail.match(/→\s*(.+)$/i);
    if (m) {
      const next = m[1].trim();
      // Already human labels from newer backend, or raw codes from older.
      const mapped = statusLabel(next.replace(/\s+/g, "_")) ;
      const looksRaw = /^(TODO|IN_PROGRESS|REVIEW|DONE|CANCELLED|BACKLOG)$/i.test(
        next.replace(/\s+/g, "_")
      );
      return `Status changed to ${looksRaw ? mapped : next}`;
    }
    return detail || "Status updated";
  }
  if (action === "task_updated") return "Task details updated";
  if (action === "task_archived") return "Task archived";
  return detail || action || "Update";
}

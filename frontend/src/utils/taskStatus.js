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
  const status = String(task.status || "").toUpperCase();
  if (status === "DONE" || status === "CANCELLED") return false;
  const due = parseDue(task.dueDate);
  if (!due) return false;
  return Date.now() > due.getTime();
}

/** Stored status (never overwrites with OVERDUE). */
export function getStoredStatus(task) {
  return String(task?.status || "TODO").toUpperCase();
}

/** What Admin should see — OVERDUE when past due and not done/cancelled. */
export function getDisplayStatus(task) {
  if (isTaskOverdue(task)) return "OVERDUE";
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
    const name = personLabel(users, who).name || who;
    return `Task assigned to ${name}`;
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

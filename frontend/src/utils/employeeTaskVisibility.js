const COMPANY_TZ = "Asia/Kolkata";
const COMPANY_OFFSET = "+05:30";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ZONE_RANK = { RED: 0, ORANGE: 1, GREEN: 2, UNZONED: 3, NONE: 4 };

export function createRequestGate() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isLatest(id) {
      return id === current;
    },
  };
}

export function employeeAssignment(task) {
  return task?.myAssignment || task?.matchedAssignments?.[0] || null;
}

export function employeeStatus(task) {
  const raw = String(
    employeeAssignment(task)?.status || task?.status || "TODO"
  ).toUpperCase();
  if (raw === "BACKLOG") return "TODO";
  return raw;
}

/** Server zone only. Missing or invalid deadlines stay NONE and are not recolored. */
export function employeeZone(task) {
  const assignment = employeeAssignment(task);
  const raw = String(assignment?.zone || task?.zone || "")
    .trim()
    .toUpperCase();
  if (raw === "GREEN" || raw === "ORANGE" || raw === "RED" || raw === "NONE") {
    return raw;
  }
  const due = assignment?.dueDate || task?.dueDate;
  return due ? "UNZONED" : "NONE";
}

export function employeeStatusCounts(tasks) {
  const counts = {
    ALL: 0,
    TODO: 0,
    IN_PROGRESS: 0,
    REVIEW: 0,
    DONE: 0,
    CANCELLED: 0,
  };
  for (const task of tasks || []) {
    const status = employeeStatus(task);
    counts.ALL += 1;
    if (counts[status] !== undefined) counts[status] += 1;
  }
  return counts;
}

export function employeeZoneCounts(tasks) {
  const counts = { ALL: 0, GREEN: 0, ORANGE: 0, RED: 0, NONE: 0 };
  for (const task of tasks || []) {
    const status = employeeStatus(task);
    if (status === "DONE" || status === "CANCELLED") continue;
    counts.ALL += 1;
    const zone = employeeZone(task);
    if (counts[zone] !== undefined) counts[zone] += 1;
  }
  return counts;
}

const OPEN_STATUSES = new Set(["TODO", "IN_PROGRESS", "REVIEW"]);

export function taskMatchesMyTasksView(
  task,
  { tab = "ALL", status = "ALL", zone = "ALL", project = "" } = {}
) {
  const haveStatus = employeeStatus(task);
  const tabKey = String(tab || "ALL").toUpperCase();
  if (tabKey === "OPEN" && !OPEN_STATUSES.has(haveStatus)) return false;
  if (tabKey === "DONE" && haveStatus !== "DONE") return false;
  const statusKey = String(status || "ALL").toUpperCase();
  if (statusKey !== "ALL" && haveStatus !== statusKey) return false;
  const zoneKey = String(zone || "ALL").toUpperCase();
  if (zoneKey !== "ALL" && employeeZone(task) !== zoneKey) return false;
  const projectName = String(project || "").trim();
  if (projectName && String(task?.projectName || "").trim() !== projectName) {
    return false;
  }
  return true;
}

export function sortEmployeeTasks(tasks, mode = "earliest") {
  const rows = [...(tasks || [])];
  if (mode === "latest") {
    rows.sort((left, right) => {
      const leftDue = deadlineSortMs(left);
      const rightDue = deadlineSortMs(right);
      const leftNone = !Number.isFinite(leftDue);
      const rightNone = !Number.isFinite(rightDue);
      if (leftNone !== rightNone) return leftNone ? 1 : -1;
      if (leftDue !== rightDue) return rightDue - leftDue;
      return String(left?.taskId || "").localeCompare(String(right?.taskId || ""));
    });
    return rows;
  }
  rows.sort(compareEmployeeTasks);
  return rows;
}

export function formatEmployeeDueDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "No deadline";
  const instant = DATE_ONLY.test(raw)
    ? new Date(`${raw}T12:00:00${COMPANY_OFFSET}`)
    : new Date(raw);
  if (Number.isNaN(instant.getTime())) return raw;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: COMPANY_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(instant);
}

const PERIOD_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function kolkataParts(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: COMPANY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const read = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function kolkataStartMs(year, month, day) {
  return Date.parse(
    `${year}-${padDatePart(month)}-${padDatePart(day)}T00:00:00.000${COMPANY_OFFSET}`
  );
}

function kolkataEndMs(year, month, day) {
  return Date.parse(
    `${year}-${padDatePart(month)}-${padDatePart(day)}T23:59:59.999${COMPANY_OFFSET}`
  );
}

function shiftKolkataDate(year, month, day, deltaDays) {
  return kolkataParts(kolkataStartMs(year, month, day) + deltaDays * 86400000);
}

function daysInKolkataMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseKolkataDate(value) {
  const raw = String(value || "").trim();
  if (!DATE_ONLY.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  const start = kolkataStartMs(year, month, day);
  if (!Number.isFinite(start)) return null;
  const parts = kolkataParts(start);
  if (parts.year !== year || parts.month !== month || parts.day !== day) return null;
  return parts;
}

function monthRange(year, month) {
  return {
    startMs: kolkataStartMs(year, month, 1),
    endMs: kolkataEndMs(year, month, daysInKolkataMonth(year, month)),
  };
}

/** Inclusive Asia/Kolkata assignment window. Null means All time. */
export function assignmentPeriodRange(mode, { now = Date.now(), start = "", end = "" } = {}) {
  const key = String(mode || "ALL").trim().toUpperCase();
  const today = kolkataParts(now);
  if (key === "LAST_7" || key === "LAST7") {
    const from = shiftKolkataDate(today.year, today.month, today.day, -6);
    return {
      startMs: kolkataStartMs(from.year, from.month, from.day),
      endMs: kolkataEndMs(today.year, today.month, today.day),
    };
  }
  if (key === "THIS_MONTH") return monthRange(today.year, today.month);
  if (key === "LAST_MONTH") {
    const month = today.month === 1 ? 12 : today.month - 1;
    const year = today.month === 1 ? today.year - 1 : today.year;
    return monthRange(year, month);
  }
  if (key === "CUSTOM") {
    const from = parseKolkataDate(start);
    const to = parseKolkataDate(end);
    if (!from || !to) return { pending: true };
    const startMs = kolkataStartMs(from.year, from.month, from.day);
    const endMs = kolkataEndMs(to.year, to.month, to.day);
    if (endMs < startMs) return { invalid: true };
    return { startMs, endMs };
  }
  return null;
}

export function assignmentInPeriod(task, range) {
  if (!range || range.pending) return true;
  if (range.invalid) return false;
  const raw = employeeAssignment(task)?.assignedAt;
  const ms = Date.parse(String(raw || "").trim());
  if (!Number.isFinite(ms)) return false;
  return ms >= range.startMs && ms <= range.endMs;
}

export function formatAssignmentPeriod(range) {
  if (!range || range.pending || range.invalid || !Number.isFinite(range.startMs)) return "";
  const start = kolkataParts(range.startMs);
  const end = kolkataParts(range.endMs);
  const startMonth = PERIOD_MONTHS[start.month - 1];
  const endMonth = PERIOD_MONTHS[end.month - 1];
  if (start.year === end.year && start.month === end.month) {
    if (start.day === end.day) return `${startMonth} ${start.day}, ${start.year}`;
    return `${startMonth} ${start.day}–${end.day}, ${start.year}`;
  }
  if (start.year === end.year) {
    return `${startMonth} ${start.day}–${endMonth} ${end.day}, ${start.year}`;
  }
  return `${startMonth} ${start.day}, ${start.year}–${endMonth} ${end.day}, ${end.year}`;
}

export function taskMatchesEmployeeFilters(
  task,
  { zone = "ALL", status = "ALL" } = {}
) {
  const statusKey = String(status || "ALL").toUpperCase();
  const zoneKey = String(zone || "ALL").toUpperCase();
  const haveStatus = employeeStatus(task);
  if (statusKey === "DONE") return haveStatus === "DONE";
  if (statusKey !== "ALL" && haveStatus !== statusKey) return false;
  if (haveStatus === "DONE" || haveStatus === "CANCELLED") {
    return statusKey === "ALL" && zoneKey === "ALL";
  }
  if (zoneKey === "ALL") return true;
  return employeeZone(task) === zoneKey;
}

function deadlineInstant(value) {
  const raw = String(value || "").trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const instant = DATE_ONLY.test(raw)
    ? Date.parse(`${raw}T23:59:59${COMPANY_OFFSET}`)
    : Date.parse(raw);
  return Number.isFinite(instant) ? instant : Number.POSITIVE_INFINITY;
}

function deadlineSortMs(task) {
  const assignment = employeeAssignment(task);
  return deadlineInstant(assignment?.dueDate || task?.dueDate);
}

export function compareEmployeeTasks(left, right) {
  const leftStatus = employeeStatus(left);
  const rightStatus = employeeStatus(right);
  const leftClosed = leftStatus === "DONE" || leftStatus === "CANCELLED";
  const rightClosed = rightStatus === "DONE" || rightStatus === "CANCELLED";
  if (leftClosed !== rightClosed) return leftClosed ? 1 : -1;
  if (leftStatus === "CANCELLED" && rightStatus !== "CANCELLED") return 1;
  if (rightStatus === "CANCELLED" && leftStatus !== "CANCELLED") return -1;
  const leftZone = ZONE_RANK[employeeZone(left)] ?? 5;
  const rightZone = ZONE_RANK[employeeZone(right)] ?? 5;
  if (leftZone !== rightZone) return leftZone - rightZone;
  const leftDue = deadlineSortMs(left);
  const rightDue = deadlineSortMs(right);
  if (leftDue !== rightDue) return leftDue - rightDue;
  return String(left?.taskId || "").localeCompare(String(right?.taskId || ""));
}

const ZONE_GROUPS = [
  ["RED", "Red"],
  ["ORANGE", "Orange"],
  ["GREEN", "Green"],
  ["UNZONED", "Deadline"],
  ["NONE", "No deadline"],
];

export function groupEmployeeTasks(tasks, filters = {}) {
  const matched = (tasks || [])
    .filter((task) => taskMatchesEmployeeFilters(task, filters))
    .sort(compareEmployeeTasks);
  const zoneKey = String(filters.zone || "ALL").toUpperCase();
  const statusKey = String(filters.status || "ALL").toUpperCase();
  if (statusKey === "DONE") {
    return matched.length
      ? [{ key: "DONE", label: "Completed", tasks: matched }]
      : [];
  }
  if (zoneKey !== "ALL") {
    return matched.length
      ? [{ key: zoneKey, label: zoneGroupLabel(zoneKey), tasks: matched }]
      : [];
  }
  const groups = [];
  for (const [key, label] of ZONE_GROUPS) {
    const rows = matched.filter(
      (task) =>
        employeeStatus(task) !== "DONE" &&
        employeeStatus(task) !== "CANCELLED" &&
        employeeZone(task) === key
    );
    if (rows.length) groups.push({ key, label, tasks: rows });
  }
  const done = matched.filter((task) => employeeStatus(task) === "DONE");
  if (done.length) groups.push({ key: "DONE", label: "Completed", tasks: done });
  const cancelled = matched.filter(
    (task) => employeeStatus(task) === "CANCELLED"
  );
  if (cancelled.length) {
    groups.push({ key: "CANCELLED", label: "Cancelled", tasks: cancelled });
  }
  return groups;
}

function zoneGroupLabel(zone) {
  if (zone === "NONE") return "No deadline";
  if (zone === "UNZONED") return "Deadline";
  if (zone === "GREEN") return "Green";
  if (zone === "ORANGE") return "Orange";
  if (zone === "RED") return "Red";
  return "Tasks";
}

export function formatEmployeeDeadline(value) {
  const raw = String(value || "").trim();
  if (!raw) return "No deadline";
  const instant = DATE_ONLY.test(raw)
    ? new Date(`${raw}T23:59:59${COMPANY_OFFSET}`)
    : new Date(raw);
  if (Number.isNaN(instant.getTime())) return raw;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: COMPANY_TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(instant);
}

export function dashboardTaskBuckets(tasks) {
  const seen = new Set();
  const actionable = [];
  const inReview = [];
  for (const task of tasks || []) {
    const id = task?.taskId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const status = employeeStatus(task);
    if (status === "DONE" || status === "CANCELLED") continue;
    if (status === "REVIEW") inReview.push(task);
    else actionable.push(task);
  }
  actionable.sort(compareEmployeeTasks);
  inReview.sort(compareEmployeeTasks);
  return { actionable, inReview };
}

export function emptyEmployeeMessage(zone, status) {
  const zoneKey = String(zone || "ALL").toUpperCase();
  const statusKey = String(status || "ALL").toUpperCase();
  if (statusKey === "DONE") return "No completed tasks found.";
  if (statusKey === "REVIEW") return "No tasks in review found.";
  if (statusKey === "IN_PROGRESS") return "No in-progress tasks found.";
  if (statusKey === "TODO") return "No to-do tasks found.";
  if (zoneKey === "GREEN") return "No Green Zone tasks found.";
  if (zoneKey === "ORANGE") return "No Orange Zone tasks found.";
  if (zoneKey === "RED") return "No Red Zone tasks found.";
  if (zoneKey === "NONE") return "No tasks without a deadline found.";
  return "No tasks found.";
}

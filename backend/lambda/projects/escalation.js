/**
 * Task assignment zones: Green → Orange (from deadline) → Red.
 * TEST: Orange lasts 2 minutes. Set TASK_ORANGE_MS=86400000 for 24 hours.
 * Zone is always derived from the original deadline instant, never from
 * detection time. Completed assignments freeze their zone.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const parsedOrange = Number(process.env.TASK_ORANGE_MS);
const ORANGE_MS =
  Number.isFinite(parsedOrange) && parsedOrange > 0 ? parsedOrange : 2 * 60 * 1000;

const ZONES = {
  NONE: "NONE",
  GREEN: "GREEN",
  ORANGE: "ORANGE",
  RED: "RED",
};

const ZONE_RANK = {
  NONE: 0,
  GREEN: 1,
  ORANGE: 2,
  RED: 3,
};

const COMPLETED = "DONE";
const CANCELLED = "CANCELLED";

/** Existing priorities plus Critical. URGENT is kept for stored legacy rows. */
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT", "CRITICAL"];

const PRIORITY_LABELS = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Critical",
  CRITICAL: "Critical",
};

const TASK_CATEGORIES = [
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

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 5000;
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_EXTS = {
  ".pdf": true,
  ".jpg": true,
  ".jpeg": true,
  ".png": true,
  ".doc": true,
  ".docx": true,
  ".xls": true,
  ".xlsx": true,
};

function validateAttachment({ fileName, fileSize } = {}) {
  const name = String(fileName || "");
  const i = name.lastIndexOf(".");
  const ext = i >= 0 ? name.slice(i).toLowerCase() : "";
  if (!ATTACHMENT_EXTS[ext]) {
    return "Invalid file type. Allowed: PDF, JPG, JPEG, PNG, DOC, DOCX, XLS, XLSX.";
  }
  if (fileSize != null && fileSize !== "") {
    const size = Number(fileSize);
    if (!Number.isFinite(size) || size <= 0) return "Empty file.";
    if (size > ATTACHMENT_MAX_BYTES) return "File size exceeds the allowed limit.";
  }
  return null;
}

function normalizePriority(value) {
  const p = String(value || "").toUpperCase();
  if (p === "CRITICAL") return "CRITICAL";
  if (PRIORITIES.includes(p)) return p;
  return "MEDIUM";
}

function normalizeCategory(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const found = TASK_CATEGORIES.find(
    (c) => c.toLowerCase() === raw.toLowerCase()
  );
  return found || "";
}

function parseInstantMs(value, endOfDay = false) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const time = endOfDay ? "23:59:59" : "00:00:00";
    const ms = Date.parse(`${raw}T${time}${companyOffset()}`);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function validateCreatePayload(body = {}) {
  const errors = {};
  const title = String(body.title || "").trim();
  if (!title) errors.title = "Task title is required.";
  else if (title.length > TITLE_MAX) {
    errors.title = `Title must be ${TITLE_MAX} characters or fewer.`;
  }

  const description = String(body.description || "");
  if (description.length > DESCRIPTION_MAX) {
    errors.description = `Description must be ${DESCRIPTION_MAX} characters or fewer.`;
  }

  const emails = normalizeEmailList(body.assignees, body.assignee);
  if (!emails.length) {
    errors.assignees = "Please select at least one assignee.";
  }

  const rawPriority = String(body.priority || "").trim().toUpperCase();
  if (!rawPriority) errors.priority = "Please select a priority.";
  else if (!PRIORITIES.includes(rawPriority) && rawPriority !== "CRITICAL") {
    errors.priority = "Please select a priority.";
  }

  const categoryRaw = String(body.category || "").trim();
  const category = normalizeCategory(categoryRaw);
  if (categoryRaw && !category) {
    errors.category = "Please select a valid category.";
  }

  const startMs = parseInstantMs(body.startDate, false);
  if (!body.startDate || !Number.isFinite(startMs)) {
    errors.startDate = "Start date and time are required.";
  } else if (!isQuarterHourInstant(body.startDate)) {
    errors.startDate = quarterHourMessage("Start time");
  }

  const dueMs = parseDeadlineMs(body.dueDate);
  if (!body.dueDate || !Number.isFinite(dueMs)) {
    errors.dueDate = "Deadline date and time are required.";
  } else if (Number.isFinite(startMs) && dueMs < startMs) {
    errors.dueDate = "Deadline must be after the start date and time.";
  } else if (!isQuarterHourInstant(body.dueDate)) {
    errors.dueDate = quarterHourMessage("Deadline time");
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    title,
    description,
    emails,
    priority: rawPriority ? normalizePriority(rawPriority) : "MEDIUM",
    category,
    startDate: body.startDate || null,
    dueDate: body.dueDate || null,
  };
}

function priorityLabel(value) {
  const p = normalizePriority(value);
  return PRIORITY_LABELS[p] || p;
}

function companyOffset() {
  return process.env.COMPANY_TZ_OFFSET || "+05:30";
}

function parseDeadlineMs(dueDate) {
  if (!dueDate) return null;
  const raw = String(dueDate).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ms = Date.parse(`${raw}T23:59:59${companyOffset()}`);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function companyClockParts(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.COMPANY_TIMEZONE || "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function isQuarterHourInstant(iso) {
  if (!iso || isDateOnly(iso)) return true;
  const clock = companyClockParts(iso);
  if (!clock || !Number.isFinite(clock.minute)) return false;
  return clock.minute === 0 || clock.minute === 15 || clock.minute === 30 || clock.minute === 45;
}

function quarterHourMessage(label) {
  return `${label} must be in 15-minute intervals (00, 15, 30, or 45).`;
}

function companyDateKey(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString("en-CA", {
    timeZone: process.env.COMPANY_TIMEZONE || "Asia/Kolkata",
  });
}

/** Allow existing non-quarter times to remain; require 15-minute steps for new values. */
function allowsQuarterHourOrExisting(nextIso, previousIso) {
  if (!nextIso || isQuarterHourInstant(nextIso)) return true;
  if (!previousIso) return false;
  const nextClock = companyClockParts(nextIso);
  const prevClock = companyClockParts(previousIso);
  return (
    !!nextClock &&
    !!prevClock &&
    nextClock.hour === prevClock.hour &&
    nextClock.minute === prevClock.minute &&
    companyDateKey(nextIso) === companyDateKey(previousIso)
  );
}

function zoneAt(deadlineMs, atMs) {
  if (!Number.isFinite(deadlineMs)) return ZONES.NONE;
  if (atMs < deadlineMs) return ZONES.GREEN;
  if (atMs < deadlineMs + ORANGE_MS) return ZONES.ORANGE;
  return ZONES.RED;
}

function maxZone(a, b) {
  const left = ZONE_RANK[a] || 0;
  const right = ZONE_RANK[b] || 0;
  return left >= right ? a || b || ZONES.NONE : b || a || ZONES.NONE;
}

function isComplete(status) {
  return String(status || "").toUpperCase() === COMPLETED;
}

function isCancelled(status) {
  return String(status || "").toUpperCase() === CANCELLED;
}

function isOpenStatus(status) {
  const s = String(status || "").toUpperCase();
  return s !== COMPLETED && s !== CANCELLED;
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normalizeEmailList(input, fallbackAssignee) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === "string" && input.trim()) list = [input];
  if (!list.length && fallbackAssignee) list = [fallbackAssignee];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const n = normalizeEmail(item);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function formatDuration(ms) {
  const abs = Math.max(0, Math.abs(ms));
  const totalMinutes = Math.round(abs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }
  return parts.slice(0, 2).join(" ");
}

function formatTiming({ dueDate, zone, status, nowMs = Date.now() }) {
  if (isComplete(status) || isCancelled(status)) return "";
  const deadlineMs = parseDeadlineMs(dueDate);
  if (!Number.isFinite(deadlineMs)) return "";
  const z = zone || zoneAt(deadlineMs, nowMs);
  const overdueMs = nowMs - deadlineMs;
  if (z === ZONES.GREEN) {
    return `Due in ${formatDuration(deadlineMs - nowMs)}`;
  }
  if (z === ZONES.ORANGE) {
    const remaining = deadlineMs + ORANGE_MS - nowMs;
    return `Overdue by ${formatDuration(overdueMs)}. Orange period remaining: ${formatDuration(remaining)}`;
  }
  if (z === ZONES.RED) {
    return `Red — Overdue by ${formatDuration(overdueMs)}`;
  }
  return "";
}

function computeAssignmentView(assignment = {}, dueDate, nowMs = Date.now()) {
  const status = String(assignment.status || "TODO").toUpperCase();
  const deadlineMs = parseDeadlineMs(dueDate);

  if (isCancelled(status)) {
    return {
      zone: ZONES.NONE,
      displayZone: ZONES.NONE,
      status,
      completed: false,
      reachedRed: assignment.highestZone === ZONES.RED,
      timing: "",
    };
  }

  if (isComplete(status)) {
    const completedAtMs = assignment.completedAt
      ? Date.parse(assignment.completedAt)
      : nowMs;
    const frozen =
      assignment.completedZone ||
      zoneAt(deadlineMs, Number.isFinite(completedAtMs) ? completedAtMs : nowMs);
    const zone = frozen === ZONES.NONE ? ZONES.GREEN : frozen;
    return {
      zone,
      displayZone: zone,
      status: COMPLETED,
      completed: true,
      reachedRed:
        assignment.highestZone === ZONES.RED ||
        assignment.completedZone === ZONES.RED ||
        zone === ZONES.RED,
      timing: "",
    };
  }

  const live = zoneAt(deadlineMs, nowMs);
  return {
    zone: live,
    displayZone: live,
    status,
    completed: false,
    reachedRed: live === ZONES.RED || assignment.highestZone === ZONES.RED,
    timing: formatTiming({ dueDate, zone: live, status, nowMs }),
  };
}

function completeAssignment(assignment, dueDate, nowMs, nowIso) {
  if (isComplete(assignment.status)) {
    return { ...assignment };
  }
  const view = computeAssignmentView(
    { ...assignment, status: assignment.status || "TODO" },
    dueDate,
    nowMs
  );
  const zone = view.zone === ZONES.NONE ? ZONES.GREEN : view.zone;
  return {
    ...assignment,
    status: COMPLETED,
    completedAt: nowIso,
    completedDate: String(nowIso).slice(0, 10),
    completedZone: zone,
    highestZone: maxZone(assignment.highestZone, zone),
    recordedZone: zone,
  };
}

/**
 * Persistable zone transitions for an incomplete assignment.
 * Event timestamps use the original deadline (and deadline+24h), not now.
 */
function detectTransitions(assignment, dueDate, nowMs = Date.now()) {
  if (isComplete(assignment.status) || isCancelled(assignment.status)) {
    return { assignment: { ...assignment }, events: [] };
  }
  const deadlineMs = parseDeadlineMs(dueDate);
  const live = zoneAt(deadlineMs, nowMs);
  const recorded = assignment.recordedZone || (deadlineMs ? ZONES.GREEN : ZONES.NONE);
  if (live === recorded) {
    return {
      assignment: {
        ...assignment,
        recordedZone: live,
        highestZone: maxZone(assignment.highestZone, live),
      },
      events: [],
    };
  }

  const events = [];
  const orangeAt = Number.isFinite(deadlineMs)
    ? new Date(deadlineMs).toISOString()
    : new Date(nowMs).toISOString();
  const redAt = Number.isFinite(deadlineMs)
    ? new Date(deadlineMs + ORANGE_MS).toISOString()
    : new Date(nowMs).toISOString();

  const recRank = ZONE_RANK[recorded] || 0;
  if (ZONE_RANK[live] >= ZONE_RANK.ORANGE && recRank < ZONE_RANK.ORANGE) {
    events.push({
      action: "zone_orange",
      detail: "Green → Orange",
      timestamp: orangeAt,
      email: assignment.email,
    });
  }
  if (ZONE_RANK[live] >= ZONE_RANK.RED && recRank < ZONE_RANK.RED) {
    events.push({
      action: "zone_red",
      detail: "Orange → Red",
      timestamp: redAt,
      email: assignment.email,
    });
  }

  return {
    assignment: {
      ...assignment,
      recordedZone: live,
      highestZone: maxZone(assignment.highestZone, live),
      zoneReachedAt: live === ZONES.RED ? redAt : orangeAt,
    },
    events,
  };
}

function approachingDeadline(dueDate, nowMs = Date.now(), windowMs = 2 * 60 * 60 * 1000) {
  const deadlineMs = parseDeadlineMs(dueDate);
  if (!Number.isFinite(deadlineMs)) return false;
  const remaining = deadlineMs - nowMs;
  return remaining > 0 && remaining <= windowMs;
}

function synthesizeAssignments(task) {
  if (Array.isArray(task.assignments) && task.assignments.length) {
    return task.assignments
      .filter((a) => a && !a.removed)
      .map((a) => ({
        ...a,
        email: normalizeEmail(a.email),
      }));
  }
  const emails = normalizeEmailList(task.assignees, task.assignee);
  return emails.map((email) => ({
    email,
    status: emails.length === 1 ? task.status || "TODO" : "TODO",
    completedAt: emails.length === 1 ? task.completedAt || task.completedDate || null : null,
    completedDate: emails.length === 1 ? task.completedDate || null : null,
    completedZone: emails.length === 1 ? task.completedZone || null : null,
    highestZone: emails.length === 1 ? task.highestZone || null : null,
    recordedZone: emails.length === 1 ? task.recordedZone || null : null,
    assignedAt: task.createdAt || null,
  }));
}

function deriveParentStatus(assignments, fallback = "TODO") {
  const active = (assignments || []).filter((a) => a && !a.removed);
  if (!active.length) return fallback || "TODO";
  const statuses = active.map((a) => String(a.status || "TODO").toUpperCase());
  if (statuses.every((s) => s === CANCELLED)) return CANCELLED;
  if (statuses.every((s) => s === COMPLETED || s === CANCELLED)) return COMPLETED;
  if (statuses.some((s) => s === "REVIEW")) return "REVIEW";
  if (statuses.some((s) => s === "IN_PROGRESS")) return "IN_PROGRESS";
  if (statuses.some((s) => s === "BACKLOG") && statuses.every((s) => s === "BACKLOG")) {
    return "BACKLOG";
  }
  return "TODO";
}

function worstOpenZone(assignments, dueDate, nowMs = Date.now()) {
  let worst = ZONES.NONE;
  for (const a of assignments || []) {
    if (a.removed || isCancelled(a.status)) continue;
    const view = computeAssignmentView(a, dueDate, nowMs);
    if (view.completed) continue;
    worst = maxZone(worst, view.zone);
  }
  return worst;
}

function decorateAssignment(assignment, dueDate, nowMs) {
  const view = computeAssignmentView(assignment, dueDate, nowMs);
  return {
    email: assignment.email,
    status: view.status,
    assignedAt: assignment.assignedAt || null,
    completedAt: assignment.completedAt || null,
    completedDate: assignment.completedDate || null,
    completedZone: isComplete(view.status) ? view.zone : null,
    highestZone: maxZone(assignment.highestZone, view.zone),
    zone: view.zone,
    displayZone: view.displayZone,
    reachedRed: view.reachedRed,
    timing: view.timing,
    removed: !!assignment.removed,
  };
}

function displayNameFromEmail(email) {
  const local = String(email || "").split("@")[0] || "";
  const name = local
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return name || String(email || "").trim();
}

function pickPersonName(...candidates) {
  for (const value of candidates) {
    const name = String(value || "").trim();
    if (name && !name.includes("@")) return name;
  }
  return "";
}

function creatorDisplayName(task = {}) {
  return (
    pickPersonName(task.createdByName) ||
    displayNameFromEmail(task.createdBy) ||
    String(task.createdBy || "").trim()
  );
}

function decorateTask(task, nowMs = Date.now(), viewerEmail) {
  const assignments = synthesizeAssignments(task).map((a) =>
    decorateAssignment(a, task.dueDate, nowMs)
  );
  const viewer = normalizeEmail(viewerEmail);
  const mine = viewer
    ? assignments.find((a) => a.email === viewer && !a.removed)
    : null;
  const zone = mine ? mine.zone : worstOpenZone(assignments, task.dueDate, nowMs);
  const overdue = zone === ZONES.ORANGE || zone === ZONES.RED;
  return {
    ...task,
    assignees: assignments.filter((a) => !a.removed).map((a) => a.email),
    assignee: task.assignee || assignments.find((a) => !a.removed)?.email || "",
    assignments,
    zone,
    overdue,
    displayStatus: overdue && !isComplete(task.status) ? "OVERDUE" : task.status,
    myAssignment: mine || null,
    timing: mine
      ? mine.timing
      : formatTiming({ dueDate: task.dueDate, zone, status: task.status, nowMs }),
    priorityLabel: priorityLabel(task.priority),
    createdByName: creatorDisplayName(task),
  };
}

function taskAssignedTo(task, email) {
  const e = normalizeEmail(email);
  if (!e) return false;
  if (normalizeEmail(task.assignee) === e) return true;
  const list = Array.isArray(task.assignees) ? task.assignees : [];
  if (list.some((x) => normalizeEmail(x) === e)) return true;
  const asg = Array.isArray(task.assignments) ? task.assignments : [];
  return asg.some((a) => !a.removed && normalizeEmail(a.email) === e);
}

function normalizeZoneFilter(zone) {
  const key = String(zone || "ALL").trim().toUpperCase();
  if (key === "COMPLETE" || key === "DONE") return "COMPLETED";
  if (["ALL", "GREEN", "ORANGE", "RED", "COMPLETED"].includes(key)) return key;
  return "ALL";
}

function assignmentFilterKey(assignment) {
  if (isComplete(assignment?.status)) return "COMPLETED";
  if (isCancelled(assignment?.status)) return "CANCELLED";
  const z = String(assignment?.zone || assignment?.displayZone || "").toUpperCase();
  if (z === "GREEN" || z === "ORANGE" || z === "RED") return z;
  return "NONE";
}

function assignmentMatchesZone(assignment, zoneFilter) {
  if (!assignment || assignment.removed) return false;
  const key = normalizeZoneFilter(zoneFilter);
  if (key === "ALL") return true;
  if (key === "COMPLETED") return isComplete(assignment.status);
  if (isComplete(assignment.status) || isCancelled(assignment.status)) return false;
  return assignmentFilterKey(assignment) === key;
}

function matchesSearch(task, q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    task.title,
    task.description,
    task.category,
    task.assignee,
    task.createdBy,
    task.createdByName,
    ...(Array.isArray(task.assignees) ? task.assignees : []),
    ...(Array.isArray(task.assignments)
      ? task.assignments.map((a) => a.email)
      : []),
  ];
  return hay.some((v) => String(v || "").toLowerCase().includes(needle));
}

function matchesPriorityFilter(task, priority) {
  if (!priority) return true;
  const want = normalizePriority(priority);
  const have = normalizePriority(task.priority);
  if (want === "CRITICAL" || want === "URGENT") {
    return have === "CRITICAL" || have === "URGENT";
  }
  return have === want;
}

function visibleAssignments(task, viewerEmail) {
  const all = (task.assignments || []).filter((a) => a && !a.removed);
  const viewer = normalizeEmail(viewerEmail);
  if (!viewer) return all;
  return all.filter((a) => a.email === viewer);
}

function zoneCounts(tasks, viewerEmail) {
  const counts = { ALL: 0, GREEN: 0, ORANGE: 0, RED: 0, COMPLETED: 0 };
  for (const task of tasks || []) {
    const assignments = visibleAssignments(task, viewerEmail);
    if (!assignments.length) {
      counts.ALL += 1;
      continue;
    }
    for (const a of assignments) {
      if (isCancelled(a.status)) continue;
      counts.ALL += 1;
      const key = assignmentFilterKey(a);
      if (key === "COMPLETED") counts.COMPLETED += 1;
      else if (counts[key] !== undefined) counts[key] += 1;
    }
  }
  return counts;
}

function applyZoneFilter(tasks, zoneFilter, viewerEmail) {
  const key = normalizeZoneFilter(zoneFilter);
  return (tasks || [])
    .map((task) => {
      const relevant = visibleAssignments(task, viewerEmail);
      const matched =
        key === "ALL"
          ? relevant
          : relevant.filter((a) => assignmentMatchesZone(a, key));
      if (key !== "ALL" && !matched.length) return null;
      return { ...task, matchedAssignments: matched };
    })
    .filter(Boolean);
}

function resetEscalationForNewDeadline(assignment, newDueDate, nowMs) {
  if (isComplete(assignment.status) || isCancelled(assignment.status)) {
    return { ...assignment };
  }
  const live = zoneAt(parseDeadlineMs(newDueDate), nowMs);
  return {
    ...assignment,
    recordedZone: live,
    highestZone: live,
    zoneReachedAt: null,
    completedZone: null,
  };
}

function redAdminNotifyStatusOf(task = {}) {
  return String(task.redAdminNotifyStatus || "").toUpperCase();
}

/**
 * Immediate Red-zone admin email: send on first RED transition, retry FAILED/PENDING,
 * never resend after SENT. Independent of recorded zone so email failure cannot
 * block the Red state, and later sweeps cannot duplicate a successful send.
 */
function needsRedAdminNotify(task, assignment = {}, enteredRed = false, nowMs = Date.now()) {
  if (assignment.removed || isComplete(assignment.status) || isCancelled(assignment.status)) {
    return false;
  }
  const assignmentStatus = redAdminNotifyStatusOf(assignment);
  if (assignmentStatus === "SENT") return false;

  const hasEmail = !!normalizeEmail(assignment.email);
  const taskStatus = redAdminNotifyStatusOf(task);
  // Legacy single-assignee rows stored the flag on the task item only.
  if (!hasEmail && !assignmentStatus && taskStatus === "SENT") return false;

  if (enteredRed) return true;
  if (assignmentStatus === "FAILED" || assignmentStatus === "PENDING") return true;
  if (!hasEmail && (taskStatus === "FAILED" || taskStatus === "PENDING")) {
    return true;
  }
  if (hasEmail && !assignmentStatus) {
    const live = zoneAt(parseDeadlineMs(task.dueDate), nowMs);
    if (live === ZONES.RED) return true;
  }
  return false;
}

/** Employees may change status in Green/Orange. Red is admin-only. */
function employeeMayChangeStatus(assignment, dueDate, nowMs = Date.now()) {
  if (!assignment || assignment.removed || isCancelled(assignment.status)) {
    return false;
  }
  if (isComplete(assignment.status)) return false;
  const view = computeAssignmentView(assignment, dueDate, nowMs);
  return view.zone !== ZONES.RED;
}

function employeeMayComplete(assignment, dueDate, nowMs = Date.now()) {
  return employeeMayChangeStatus(assignment, dueDate, nowMs);
}

module.exports = {
  ORANGE_MS,
  ZONES,
  ZONE_RANK,
  PRIORITIES,
  TASK_CATEGORIES,
  TITLE_MAX,
  DESCRIPTION_MAX,
  parseDeadlineMs,
  parseInstantMs,
  zoneAt,
  maxZone,
  isComplete,
  isCancelled,
  isOpenStatus,
  normalizeEmail,
  normalizeEmailList,
  normalizePriority,
  normalizeCategory,
  validateCreatePayload,
  allowsQuarterHourOrExisting,
  validateAttachment,
  priorityLabel,
  formatDuration,
  formatTiming,
  computeAssignmentView,
  completeAssignment,
  detectTransitions,
  approachingDeadline,
  synthesizeAssignments,
  deriveParentStatus,
  worstOpenZone,
  decorateAssignment,
  decorateTask,
  taskAssignedTo,
  resetEscalationForNewDeadline,
  normalizeZoneFilter,
  assignmentFilterKey,
  assignmentMatchesZone,
  matchesSearch,
  matchesPriorityFilter,
  visibleAssignments,
  zoneCounts,
  applyZoneFilter,
  displayNameFromEmail,
  pickPersonName,
  creatorDisplayName,
  redAdminNotifyStatusOf,
  needsRedAdminNotify,
  employeeMayChangeStatus,
  employeeMayComplete,
  DAY_MS,
};

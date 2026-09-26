const { randomUUID } = require("crypto");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { companyDateKey, SHIFT_TIMES } = require("../common/shiftWindows");
const { isOpenStatus, normalizeEmail } = require("./escalation");
const { requireEligiblePortalAdmin } = require("./portalAdminAuth");

const SHIFT_ENTITY_PK = "ENTITY#SHIFT";
const TYPE_SHIFT = "SHIFT";
const TYPE_SHIFT_ASSIGNMENT = "SHIFT_ASSIGNMENT";
const STATUS_ACTIVE = "ACTIVE";
const STATUS_INACTIVE = "INACTIVE";
const HM_RE = /^\d{2}:\d{2}$/;
const NAME_MAX = 80;
const GRACE_MAX = 24 * 60;
const DAY_MINUTES = 24 * 60;
const ACTIVE_TASKS_LIMIT = 20;
const CODE_ACTIVE_TASKS = "ACTIVE_TASKS";
const SHIFT_FIT_CONFLICT = "SHIFT_CONFLICT";
const SHIFT_FIT_NO_SHIFT = "NO_SHIFT";

const SEED_SHIFTS = [
  {
    shiftId: "morning",
    name: "Morning Shift",
    startTime: SHIFT_TIMES["Full Day"]["Morning Shift"].in,
    endTime: SHIFT_TIMES["Full Day"]["Morning Shift"].out,
    graceMinutes: 0,
  },
  {
    shiftId: "afternoon",
    name: "Afternoon Shift",
    startTime: SHIFT_TIMES["Full Day"]["Afternoon Shift"].in,
    endTime: SHIFT_TIMES["Full Day"]["Afternoon Shift"].out,
    graceMinutes: 0,
  },
  {
    shiftId: "evening",
    name: "Evening Shift",
    startTime: SHIFT_TIMES["Full Day"]["Evening Shift"].in,
    endTime: SHIFT_TIMES["Full Day"]["Evening Shift"].out,
    graceMinutes: 0,
  },
];

function shiftSk(shiftId) {
  return `SHIFT#${shiftId}`;
}

function userPk(email) {
  return `USER#${email}`;
}

function currentSk() {
  return "SHIFT#CURRENT";
}

function histSk(effectiveFrom, assignedAt) {
  return `SHIFT#HIST#${effectiveFrom}#${assignedAt}`;
}

function normalizePath(path) {
  return String(path || "").replace(/\/+$/, "");
}

function listShiftsPathMatch(path) {
  const normalized = normalizePath(path);
  return /\/shifts$/.test(normalized) && !/\/employees\//.test(normalized);
}

function shiftIdPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  const fromParams = pathParameters?.shiftId
    ? String(pathParameters.shiftId)
    : "";
  if (fromParams && /\/shifts\/[^/]+$/.test(normalized)) {
    return decodeURIComponent(fromParams).trim();
  }
  const match = normalized.match(/\/shifts\/([^/]+)$/);
  if (!match) return null;
  return decodeURIComponent(match[1]).trim() || null;
}

function employeeShiftPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  const fromParams = pathParameters?.email ? String(pathParameters.email) : "";
  if (fromParams && /\/employees\/[^/]+\/shift$/.test(normalized)) {
    return normalizeEmail(decodeURIComponent(fromParams));
  }
  const match = normalized.match(/\/employees\/([^/]+)\/shift$/);
  if (!match) return null;
  return normalizeEmail(decodeURIComponent(match[1]));
}

function normalizeHm(value) {
  const text = String(value || "").trim();
  if (/^\d{2}:\d{2}:\d{2}$/.test(text)) return text.slice(0, 5);
  return text;
}

function isValidHm(value) {
  if (!HM_RE.test(value)) return false;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return hour <= 23 && minute <= 59;
}

function crossesMidnightFromTimes(startTime, endTime) {
  return String(endTime) <= String(startTime);
}

function hmToMinutes(value) {
  return Number(String(value).slice(0, 2)) * 60 + Number(String(value).slice(3, 5));
}

function linearWindow(startTime, endTime) {
  const start = hmToMinutes(startTime);
  let end = hmToMinutes(endTime);
  if (end <= start) end += DAY_MINUTES;
  return { start, end };
}

function normalizeHalfDayEnabled(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function publicHalfPeriod(half) {
  if (!half || !half.startTime || !half.endTime) return null;
  return {
    startTime: half.startTime,
    endTime: half.endTime,
    graceMinutes: Number(half.graceMinutes || 0),
  };
}

function snapshotHalfPeriod(half) {
  const pub = publicHalfPeriod(half);
  return pub ? { ...pub } : null;
}

function publicHalfDayFields(item) {
  const halfDayEnabled = item?.halfDayEnabled === true;
  return {
    halfDayEnabled,
    firstHalf: halfDayEnabled ? publicHalfPeriod(item.firstHalf) : null,
    secondHalf: halfDayEnabled ? publicHalfPeriod(item.secondHalf) : null,
  };
}

function parseHalfPeriod(label, raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [`${label} start and end times are required.`] };
  }
  const startTime = normalizeHm(raw.startTime);
  const endTime = normalizeHm(raw.endTime);
  if (!isValidHm(startTime)) errors.push(`${label} start time must be HH:mm.`);
  if (!isValidHm(endTime)) errors.push(`${label} end time must be HH:mm.`);
  if (isValidHm(startTime) && isValidHm(endTime) && startTime === endTime) {
    errors.push(`${label} end time must be different from start time.`);
  }
  const rawGrace = raw.graceMinutes;
  const grace =
    rawGrace === undefined || rawGrace === null || rawGrace === ""
      ? 0
      : Number(rawGrace);
  if (!Number.isFinite(grace) || grace < 0 || grace > GRACE_MAX) {
    errors.push(`${label} grace period must be minutes between 0 and 1440.`);
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    values: {
      startTime,
      endTime,
      graceMinutes: Math.round(grace),
    },
  };
}

function halfStaysInsideFull(fullStart, fullEnd, halfStart, halfEnd) {
  const full = linearWindow(fullStart, fullEnd);
  const half = linearWindow(halfStart, halfEnd);
  const duration = half.end - half.start;
  return [half.start, half.start + DAY_MINUTES].some((placedStart) => {
    const placedEnd = placedStart + duration;
    return placedStart >= full.start && placedEnd <= full.end;
  });
}

function validateHalfAgainstFull(label, half, fullStart, fullEnd, fullCrosses) {
  const errors = [];
  if (crossesMidnightFromTimes(half.startTime, half.endTime) && !fullCrosses) {
    errors.push(
      `${label} can cross midnight only when the full shift crosses midnight.`
    );
    return errors;
  }
  if (!halfStaysInsideFull(fullStart, fullEnd, half.startTime, half.endTime)) {
    errors.push(`${label} must stay within the full shift hours.`);
  }
  return errors;
}

function publicShift(item) {
  if (!item) return null;
  return {
    shiftId: item.shiftId,
    name: item.name,
    startTime: item.startTime,
    endTime: item.endTime,
    graceMinutes: Number(item.graceMinutes || 0),
    crossesMidnight: !!item.crossesMidnight,
    status: item.status === STATUS_INACTIVE ? STATUS_INACTIVE : STATUS_ACTIVE,
    createdAt: item.createdAt || null,
    createdBy: item.createdBy || "",
    updatedAt: item.updatedAt || null,
    ...publicHalfDayFields(item),
  };
}

function publicAssignment(item) {
  if (!item) return null;
  return {
    shiftId: item.shiftId,
    name: item.name,
    startTime: item.startTime,
    endTime: item.endTime,
    graceMinutes: Number(item.graceMinutes || 0),
    crossesMidnight: !!item.crossesMidnight,
    effectiveFrom: item.effectiveFrom || null,
    effectiveTo: item.effectiveTo || null,
    assignedAt: item.assignedAt || null,
    assignedBy: item.assignedBy || "",
    ...publicHalfDayFields(item),
  };
}

function parseShiftFields(body = {}, { partial } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name) errors.push("Shift name is required.");
    else if (name.length > NAME_MAX) {
      errors.push(`Shift name must be ${NAME_MAX} characters or fewer.`);
    } else out.name = name;
  }

  if (!partial || body.startTime !== undefined) {
    const startTime = normalizeHm(body.startTime);
    if (!isValidHm(startTime)) errors.push("Start time must be HH:mm.");
    else out.startTime = startTime;
  }

  if (!partial || body.endTime !== undefined) {
    const endTime = normalizeHm(body.endTime);
    if (!isValidHm(endTime)) errors.push("End time must be HH:mm.");
    else out.endTime = endTime;
  }

  if (!partial || body.graceMinutes !== undefined) {
    const raw = body.graceMinutes;
    const n = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > GRACE_MAX) {
      errors.push("Grace period must be minutes between 0 and 1440.");
    } else out.graceMinutes = Math.round(n);
  }

  if (!partial || body.status !== undefined) {
    const status = String(body.status || STATUS_ACTIVE).trim().toUpperCase();
    if (status !== STATUS_ACTIVE && status !== STATUS_INACTIVE) {
      errors.push("Status must be ACTIVE or INACTIVE.");
    } else if (body.status !== undefined || !partial) {
      out.status = status;
    }
  }

  if (out.startTime && out.endTime && out.startTime === out.endTime) {
    errors.push("End time must be different from start time.");
  }

  const halfDayTouched =
    body.halfDayEnabled !== undefined ||
    body.firstHalf !== undefined ||
    body.secondHalf !== undefined;
  if (!partial || halfDayTouched) {
    const halfDayEnabled = normalizeHalfDayEnabled(
      body.halfDayEnabled === undefined ? false : body.halfDayEnabled
    );
    out.halfDayEnabled = halfDayEnabled;
    if (!halfDayEnabled) {
      out.firstHalf = null;
      out.secondHalf = null;
    } else {
      const first = parseHalfPeriod("First half", body.firstHalf);
      const second = parseHalfPeriod("Second half", body.secondHalf);
      if (!first.ok) errors.push(...first.errors);
      if (!second.ok) errors.push(...second.errors);
      if (first.ok) out.firstHalf = first.values;
      if (second.ok) out.secondHalf = second.values;
      if (first.ok && second.ok && out.startTime && out.endTime) {
        const fullCrosses = crossesMidnightFromTimes(out.startTime, out.endTime);
        errors.push(
          ...validateHalfAgainstFull(
            "First half",
            first.values,
            out.startTime,
            out.endTime,
            fullCrosses
          )
        );
        errors.push(
          ...validateHalfAgainstFull(
            "Second half",
            second.values,
            out.startTime,
            out.endTime,
            fullCrosses
          )
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, values: out };
}

function slugShiftId(name) {
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `shift-${randomUUID().slice(0, 8)}`;
}

function isPendingScheduledTask(task) {
  const mode = String(task?.assignmentMode || "").toUpperCase();
  const state = String(task?.assignmentState || "").toUpperCase();
  return (
    mode === "SCHEDULED" &&
    (state === "PENDING" || state === "ASSIGNING" || state === "SKIPPED")
  );
}

function pendingIncludesEmail(task, email) {
  const target = normalizeEmail(email);
  if (!target) return false;
  return (task?.pendingAssignees || []).some(
    (value) => normalizeEmail(value) === target
  );
}

function unresolvedShiftConflictStatus(task, email) {
  if (!pendingIncludesEmail(task, email)) return null;
  const target = normalizeEmail(email);
  const fitMap = task?.lastShiftFitByEmail || {};
  const result = String(fitMap[target] || "").toUpperCase();
  if (result === SHIFT_FIT_CONFLICT || result === SHIFT_FIT_NO_SHIFT) {
    return result;
  }
  return null;
}

function isConditionalCheckFailed(err) {
  return (
    err?.name === "ConditionalCheckFailedException" ||
    err?.code === "ConditionalCheckFailedException"
  );
}

async function queryAll(ddb, params) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        ...params,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function getShiftItem(ddb, tableName, shiftId) {
  const id = String(shiftId || "").trim();
  if (!id) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: SHIFT_ENTITY_PK, SK: shiftSk(id) },
    })
  );
  return res.Item || null;
}

async function getCurrentAssignment(ddb, tableName, email) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: userPk(email), SK: currentSk() },
    })
  );
  return res.Item || null;
}

function assignmentSnapshot(shift, { email, effectiveFrom, effectiveTo, assignedAt, assignedBy }) {
  const halfDayEnabled = shift?.halfDayEnabled === true;
  const snapshot = {
    type: TYPE_SHIFT_ASSIGNMENT,
    email,
    shiftId: shift.shiftId,
    name: shift.name,
    startTime: shift.startTime,
    endTime: shift.endTime,
    graceMinutes: Number(shift.graceMinutes || 0),
    crossesMidnight: !!shift.crossesMidnight,
    halfDayEnabled,
    effectiveFrom,
    effectiveTo: effectiveTo || null,
    assignedAt,
    assignedBy,
  };
  if (halfDayEnabled) {
    snapshot.firstHalf = snapshotHalfPeriod(shift.firstHalf);
    snapshot.secondHalf = snapshotHalfPeriod(shift.secondHalf);
  }
  return snapshot;
}

function persistHalfDayFields(target, parsedValues) {
  if (parsedValues.halfDayEnabled) {
    target.halfDayEnabled = true;
    target.firstHalf = parsedValues.firstHalf;
    target.secondHalf = parsedValues.secondHalf;
    return;
  }
  target.halfDayEnabled = false;
  delete target.firstHalf;
  delete target.secondHalf;
}

async function seedShiftsIfMissing({ ddb, tableName, nowIso, actor }) {
  for (const seed of SEED_SHIFTS) {
    const item = {
      PK: SHIFT_ENTITY_PK,
      SK: shiftSk(seed.shiftId),
      type: TYPE_SHIFT,
      shiftId: seed.shiftId,
      name: seed.name,
      startTime: seed.startTime,
      endTime: seed.endTime,
      graceMinutes: seed.graceMinutes,
      crossesMidnight: crossesMidnightFromTimes(seed.startTime, seed.endTime),
      status: STATUS_ACTIVE,
      createdAt: nowIso,
      createdBy: actor || "SYSTEM",
      updatedAt: nowIso,
    };
    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(PK)",
        })
      );
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }
  }
}

async function listShiftItems(ddb, tableName) {
  return queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": SHIFT_ENTITY_PK,
      ":sk": "SHIFT#",
    },
  });
}

async function findActiveAssignments(ddb, tableName, email) {
  const tasks = await queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
  });
  const target = normalizeEmail(email);
  const active = [];
  for (const task of tasks) {
    if (task?.archived) continue;
    const taskId = String(task.taskId || "").trim();
    if (!taskId) continue;
    const conflictStatus = unresolvedShiftConflictStatus(task, target);
    if (conflictStatus) {
      active.push({
        taskId,
        title: task.title || "",
        status: conflictStatus,
      });
      if (active.length >= ACTIVE_TASKS_LIMIT) break;
      continue;
    }
    if (isPendingScheduledTask(task)) continue;
    const res = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `TASK#${taskId}`, SK: `ASSIGNMENT#${target}` },
      })
    );
    const assignment = res.Item || null;
    if (!assignment || assignment.removed) continue;
    if (!isOpenStatus(assignment.status)) continue;
    active.push({
      taskId,
      title: task.title || "",
      status: assignment.status,
    });
    if (active.length >= ACTIVE_TASKS_LIMIT) break;
  }
  return active;
}

function addDaysToKey(key, days) {
  const [y, m, d] = String(key)
    .split("-")
    .map((part) => Number(part));
  if (!y || !m || !d) return key;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function requireShiftAdmin({ user, ddb, accessTable }) {
  return requireEligiblePortalAdmin({ user, ddb, accessTable });
}

async function handleListShifts({ user, ddb, tableName, accessTable, nowIso }) {
  const auth = await requireShiftAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  await seedShiftsIfMissing({
    ddb,
    tableName,
    nowIso,
    actor: auth.email,
  });
  const items = await listShiftItems(ddb, tableName);
  const shifts = items
    .map(publicShift)
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { statusCode: 200, body: { shifts } };
}

async function handleCreateShift({ user, body, ddb, tableName, accessTable, nowIso }) {
  const auth = await requireShiftAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const parsed = parseShiftFields(body || {}, { partial: false });
  if (!parsed.ok) {
    return { statusCode: 400, body: { error: parsed.errors[0], errors: parsed.errors } };
  }
  let shiftId = slugShiftId(parsed.values.name);
  let existing = await getShiftItem(ddb, tableName, shiftId);
  if (existing) shiftId = `${shiftId}-${randomUUID().slice(0, 8)}`;
  const now = nowIso || new Date().toISOString();
  const item = {
    PK: SHIFT_ENTITY_PK,
    SK: shiftSk(shiftId),
    type: TYPE_SHIFT,
    shiftId,
    name: parsed.values.name,
    startTime: parsed.values.startTime,
    endTime: parsed.values.endTime,
    graceMinutes: parsed.values.graceMinutes,
    crossesMidnight: crossesMidnightFromTimes(
      parsed.values.startTime,
      parsed.values.endTime
    ),
    status: STATUS_ACTIVE,
    createdAt: now,
    createdBy: auth.email,
    updatedAt: now,
  };
  persistHalfDayFields(item, parsed.values);
  await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
  return { statusCode: 201, body: { shift: publicShift(item) } };
}

async function handleUpdateShift({
  user,
  shiftId,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
}) {
  const auth = await requireShiftAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const id = String(shiftId || "").trim();
  if (!id) return { statusCode: 400, body: { error: "shiftId required" } };
  const existing = await getShiftItem(ddb, tableName, id);
  if (!existing) return { statusCode: 404, body: { error: "Shift not found." } };
  const parsed = parseShiftFields(
    {
      name: body?.name !== undefined ? body.name : existing.name,
      startTime: body?.startTime !== undefined ? body.startTime : existing.startTime,
      endTime: body?.endTime !== undefined ? body.endTime : existing.endTime,
      graceMinutes:
        body?.graceMinutes !== undefined ? body.graceMinutes : existing.graceMinutes,
      status: body?.status !== undefined ? body.status : existing.status,
      halfDayEnabled:
        body?.halfDayEnabled !== undefined
          ? body.halfDayEnabled
          : existing.halfDayEnabled,
      firstHalf: body?.firstHalf !== undefined ? body.firstHalf : existing.firstHalf,
      secondHalf:
        body?.secondHalf !== undefined ? body.secondHalf : existing.secondHalf,
    },
    { partial: false }
  );
  if (!parsed.ok) {
    return { statusCode: 400, body: { error: parsed.errors[0], errors: parsed.errors } };
  }
  const now = nowIso || new Date().toISOString();
  const next = {
    ...existing,
    name: parsed.values.name,
    startTime: parsed.values.startTime,
    endTime: parsed.values.endTime,
    graceMinutes: parsed.values.graceMinutes,
    crossesMidnight: crossesMidnightFromTimes(
      parsed.values.startTime,
      parsed.values.endTime
    ),
    status: parsed.values.status,
    updatedAt: now,
  };
  persistHalfDayFields(next, parsed.values);
  await ddb.send(new PutCommand({ TableName: tableName, Item: next }));
  return { statusCode: 200, body: { shift: publicShift(next) } };
}

async function handleGetEmployeeShift({
  user,
  email,
  ddb,
  tableName,
  accessTable,
}) {
  const actor = normalizeEmail(user?.email);
  if (!actor) return { statusCode: 401, body: { error: "Unauthorized" } };
  const target = normalizeEmail(email);
  if (!target) return { statusCode: 400, body: { error: "Employee email required" } };
  if (actor !== target) {
    const auth = await requireShiftAdmin({ user, ddb, accessTable });
    if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  }
  const current = await getCurrentAssignment(ddb, tableName, target);
  return { statusCode: 200, body: { shift: publicAssignment(current) } };
}

async function handleAssignEmployeeShift({
  user,
  email,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
  nowMs,
}) {
  const auth = await requireShiftAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const target = normalizeEmail(email);
  if (!target) return { statusCode: 400, body: { error: "Employee email required" } };
  const shiftId = String(body?.shiftId || "").trim();
  if (!shiftId) return { statusCode: 400, body: { error: "shiftId required" } };
  const shift = await getShiftItem(ddb, tableName, shiftId);
  if (!shift) return { statusCode: 404, body: { error: "Shift not found." } };
  if (String(shift.status || "").toUpperCase() !== STATUS_ACTIVE) {
    return {
      statusCode: 400,
      body: { error: "Inactive shifts cannot be newly assigned." },
    };
  }

  const clockMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const now = nowIso || new Date(clockMs).toISOString();
  const effectiveFrom =
    String(body?.effectiveFrom || "").trim() || companyDateKey(new Date(clockMs));

  const current = await getCurrentAssignment(ddb, tableName, target);
  if (current && current.shiftId === shift.shiftId) {
    return { statusCode: 200, body: { shift: publicAssignment(current), unchanged: true } };
  }

  if (current) {
    const activeTasks = await findActiveAssignments(ddb, tableName, target);
    if (activeTasks.length) {
      return {
        statusCode: 409,
        body: {
          error:
            "This employee's shift cannot be changed while they have active tasks. Complete or reassign those tasks first.",
          code: CODE_ACTIVE_TASKS,
          activeTasks,
        },
      };
    }

    const previousTo =
      current.effectiveFrom && current.effectiveFrom >= effectiveFrom
        ? effectiveFrom
        : addDaysToKey(effectiveFrom, -1);
    const prevHistKey = {
      PK: userPk(target),
      SK: current.histSk || histSk(current.effectiveFrom, current.assignedAt),
    };
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: prevHistKey,
          UpdateExpression: "SET effectiveTo = :to, updatedAt = :now",
          ExpressionAttributeValues: { ":to": previousTo, ":now": now },
          ConditionExpression: "attribute_exists(PK)",
        })
      );
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }
  }

  const snapshot = assignmentSnapshot(shift, {
    email: target,
    effectiveFrom,
    effectiveTo: null,
    assignedAt: now,
    assignedBy: auth.email,
  });
  const history = {
    ...snapshot,
    PK: userPk(target),
    SK: histSk(effectiveFrom, now),
    updatedAt: now,
  };
  const nextCurrent = {
    ...snapshot,
    PK: userPk(target),
    SK: currentSk(),
    histSk: history.SK,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: history }));
  await ddb.send(new PutCommand({ TableName: tableName, Item: nextCurrent }));
  return { statusCode: 200, body: { shift: publicAssignment(nextCurrent) } };
}

module.exports = {
  SHIFT_ENTITY_PK,
  SEED_SHIFTS,
  CODE_ACTIVE_TASKS,
  listShiftsPathMatch,
  shiftIdPathMatch,
  employeeShiftPathMatch,
  crossesMidnightFromTimes,
  publicShift,
  publicAssignment,
  parseShiftFields,
  isPendingScheduledTask,
  pendingIncludesEmail,
  unresolvedShiftConflictStatus,
  seedShiftsIfMissing,
  findActiveAssignments,
  handleListShifts,
  handleCreateShift,
  handleUpdateShift,
  handleGetEmployeeShift,
  handleAssignEmployeeShift,
};

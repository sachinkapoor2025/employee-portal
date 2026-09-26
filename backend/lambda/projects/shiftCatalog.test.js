process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const { GetCommand, PutCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const {
  SEED_SHIFTS,
  CODE_ACTIVE_TASKS,
  SHIFT_ENTITY_PK,
  crossesMidnightFromTimes,
  parseShiftFields,
  publicShift,
  publicAssignment,
  isPendingScheduledTask,
  seedShiftsIfMissing,
  findActiveAssignments,
  handleListShifts,
  handleCreateShift,
  handleUpdateShift,
  handleGetEmployeeShift,
  handleAssignEmployeeShift,
  listShiftsPathMatch,
  shiftIdPathMatch,
  employeeShiftPathMatch,
} = require("./shiftCatalog");

function keyOf(pk, sk) {
  return `${pk}\0${sk}`;
}

function memoryDdb(seed = {}) {
  const items = { ...seed };
  const ddb = {
    items,
    async send(command) {
      if (command instanceof GetCommand) {
        const k = keyOf(command.input.Key.PK, command.input.Key.SK);
        const found = items[k];
        return found ? { Item: { ...found } } : {};
      }
      if (command instanceof PutCommand) {
        const item = command.input.Item;
        const k = keyOf(item.PK, item.SK);
        const cond = command.input.ConditionExpression || "";
        if (cond.includes("attribute_not_exists(PK)") && items[k]) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        items[k] = { ...item };
        return {};
      }
      if (command instanceof UpdateCommand) {
        const k = keyOf(command.input.Key.PK, command.input.Key.SK);
        if (!items[k]) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        const values = command.input.ExpressionAttributeValues || {};
        items[k] = {
          ...items[k],
          effectiveTo: values[":to"] !== undefined ? values[":to"] : items[k].effectiveTo,
          updatedAt: values[":now"] || items[k].updatedAt,
        };
        return { Attributes: { ...items[k] } };
      }
      if (command instanceof QueryCommand) {
        const pk = command.input.ExpressionAttributeValues[":pk"];
        const skPrefix = command.input.ExpressionAttributeValues[":sk"];
        const found = Object.values(items).filter((item) => {
          if (item.PK !== pk) return false;
          if (!skPrefix) return true;
          return String(item.SK || "").startsWith(skPrefix);
        });
        return { Items: found.map((item) => ({ ...item })) };
      }
      throw new Error(`unexpected ${command?.constructor?.name}`);
    },
  };
  return ddb;
}

const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };
const EMPLOYEE = { email: "rahul@mydgv.com", groups: ["Employee"], isAdmin: false };
const TABLE = "WorkTasks";
const ACCESS = "UserAccess";
const NOW = "2026-09-23T08:00:00.000Z";

function accessDdb() {
  const ddb = memoryDdb({
    [keyOf("admin@mydgv.com", "admin@mydgv.com")]: {
      PK: "admin@mydgv.com",
      SK: "admin@mydgv.com",
      email: "admin@mydgv.com",
      role: "ADMIN",
      status: "ACTIVE",
    },
    [keyOf("rahul@mydgv.com", "rahul@mydgv.com")]: {
      PK: "rahul@mydgv.com",
      SK: "rahul@mydgv.com",
      email: "rahul@mydgv.com",
      role: "EMPLOYEE",
      status: "ACTIVE",
    },
    [keyOf("manager@mydgv.com", "manager@mydgv.com")]: {
      PK: "manager@mydgv.com",
      SK: "manager@mydgv.com",
      email: "manager@mydgv.com",
      role: "MANAGER",
      status: "ACTIVE",
    },
  });
  return ddb;
}

assert.strictEqual(crossesMidnightFromTimes("11:00", "20:00"), false);
assert.strictEqual(crossesMidnightFromTimes("22:00", "06:00"), true);
assert.strictEqual(listShiftsPathMatch("/prod/shifts"), true);
assert.strictEqual(shiftIdPathMatch("/prod/shifts/morning"), "morning");
assert.strictEqual(
  employeeShiftPathMatch("/prod/employees/Rahul%40mydgv.com/shift"),
  "rahul@mydgv.com"
);
assert.strictEqual(isPendingScheduledTask({ assignmentMode: "SCHEDULED", assignmentState: "PENDING" }), true);
assert.strictEqual(isPendingScheduledTask({ assignmentMode: "IMMEDIATE", assignmentState: "ASSIGNED" }), false);

const overnight = parseShiftFields({
  name: "Night",
  startTime: "22:00",
  endTime: "06:00",
  graceMinutes: 10,
});
assert.strictEqual(overnight.ok, true);
assert.strictEqual(overnight.values.halfDayEnabled, false);
assert.strictEqual(overnight.values.firstHalf, null);
assert.strictEqual(overnight.values.secondHalf, null);

const oldShift = parseShiftFields({
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 0,
});
assert.strictEqual(oldShift.ok, true);
assert.strictEqual(oldShift.values.halfDayEnabled, false);

const publicOld = publicShift({
  shiftId: "morning",
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 0,
  crossesMidnight: false,
  status: "ACTIVE",
});
assert.strictEqual(publicOld.halfDayEnabled, false);
assert.strictEqual(publicOld.firstHalf, null);
assert.strictEqual(publicOld.secondHalf, null);

const enabledHalves = parseShiftFields({
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 15,
  halfDayEnabled: true,
  firstHalf: { startTime: "11:00", endTime: "15:30", graceMinutes: 10 },
  secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 5 },
});
assert.strictEqual(enabledHalves.ok, true);
assert.strictEqual(enabledHalves.values.halfDayEnabled, true);
assert.deepStrictEqual(enabledHalves.values.firstHalf, {
  startTime: "11:00",
  endTime: "15:30",
  graceMinutes: 10,
});
assert.deepStrictEqual(enabledHalves.values.secondHalf, {
  startTime: "15:30",
  endTime: "20:00",
  graceMinutes: 5,
});

const missingHalves = parseShiftFields({
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 0,
  halfDayEnabled: true,
});
assert.strictEqual(missingHalves.ok, false);

const invalidHalfTime = parseShiftFields({
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 0,
  halfDayEnabled: true,
  firstHalf: { startTime: "25:00", endTime: "15:30", graceMinutes: 0 },
  secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 0 },
});
assert.strictEqual(invalidHalfTime.ok, false);

const invalidHalfGrace = parseShiftFields({
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 0,
  halfDayEnabled: true,
  firstHalf: { startTime: "11:00", endTime: "15:30", graceMinutes: 2000 },
  secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 0 },
});
assert.strictEqual(invalidHalfGrace.ok, false);

const disabledStripsHalves = parseShiftFields({
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 0,
  halfDayEnabled: false,
  firstHalf: { startTime: "11:00", endTime: "15:30", graceMinutes: 10 },
  secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 5 },
});
assert.strictEqual(disabledStripsHalves.ok, true);
assert.strictEqual(disabledStripsHalves.values.halfDayEnabled, false);
assert.strictEqual(disabledStripsHalves.values.firstHalf, null);
assert.strictEqual(disabledStripsHalves.values.secondHalf, null);

const halfOutsideFull = parseShiftFields({
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 0,
  halfDayEnabled: true,
  firstHalf: { startTime: "08:00", endTime: "12:00", graceMinutes: 0 },
  secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 0 },
});
assert.strictEqual(halfOutsideFull.ok, false);

const halfCrossesOnDayShift = parseShiftFields({
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 0,
  halfDayEnabled: true,
  firstHalf: { startTime: "18:00", endTime: "02:00", graceMinutes: 0 },
  secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 0 },
});
assert.strictEqual(halfCrossesOnDayShift.ok, false);

const overnightHalves = parseShiftFields({
  name: "Night Desk",
  startTime: "22:00",
  endTime: "06:00",
  graceMinutes: 0,
  halfDayEnabled: true,
  firstHalf: { startTime: "22:00", endTime: "02:00", graceMinutes: 10 },
  secondHalf: { startTime: "02:00", endTime: "06:00", graceMinutes: 5 },
});
assert.strictEqual(overnightHalves.ok, true);

const overnightHalfOutside = parseShiftFields({
  name: "Night Desk",
  startTime: "22:00",
  endTime: "06:00",
  graceMinutes: 0,
  halfDayEnabled: true,
  firstHalf: { startTime: "21:00", endTime: "23:00", graceMinutes: 0 },
  secondHalf: { startTime: "02:00", endTime: "06:00", graceMinutes: 0 },
});
assert.strictEqual(overnightHalfOutside.ok, false);

(async () => {
  const ddb = memoryDdb();
  Object.assign(ddb.items, accessDdb().items);

  await seedShiftsIfMissing({ ddb, tableName: TABLE, nowIso: NOW, actor: ADMIN.email });
  const listed = await handleListShifts({
    user: ADMIN,
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
  });
  assert.strictEqual(listed.statusCode, 200);
  assert.strictEqual(listed.body.shifts.length, 3);
  const morning = listed.body.shifts.find((s) => s.shiftId === "morning");
  assert.strictEqual(morning.startTime, "11:00");
  assert.strictEqual(morning.endTime, "20:00");
  assert.strictEqual(morning.crossesMidnight, false);
  assert.strictEqual(morning.halfDayEnabled, false);
  assert.strictEqual(morning.firstHalf, null);
  assert.strictEqual(morning.secondHalf, null);

  ddb.items[keyOf(SHIFT_ENTITY_PK, "SHIFT#morning")].startTime = "10:00";
  await seedShiftsIfMissing({ ddb, tableName: TABLE, nowIso: NOW, actor: ADMIN.email });
  assert.strictEqual(ddb.items[keyOf(SHIFT_ENTITY_PK, "SHIFT#morning")].startTime, "10:00");

  const created = await handleCreateShift({
    user: ADMIN,
    body: { name: "Night Desk", startTime: "22:00", endTime: "06:00", graceMinutes: 5 },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
  });
  assert.strictEqual(created.statusCode, 201);
  assert.strictEqual(created.body.shift.crossesMidnight, true);
  assert.strictEqual(created.body.shift.startTime, "22:00");
  assert.strictEqual(created.body.shift.endTime, "06:00");
  assert.strictEqual(created.body.shift.halfDayEnabled, false);
  assert.strictEqual(created.body.shift.firstHalf, null);

  const managerDenied = await handleCreateShift({
    user: { email: "manager@mydgv.com", groups: ["Admin"], isAdmin: true },
    body: { name: "X", startTime: "11:00", endTime: "20:00", graceMinutes: 0 },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
  });
  assert.strictEqual(managerDenied.statusCode, 403);

  const deactivated = await handleUpdateShift({
    user: ADMIN,
    shiftId: created.body.shift.shiftId,
    body: { status: "INACTIVE" },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
  });
  assert.strictEqual(deactivated.body.shift.status, "INACTIVE");

  const inactiveAssign = await handleAssignEmployeeShift({
    user: ADMIN,
    email: "rahul@mydgv.com",
    body: { shiftId: created.body.shift.shiftId },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
    nowMs: Date.parse(NOW),
  });
  assert.strictEqual(inactiveAssign.statusCode, 400);

  const assigned = await handleAssignEmployeeShift({
    user: ADMIN,
    email: "rahul@mydgv.com",
    body: { shiftId: "morning", effectiveFrom: "2026-09-22" },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
    nowMs: Date.parse(NOW),
  });
  assert.strictEqual(assigned.statusCode, 200);
  assert.strictEqual(assigned.body.shift.shiftId, "morning");
  assert.strictEqual(assigned.body.shift.effectiveFrom, "2026-09-22");
  assert.strictEqual(assigned.body.shift.startTime, "10:00");

  const selfRead = await handleGetEmployeeShift({
    user: EMPLOYEE,
    email: "rahul@mydgv.com",
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
  });
  assert.strictEqual(selfRead.statusCode, 200);
  assert.strictEqual(selfRead.body.shift.shiftId, "morning");

  const otherDenied = await handleGetEmployeeShift({
    user: EMPLOYEE,
    email: "admin@mydgv.com",
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
  });
  assert.strictEqual(otherDenied.statusCode, 403);

  const employeeWrite = await handleAssignEmployeeShift({
    user: EMPLOYEE,
    email: "rahul@mydgv.com",
    body: { shiftId: "afternoon" },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
    nowMs: Date.parse(NOW),
  });
  assert.strictEqual(employeeWrite.statusCode, 403);

  ddb.items[keyOf("ENTITY#TASK", "TASK#open-1")] = {
    PK: "ENTITY#TASK",
    SK: "TASK#open-1",
    taskId: "open-1",
    title: "Open work",
    archived: false,
  };
  ddb.items[keyOf("TASK#open-1", "ASSIGNMENT#rahul@mydgv.com")] = {
    PK: "TASK#open-1",
    SK: "ASSIGNMENT#rahul@mydgv.com",
    email: "rahul@mydgv.com",
    status: "TODO",
    removed: false,
  };
  const blocked = await handleAssignEmployeeShift({
    user: ADMIN,
    email: "rahul@mydgv.com",
    body: { shiftId: "afternoon", effectiveFrom: "2026-09-23" },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: "2026-09-23T08:00:00.000Z",
    nowMs: Date.parse("2026-09-23T08:00:00.000Z"),
  });
  assert.strictEqual(blocked.statusCode, 409);
  assert.strictEqual(blocked.body.code, CODE_ACTIVE_TASKS);
  assert.strictEqual(blocked.body.activeTasks[0].taskId, "open-1");
  assert.strictEqual(
    ddb.items[keyOf("USER#rahul@mydgv.com", "SHIFT#CURRENT")].shiftId,
    "morning"
  );

  ddb.items[keyOf("TASK#open-1", "ASSIGNMENT#rahul@mydgv.com")].status = "DONE";
  ddb.items[keyOf("ENTITY#TASK", "TASK#pending-1")] = {
    PK: "ENTITY#TASK",
    SK: "TASK#pending-1",
    taskId: "pending-1",
    title: "Hidden scheduled",
    assignmentMode: "SCHEDULED",
    assignmentState: "PENDING",
    pendingAssignees: ["rahul@mydgv.com"],
  };
  ddb.items[keyOf("ENTITY#TASK", "TASK#cancelled-1")] = {
    PK: "ENTITY#TASK",
    SK: "TASK#cancelled-1",
    taskId: "cancelled-1",
    title: "Cancelled",
  };
  ddb.items[keyOf("TASK#cancelled-1", "ASSIGNMENT#rahul@mydgv.com")] = {
    email: "rahul@mydgv.com",
    status: "CANCELLED",
    removed: false,
  };
  ddb.items[keyOf("ENTITY#TASK", "TASK#removed-1")] = {
    PK: "ENTITY#TASK",
    SK: "TASK#removed-1",
    taskId: "removed-1",
    title: "Removed",
  };
  ddb.items[keyOf("TASK#removed-1", "ASSIGNMENT#rahul@mydgv.com")] = {
    email: "rahul@mydgv.com",
    status: "TODO",
    removed: true,
  };

  const active = await findActiveAssignments(ddb, TABLE, "rahul@mydgv.com");
  assert.deepStrictEqual(active, []);

  const changed = await handleAssignEmployeeShift({
    user: ADMIN,
    email: "rahul@mydgv.com",
    body: { shiftId: "afternoon", effectiveFrom: "2026-09-23" },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: "2026-09-23T08:00:00.000Z",
    nowMs: Date.parse("2026-09-23T08:00:00.000Z"),
  });
  assert.strictEqual(changed.statusCode, 200);
  assert.strictEqual(changed.body.shift.shiftId, "afternoon");
  const histRows = Object.values(ddb.items).filter((item) =>
    String(item.SK || "").startsWith("SHIFT#HIST#")
  );
  assert.ok(histRows.length >= 2);
  const closedMorning = histRows.find((row) => row.shiftId === "morning");
  assert.ok(closedMorning.effectiveTo);

  function currentShift() {
    return ddb.items[keyOf("USER#rahul@mydgv.com", "SHIFT#CURRENT")];
  }
  function histCount() {
    return Object.values(ddb.items).filter((item) =>
      String(item.SK || "").startsWith("SHIFT#HIST#")
    ).length;
  }
  function seedEntityTask(task) {
    ddb.items[keyOf("ENTITY#TASK", `TASK#${task.taskId}`)] = {
      PK: "ENTITY#TASK",
      SK: `TASK#${task.taskId}`,
      archived: false,
      ...task,
    };
    return ddb.items[keyOf("ENTITY#TASK", `TASK#${task.taskId}`)];
  }
  function seedAssignment(taskId, extra = {}) {
    ddb.items[keyOf(`TASK#${taskId}`, "ASSIGNMENT#rahul@mydgv.com")] = {
      PK: `TASK#${taskId}`,
      SK: "ASSIGNMENT#rahul@mydgv.com",
      email: "rahul@mydgv.com",
      status: "TODO",
      removed: false,
      ...extra,
    };
  }
  async function assignAfternoon() {
    return handleAssignEmployeeShift({
      user: ADMIN,
      email: "rahul@mydgv.com",
      body: { shiftId: "afternoon", effectiveFrom: "2026-09-24" },
      ddb,
      tableName: TABLE,
      accessTable: ACCESS,
      nowIso: "2026-09-24T08:00:00.000Z",
      nowMs: Date.parse("2026-09-24T08:00:00.000Z"),
    });
  }

  const overnightShift = await handleCreateShift({
    user: ADMIN,
    body: { name: "Night Watch", startTime: "22:00", endTime: "06:00", graceMinutes: 0 },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: "2026-09-24T08:00:00.000Z",
  });
  assert.strictEqual(overnightShift.statusCode, 201);
  const toOvernight = await handleAssignEmployeeShift({
    user: ADMIN,
    email: "rahul@mydgv.com",
    body: { shiftId: overnightShift.body.shift.shiftId, effectiveFrom: "2026-09-24" },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: "2026-09-24T08:00:00.000Z",
    nowMs: Date.parse("2026-09-24T08:00:00.000Z"),
  });
  assert.strictEqual(toOvernight.statusCode, 200);
  assert.strictEqual(toOvernight.body.shift.crossesMidnight, true);
  const overnightToNormal = await handleAssignEmployeeShift({
    user: ADMIN,
    email: "rahul@mydgv.com",
    body: { shiftId: "morning", effectiveFrom: "2026-09-25" },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: "2026-09-25T08:00:00.000Z",
    nowMs: Date.parse("2026-09-25T08:00:00.000Z"),
  });
  assert.strictEqual(overnightToNormal.statusCode, 200);
  assert.strictEqual(overnightToNormal.body.shift.shiftId, "morning");
  assert.strictEqual(overnightToNormal.body.shift.crossesMidnight, false);

  for (const status of ["REVIEW", "BACKLOG", "IN_PROGRESS"]) {
    seedAssignment("open-status-1", { status });
    seedEntityTask({
      taskId: "open-status-1",
      title: `${status} work`,
    });
    const before = { ...currentShift() };
    const blockedOpen = await assignAfternoon();
    assert.strictEqual(blockedOpen.statusCode, 409, status);
    assert.strictEqual(blockedOpen.body.code, CODE_ACTIVE_TASKS, status);
    assert.strictEqual(blockedOpen.body.activeTasks[0].taskId, "open-status-1", status);
    assert.strictEqual(blockedOpen.body.activeTasks[0].status, status);
    assert.strictEqual(currentShift().shiftId, before.shiftId, status);
    assert.strictEqual(currentShift().histSk, before.histSk, status);
  }
  seedAssignment("open-status-1", { status: "DONE" });

  const conflictTask = seedEntityTask({
    taskId: "conflict-1",
    title: "Conflict scheduled",
    assignmentMode: "SCHEDULED",
    assignmentState: "PENDING",
    pendingAssignees: ["rahul@mydgv.com"],
    lastShiftFitByEmail: { "rahul@mydgv.com": "SHIFT_CONFLICT" },
    startDate: "2026-09-22T18:00:00+05:30",
    dueDate: "2026-09-22T21:00:00+05:30",
  });
  const beforeConflict = {
    current: { ...currentShift() },
    hist: histCount(),
    task: { ...conflictTask },
  };
  const conflictBlocked = await assignAfternoon();
  assert.strictEqual(conflictBlocked.statusCode, 409);
  assert.strictEqual(conflictBlocked.body.code, CODE_ACTIVE_TASKS);
  assert.strictEqual(conflictBlocked.body.activeTasks[0].taskId, "conflict-1");
  assert.strictEqual(conflictBlocked.body.activeTasks[0].status, "SHIFT_CONFLICT");
  assert.deepStrictEqual(currentShift(), beforeConflict.current);
  assert.strictEqual(histCount(), beforeConflict.hist);
  assert.deepStrictEqual(
    ddb.items[keyOf("ENTITY#TASK", "TASK#conflict-1")],
    beforeConflict.task
  );

  conflictTask.lastShiftFitByEmail = { "rahul@mydgv.com": "NO_SHIFT" };
  const noShiftBlocked = await assignAfternoon();
  assert.strictEqual(noShiftBlocked.statusCode, 409);
  assert.strictEqual(noShiftBlocked.body.activeTasks[0].status, "NO_SHIFT");
  assert.strictEqual(currentShift().shiftId, beforeConflict.current.shiftId);

  conflictTask.archived = true;
  const archivedIgnored = await assignAfternoon();
  assert.strictEqual(archivedIgnored.statusCode, 200);
  assert.strictEqual(archivedIgnored.body.shift.shiftId, "afternoon");

  const futurePending = seedEntityTask({
    taskId: "future-pending-1",
    title: "Future scheduled",
    assignmentMode: "SCHEDULED",
    assignmentState: "PENDING",
    pendingAssignees: ["rahul@mydgv.com"],
  });
  const beforeFuture = {
    current: { ...currentShift() },
    task: { ...futurePending },
  };
  const futureAllowed = await handleAssignEmployeeShift({
    user: ADMIN,
    email: "rahul@mydgv.com",
    body: { shiftId: "morning", effectiveFrom: "2026-09-26" },
    ddb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: "2026-09-26T08:00:00.000Z",
    nowMs: Date.parse("2026-09-26T08:00:00.000Z"),
  });
  assert.strictEqual(futureAllowed.statusCode, 200);
  assert.strictEqual(futureAllowed.body.shift.shiftId, "morning");
  assert.notStrictEqual(currentShift().histSk, beforeFuture.current.histSk);
  assert.deepStrictEqual(
    ddb.items[keyOf("ENTITY#TASK", "TASK#future-pending-1")],
    beforeFuture.task
  );

  const halfDdb = memoryDdb();
  Object.assign(halfDdb.items, accessDdb().items);
  halfDdb.items[keyOf("neha@mydgv.com", "neha@mydgv.com")] = {
    PK: "neha@mydgv.com",
    SK: "neha@mydgv.com",
    email: "neha@mydgv.com",
    role: "EMPLOYEE",
    status: "ACTIVE",
  };
  const halfCreateMissing = await handleCreateShift({
    user: ADMIN,
    body: {
      name: "Split Desk",
      startTime: "11:00",
      endTime: "20:00",
      graceMinutes: 15,
      halfDayEnabled: true,
    },
    ddb: halfDdb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
  });
  assert.strictEqual(halfCreateMissing.statusCode, 400);

  const halfCreateInvalidTime = await handleCreateShift({
    user: ADMIN,
    body: {
      name: "Split Desk",
      startTime: "11:00",
      endTime: "20:00",
      graceMinutes: 15,
      halfDayEnabled: true,
      firstHalf: { startTime: "11:00", endTime: "99:00", graceMinutes: 0 },
      secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 0 },
    },
    ddb: halfDdb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
  });
  assert.strictEqual(halfCreateInvalidTime.statusCode, 400);

  const halfCreateInvalidGrace = await handleCreateShift({
    user: ADMIN,
    body: {
      name: "Split Desk",
      startTime: "11:00",
      endTime: "20:00",
      graceMinutes: 15,
      halfDayEnabled: true,
      firstHalf: { startTime: "11:00", endTime: "15:30", graceMinutes: -1 },
      secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 0 },
    },
    ddb: halfDdb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
  });
  assert.strictEqual(halfCreateInvalidGrace.statusCode, 400);

  const halfCreateDisabled = await handleCreateShift({
    user: ADMIN,
    body: {
      name: "Plain Desk",
      startTime: "11:00",
      endTime: "20:00",
      graceMinutes: 0,
      halfDayEnabled: false,
      firstHalf: { startTime: "11:00", endTime: "15:30", graceMinutes: 10 },
      secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 5 },
    },
    ddb: halfDdb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
  });
  assert.strictEqual(halfCreateDisabled.statusCode, 201);
  assert.strictEqual(halfCreateDisabled.body.shift.halfDayEnabled, false);
  assert.strictEqual(halfCreateDisabled.body.shift.firstHalf, null);
  assert.strictEqual(halfCreateDisabled.body.shift.secondHalf, null);
  const plainStored =
    halfDdb.items[keyOf(SHIFT_ENTITY_PK, `SHIFT#${halfCreateDisabled.body.shift.shiftId}`)];
  assert.strictEqual(plainStored.halfDayEnabled, false);
  assert.strictEqual(plainStored.firstHalf, undefined);
  assert.strictEqual(plainStored.secondHalf, undefined);

  const splitCreate = await handleCreateShift({
    user: ADMIN,
    body: {
      name: "Split Morning",
      startTime: "11:00",
      endTime: "20:00",
      graceMinutes: 15,
      halfDayEnabled: true,
      firstHalf: { startTime: "11:00", endTime: "15:30", graceMinutes: 10 },
      secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 5 },
    },
    ddb: halfDdb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
  });
  assert.strictEqual(splitCreate.statusCode, 201);
  assert.strictEqual(splitCreate.body.shift.halfDayEnabled, true);
  assert.deepStrictEqual(splitCreate.body.shift.firstHalf, {
    startTime: "11:00",
    endTime: "15:30",
    graceMinutes: 10,
  });
  assert.deepStrictEqual(splitCreate.body.shift.secondHalf, {
    startTime: "15:30",
    endTime: "20:00",
    graceMinutes: 5,
  });
  const splitId = splitCreate.body.shift.shiftId;

  const overnightHalfCreate = await handleCreateShift({
    user: ADMIN,
    body: {
      name: "Overnight Split",
      startTime: "22:00",
      endTime: "06:00",
      graceMinutes: 0,
      halfDayEnabled: true,
      firstHalf: { startTime: "22:00", endTime: "02:00", graceMinutes: 10 },
      secondHalf: { startTime: "02:00", endTime: "06:00", graceMinutes: 5 },
    },
    ddb: halfDdb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
  });
  assert.strictEqual(overnightHalfCreate.statusCode, 201);
  assert.strictEqual(overnightHalfCreate.body.shift.crossesMidnight, true);
  assert.strictEqual(overnightHalfCreate.body.shift.halfDayEnabled, true);
  assert.strictEqual(overnightHalfCreate.body.shift.firstHalf.endTime, "02:00");
  assert.strictEqual(overnightHalfCreate.body.shift.secondHalf.startTime, "02:00");

  const assignedHalf = await handleAssignEmployeeShift({
    user: ADMIN,
    email: "neha@mydgv.com",
    body: { shiftId: splitId, effectiveFrom: "2026-09-22" },
    ddb: halfDdb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: NOW,
    nowMs: Date.parse(NOW),
  });
  assert.strictEqual(assignedHalf.statusCode, 200);
  assert.strictEqual(assignedHalf.body.shift.halfDayEnabled, true);
  assert.deepStrictEqual(assignedHalf.body.shift.firstHalf, {
    startTime: "11:00",
    endTime: "15:30",
    graceMinutes: 10,
  });
  assert.deepStrictEqual(assignedHalf.body.shift.secondHalf, {
    startTime: "15:30",
    endTime: "20:00",
    graceMinutes: 5,
  });
  const currentHalf = halfDdb.items[keyOf("USER#neha@mydgv.com", "SHIFT#CURRENT")];
  assert.strictEqual(currentHalf.halfDayEnabled, true);
  assert.deepStrictEqual(currentHalf.firstHalf, {
    startTime: "11:00",
    endTime: "15:30",
    graceMinutes: 10,
  });
  const histHalf = Object.values(halfDdb.items).find(
    (item) =>
      item.PK === "USER#neha@mydgv.com" &&
      String(item.SK || "").startsWith("SHIFT#HIST#")
  );
  assert.ok(histHalf);
  assert.strictEqual(histHalf.halfDayEnabled, true);
  assert.deepStrictEqual(histHalf.firstHalf, currentHalf.firstHalf);
  assert.deepStrictEqual(histHalf.secondHalf, currentHalf.secondHalf);
  assert.deepStrictEqual(publicAssignment(histHalf).firstHalf, currentHalf.firstHalf);

  const catalogChanged = await handleUpdateShift({
    user: ADMIN,
    shiftId: splitId,
    body: {
      firstHalf: { startTime: "11:00", endTime: "14:00", graceMinutes: 10 },
    },
    ddb: halfDdb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: "2026-09-23T09:00:00.000Z",
  });
  assert.strictEqual(catalogChanged.statusCode, 200);
  assert.strictEqual(catalogChanged.body.shift.firstHalf.endTime, "14:00");
  const storedCatalog = halfDdb.items[keyOf(SHIFT_ENTITY_PK, `SHIFT#${splitId}`)];
  assert.strictEqual(storedCatalog.firstHalf.endTime, "14:00");
  const currentAfterCatalogChange =
    halfDdb.items[keyOf("USER#neha@mydgv.com", "SHIFT#CURRENT")];
  assert.strictEqual(currentAfterCatalogChange.firstHalf.endTime, "15:30");
  const readAfterCatalogChange = await handleGetEmployeeShift({
    user: { email: "neha@mydgv.com", groups: ["Employee"], isAdmin: false },
    email: "neha@mydgv.com",
    ddb: halfDdb,
    tableName: TABLE,
    accessTable: ACCESS,
  });
  assert.strictEqual(readAfterCatalogChange.statusCode, 200);
  assert.strictEqual(readAfterCatalogChange.body.shift.firstHalf.endTime, "15:30");
  assert.strictEqual(readAfterCatalogChange.body.shift.halfDayEnabled, true);

  const disableHalves = await handleUpdateShift({
    user: ADMIN,
    shiftId: splitId,
    body: { halfDayEnabled: false },
    ddb: halfDdb,
    tableName: TABLE,
    accessTable: ACCESS,
    nowIso: "2026-09-23T09:30:00.000Z",
  });
  assert.strictEqual(disableHalves.statusCode, 200);
  assert.strictEqual(disableHalves.body.shift.halfDayEnabled, false);
  assert.strictEqual(disableHalves.body.shift.firstHalf, null);
  const storedDisabled = halfDdb.items[keyOf(SHIFT_ENTITY_PK, `SHIFT#${splitId}`)];
  assert.strictEqual(storedDisabled.firstHalf, undefined);
  assert.strictEqual(
    halfDdb.items[keyOf("USER#neha@mydgv.com", "SHIFT#CURRENT")].firstHalf.endTime,
    "15:30"
  );

  console.log("shiftCatalog tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

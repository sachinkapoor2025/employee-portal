process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.AWS_REGION = "ap-south-1";
process.env.WORK_TABLE = "work-table";
process.env.ATTENDANCE_TABLE = "attendance-table";
process.env.USER_PROFILE_TABLE = "profile-table";
process.env.ACTIVITY_TABLE = "activity-table";

const assert = require("assert");
const { GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { companyDateKey } = require("../common/shiftWindows");
const { handler, setClientsForTests } = require("./handler");
const {
  ACTIVITY_PER_TASK,
  handleGetMyActivity,
} = require("./myActivity");

const WORK = process.env.WORK_TABLE;
const ATTENDANCE = process.env.ATTENDANCE_TABLE;
const PROFILE = process.env.USER_PROFILE_TABLE;
const ACTIVITY = process.env.ACTIVITY_TABLE;

const CALLER = "priya@mydgv.com";
const LEAD = "rahul@mydgv.com";
const ADMIN = "admin@mydgv.com";
const NOW_MS = Date.parse("2026-09-25T12:22:00+05:30");
const TODAY = companyDateKey(NOW_MS);
const YESTERDAY = "2026-09-24";
const PROJECT_ID = "proj-me-1";

assert.strictEqual(TODAY, "2026-09-25");

function createMemoryDdb() {
  const items = [];
  function keyOf(tableName, item) {
    return `${tableName}|${item.PK}|${item.SK}`;
  }
  return {
    items,
    seed(tableName, item) {
      const idx = items.findIndex(
        (row) => keyOf(row.TableName, row.Item) === keyOf(tableName, item)
      );
      const entry = { TableName: tableName, Item: { ...item } };
      if (idx >= 0) items[idx] = entry;
      else items.push(entry);
    },
    async send(command) {
      if (command instanceof GetCommand) {
        const { TableName, Key } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        return { Item: found ? { ...found.Item } : undefined };
      }
      if (command instanceof QueryCommand) {
        const { TableName, ExpressionAttributeValues = {} } = command.input;
        const pk = ExpressionAttributeValues[":pk"];
        const skPrefix = ExpressionAttributeValues[":sk"];
        const found = items
          .filter((row) => row.TableName === TableName && row.Item.PK === pk)
          .filter((row) =>
            skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true
          )
          .map((row) => ({ ...row.Item }));
        return { Items: found };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function seedProfile(ddb, email, extra = {}) {
  ddb.seed(PROFILE, {
    PK: `USER#${email}`,
    SK: "PROFILE",
    email,
    name: extra.name || "Priya",
    empId: extra.empId || "DGV-101",
    department: extra.department || "Engineering",
  });
}

function seedShift(ddb, email, extra = {}) {
  ddb.seed(WORK, {
    PK: `USER#${email}`,
    SK: "SHIFT#CURRENT",
    shiftId: extra.shiftId || "morning",
    name: extra.name || "Morning Shift",
    startTime: extra.startTime || "11:00",
    endTime: extra.endTime || "20:00",
    graceMinutes: extra.graceMinutes ?? 15,
    crossesMidnight: extra.crossesMidnight === true,
  });
}

function seedAttendance(ddb, email, date, extra = {}) {
  ddb.seed(ATTENDANCE, {
    PK: email,
    SK: date,
    email,
    date,
    status: extra.status || "Working",
    workPeriod: extra.workPeriod || "FULL_DAY",
    shiftId: extra.shiftId || "morning",
    shiftName: extra.shiftName || "Morning Shift",
    startTime: extra.startTime || "11:00",
    endTime: extra.endTime || "20:00",
    expectedStartTime: extra.expectedStartTime || "2026-09-25T11:00:00+05:30",
    expectedEndTime: extra.expectedEndTime || "2026-09-25T20:00:00+05:30",
    actualCheckInTime: extra.actualCheckInTime || "2026-09-25T11:04:00+05:30",
    actualCheckOutTime: extra.actualCheckOutTime || null,
    timingStatus: extra.timingStatus || "WITHIN_GRACE",
    lateMinutes: extra.lateMinutes ?? 0,
    graceMinutes: extra.graceMinutes ?? 15,
    crossesMidnight: extra.crossesMidnight === true,
    workedBeyondShift: extra.workedBeyondShift === true,
    workedBeyondReason: extra.workedBeyondReason || null,
    ...extra,
  });
}

function seedEntityTask(ddb, extra = {}) {
  const taskId = extra.taskId || "task-open";
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
    taskId,
    projectId: extra.projectId || PROJECT_ID,
    title: extra.title || "Open work",
    status: extra.status || "TODO",
    assignee: extra.assignee || CALLER,
    assignees: extra.assignees || [extra.assignee || CALLER],
    assignmentMode: extra.assignmentMode || "IMMEDIATE",
    assignmentState: extra.assignmentState || "ASSIGNED",
    startDate: extra.startDate || "2026-09-25T11:00:00+05:30",
    dueDate: extra.dueDate || "2026-09-25T20:00:00+05:30",
    archived: extra.archived === true,
    pendingAssignees: extra.pendingAssignees || [],
  };
  ddb.seed(WORK, item);
  return item;
}

function seedAssignment(ddb, taskId, email, extra = {}) {
  ddb.seed(WORK, {
    PK: `TASK#${taskId}`,
    SK: `ASSIGNMENT#${email}`,
    type: "ASSIGNMENT",
    taskId,
    email,
    status: extra.status || "TODO",
    assignedAt: extra.assignedAt || "2026-09-25T10:00:00+05:30",
    assignedBy: ADMIN,
    completedAt: extra.completedAt || null,
    completedDate: extra.completedDate || null,
    removed: extra.removed === true,
  });
}

function seedTaskActivity(ddb, taskId, timestamp, extra = {}) {
  const id = extra.id || timestamp;
  ddb.seed(WORK, {
    PK: `TASK#${taskId}`,
    SK: `ACTIVITY#${timestamp}#${id}`,
    taskId,
    action: extra.action || "updated",
    detail: extra.detail || "Changed",
    actorEmail: extra.actorEmail || CALLER,
    timestamp,
  });
}

function seedPresenceEvent(ddb, email, date, timestamp, extra = {}) {
  const id = extra.id || timestamp;
  ddb.seed(ACTIVITY, {
    PK: `USER#${email}`,
    SK: `EVENT#${timestamp}#${id}`,
    email,
    type: extra.type || "heartbeat",
    timestamp,
    date,
    page: extra.page || "/attendance",
    device: extra.device || "desktop",
    sessionMinutes: extra.sessionMinutes ?? 5,
  });
}

function seedPresenceSummary(ddb, email, date, extra = {}) {
  ddb.seed(ACTIVITY, {
    PK: `SUMMARY#${email}`,
    SK: `DAY#${date}`,
    email,
    date,
    lastSeen: extra.lastSeen || "2026-09-25T12:00:00+05:30",
    eventCount: extra.eventCount ?? 2,
    totalMinutes: extra.totalMinutes ?? 480,
  });
}

function baseSeed() {
  const ddb = createMemoryDdb();
  seedProfile(ddb, CALLER);
  seedShift(ddb, CALLER);
  return ddb;
}

async function getMine(ddb, query = {}, user = { email: CALLER }) {
  return handleGetMyActivity({
    user,
    query,
    ddb,
    nowMs: NOW_MS,
  });
}

function parseHandler(res) {
  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.body),
  };
}

function authEvent(email, query = {}) {
  return {
    httpMethod: "GET",
    path: "/me/activity",
    queryStringParameters: query,
    requestContext: {
      authorizer: {
        claims: {
          email,
          "cognito:groups": email === ADMIN ? ["Admin"] : [],
        },
      },
    },
  };
}

(async () => {
  // 1. default date uses company today
  {
    const ddb = baseSeed();
    const res = await getMine(ddb, {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.date, TODAY);
  }

  // 2. explicit date
  {
    const ddb = baseSeed();
    const res = await getMine(ddb, { date: YESTERDAY });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.date, YESTERDAY);
    const bad = await getMine(ddb, { date: "25-09-2026" });
    assert.strictEqual(bad.statusCode, 400);
  }

  // 3. unauthenticated -> 401
  {
    const ddb = baseSeed();
    const res = await getMine(ddb, { date: TODAY }, { email: "" });
    assert.strictEqual(res.statusCode, 401);
    setClientsForTests({ ddb });
    const viaHandler = parseHandler(
      await handler({
        httpMethod: "GET",
        path: "/me/activity",
        queryStringParameters: { date: TODAY },
        requestContext: { authorizer: { claims: {} } },
      })
    );
    assert.strictEqual(viaHandler.statusCode, 401);
  }

  // 4. caller email cannot be overridden
  {
    const ddb = baseSeed();
    seedProfile(ddb, ADMIN, {
      name: "Admin",
      empId: "DGV-001",
      department: "HR",
    });
    setClientsForTests({ ddb });
    const viaHandler = parseHandler(
      await handler(
        authEvent(CALLER, { date: TODAY, email: ADMIN })
      )
    );
    assert.strictEqual(viaHandler.statusCode, 200);
    assert.strictEqual(viaHandler.body.employee.email, CALLER);
    assert.notStrictEqual(viaHandler.body.employee.email, ADMIN);
    const asAdmin = await getMine(
      ddb,
      { date: TODAY, email: CALLER },
      { email: ADMIN, groups: ["Admin"] }
    );
    assert.strictEqual(asAdmin.statusCode, 200);
    assert.strictEqual(asAdmin.body.employee.email, ADMIN);
  }

  // 5. missing attendance -> marked false
  {
    const ddb = baseSeed();
    const res = await getMine(ddb, { date: TODAY });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.attendance.marked, false);
    assert.notStrictEqual(res.body.attendance.status, "Absent");
    seedAttendance(ddb, CALLER, TODAY);
    const marked = await getMine(ddb, { date: TODAY });
    assert.strictEqual(marked.body.attendance.marked, true);
    assert.strictEqual(marked.body.shift.source, "attendance_snapshot");
  }

  // 6. multi-assignee employee included even when not task.assignee[0]
  {
    const ddb = baseSeed();
    seedEntityTask(ddb, {
      taskId: "task-multi",
      title: "Shared banner",
      assignee: LEAD,
      assignees: [LEAD],
    });
    seedAssignment(ddb, "task-multi", CALLER, { status: "IN_PROGRESS" });
    const res = await getMine(ddb, { date: TODAY });
    const ids = res.body.tasks.map((task) => task.taskId);
    assert.ok(ids.includes("task-multi"));
    const mine = res.body.tasks.find((task) => task.taskId === "task-multi");
    assert.strictEqual(mine.assignmentStatus, "IN_PROGRESS");
  }

  // 7. hidden pending scheduled task excluded
  {
    const ddb = baseSeed();
    seedEntityTask(ddb, {
      taskId: "task-pending",
      title: "Scheduled pending",
      assignee: "",
      assignees: [],
      assignmentMode: "SCHEDULED",
      assignmentState: "PENDING",
      pendingAssignees: [CALLER],
    });
    const res = await getMine(ddb, { date: TODAY });
    assert.ok(!res.body.tasks.some((task) => task.taskId === "task-pending"));
  }

  // 8. no assignment row excluded
  {
    const ddb = baseSeed();
    seedEntityTask(ddb, {
      taskId: "task-denorm",
      title: "Denormalized only",
      assignee: CALLER,
      assignees: [CALLER],
    });
    const res = await getMine(ddb, { date: TODAY });
    assert.ok(!res.body.tasks.some((task) => task.taskId === "task-denorm"));
  }

  // 9. task activity is date-scoped/capped
  {
    const ddb = baseSeed();
    seedEntityTask(ddb, { taskId: "task-act", title: "Activity cap" });
    seedAssignment(ddb, "task-act", CALLER, { status: "TODO" });
    seedTaskActivity(ddb, "task-act", "2026-09-24T10:00:00+05:30", {
      id: "old",
      detail: "Yesterday",
    });
    for (let i = 0; i < ACTIVITY_PER_TASK + 5; i += 1) {
      const hh = String(10 + Math.floor(i / 60)).padStart(2, "0");
      const mm = String(i % 60).padStart(2, "0");
      const ts = `2026-09-25T${hh}:${mm}:00+05:30`;
      seedTaskActivity(ddb, "task-act", ts, {
        id: `n${i}`,
        detail: `Note ${i}`,
        actorEmail: i % 2 === 0 ? CALLER : ADMIN,
      });
    }
    const res = await getMine(ddb, { date: TODAY });
    const mine = res.body.tasks.find((task) => task.taskId === "task-act");
    assert.ok(mine);
    assert.strictEqual(mine.activity.length, ACTIVITY_PER_TASK);
    assert.ok(mine.activity.every((row) => companyDateKey(row.timestamp) === TODAY));
    assert.ok(mine.activity.some((row) => row.actorEmail === ADMIN));
  }

  // 10. presence is date-scoped
  {
    const ddb = baseSeed();
    seedPresenceSummary(ddb, CALLER, TODAY, { totalMinutes: 480, eventCount: 2 });
    seedPresenceEvent(ddb, CALLER, TODAY, "2026-09-25T11:00:00+05:30", {
      id: "today",
      type: "login",
    });
    seedPresenceEvent(ddb, CALLER, YESTERDAY, "2026-09-24T11:00:00+05:30", {
      id: "yday",
      type: "login",
    });
    const res = await getMine(ddb, { date: TODAY });
    assert.strictEqual(res.body.presence.kind, "portal_presence");
    assert.strictEqual(res.body.presence.notWorkingHours, true);
    assert.ok(res.body.presence.events.every((ev) => ev.timestamp.startsWith("2026-09-25")));
    assert.ok(!res.body.presence.events.some((ev) => String(ev.timestamp).includes("2026-09-24")));
  }

  // 11. payload does not expose worked-hours totals
  {
    const ddb = baseSeed();
    seedPresenceSummary(ddb, CALLER, TODAY, { totalMinutes: 480, eventCount: 1 });
    seedPresenceEvent(ddb, CALLER, TODAY, "2026-09-25T11:05:00+05:30", {
      sessionMinutes: 12,
    });
    const res = await getMine(ddb, { date: TODAY });
    const raw = JSON.stringify(res.body);
    assert.ok(!/"totalMinutes"/.test(raw));
    assert.ok(!/"sessionMinutes"/.test(raw));
    assert.strictEqual(res.body.presence.totalMinutes, undefined);
    assert.ok(res.body.presence.events.every((ev) => ev.sessionMinutes == null));
  }

  // 12. basic 200 response shape
  {
    const ddb = baseSeed();
    const res = await getMine(ddb, { date: TODAY });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(Object.keys(res.body).sort(), [
      "attendance",
      "date",
      "employee",
      "presence",
      "shift",
      "tasks",
    ]);
    assert.strictEqual(res.body.employee.email, CALLER);
    assert.strictEqual(res.body.employee.name, "Priya");
    assert.strictEqual(res.body.employee.empId, "DGV-101");
    assert.strictEqual(res.body.employee.department, "Engineering");
    assert.ok(Array.isArray(res.body.tasks));
    assert.strictEqual(res.body.shift.source, "current");
    assert.strictEqual(res.body.shift.startTime, "11:00");
    assert.strictEqual(res.body.presence.kind, "portal_presence");
    setClientsForTests({ ddb });
    const viaHandler = parseHandler(await handler(authEvent(CALLER, { date: TODAY })));
    assert.strictEqual(viaHandler.statusCode, 200);
    assert.strictEqual(viaHandler.body.date, TODAY);
  }

  console.log("myActivity.test.js ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

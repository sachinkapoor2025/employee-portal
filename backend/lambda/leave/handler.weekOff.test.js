process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.ATTENDANCE_TABLE = "Attendance";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.WORK_TABLE = "WorkTasks";
process.env.AWS_REGION = "ap-south-1";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const emailLib = require("../common/email");
emailLib.sendEmail = async () => ({ ok: true, messageId: "ses-test" });
const {
  handler: leaveHandler,
  setDocumentClientForTests: setLeaveDdb,
  setNowMsForTests: setLeaveNow,
} = require("./handler");
const {
  handler: attendanceHandler,
  setDocumentClientForTests: setAttendanceDdb,
  setNowMsForTests: setAttendanceNow,
} = require("../attendance/handler");
const {
  WEEK_OFF_EXHAUSTED_MESSAGE,
  WEEK_OFF_ONE_DATE_MESSAGE,
  getCompanyWeekRange,
  weekOffClaimSk,
} = require("../common/weekOffEntitlement");
const { applyTransactWrite, queryStore, isTransactWrite } = require("../common/memoryTransact");
const { companyDateTimeIso } = require("../common/shiftWindows");

const EMAIL = "worker@mydgv.com";
const TODAY = "2026-09-30";
const WEEK = getCompanyWeekRange(TODAY);

const morning = {
  PK: `USER#${EMAIL}`,
  SK: "SHIFT#CURRENT",
  shiftId: "morning",
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 0,
  crossesMidnight: false,
};

const overnight = {
  PK: `USER#${EMAIL}`,
  SK: "SHIFT#CURRENT",
  shiftId: "night",
  name: "Night Shift",
  startTime: "22:00",
  endTime: "06:00",
  graceMinutes: 0,
  crossesMidnight: true,
};

function createFakeDdb({ access = {}, work = {}, attendance = {} } = {}) {
  const puts = [];
  const workStore = { ...work };
  const attendanceStore = { ...attendance };
  return {
    puts,
    workStore,
    attendanceStore,
    send: async (cmd) => {
      const name = cmd.constructor?.name || "";
      const input = cmd.input || {};
      const table = input.TableName;
      if (isTransactWrite(cmd, input)) {
        const written = applyTransactWrite(input, {
          [process.env.ATTENDANCE_TABLE]: attendanceStore,
          [process.env.WORK_TABLE]: workStore,
        });
        puts.push(...written);
        return {};
      }
      if (name === "DeleteCommand" && input.Key) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        if (table === process.env.ATTENDANCE_TABLE) delete attendanceStore[key];
        else delete workStore[key];
        return {};
      }
      if (input.Item) {
        const item = { ...input.Item };
        puts.push({ table, item });
        const key = `${item.PK}|${item.SK}`;
        if (table === process.env.ATTENDANCE_TABLE) attendanceStore[key] = item;
        else workStore[key] = item;
        return {};
      }
      if (input.KeyConditionExpression) {
        const store =
          table === process.env.ATTENDANCE_TABLE ? attendanceStore : workStore;
        return { Items: queryStore(store, input) };
      }
      if (input.Key) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        if (table === process.env.USER_ACCESS_TABLE) {
          return { Item: access[input.Key.PK] || null };
        }
        if (table === process.env.USER_PROFILE_TABLE) {
          return { Item: { name: "Pat", empId: "E1" } };
        }
        if (table === process.env.ATTENDANCE_TABLE) {
          return { Item: attendanceStore[key] || null };
        }
        return { Item: workStore[key] || null };
      }
      return { Items: [] };
    },
  };
}

function seedShift(db, assignment) {
  db.workStore[`${assignment.PK}|${assignment.SK}`] = assignment;
}

function seedLeave(db, item) {
  const entity = { PK: "ENTITY#LEAVE", SK: `LEAVE#${item.leaveId}`, ...item };
  db.workStore[`${entity.PK}|${entity.SK}`] = entity;
  db.workStore[`USER#${item.email}|LEAVE#${item.leaveId}`] = {
    ...entity,
    PK: `USER#${item.email}`,
    SK: `LEAVE#${item.leaveId}`,
  };
}

function freeze(iso) {
  const ms = Date.parse(iso);
  setLeaveNow(() => ms);
  setAttendanceNow(() => ms);
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function leaveEvent(method, body, qs, groups = []) {
  return {
    path: "/leave",
    httpMethod: method,
    queryStringParameters: qs || null,
    body: body ? JSON.stringify(body) : null,
    requestContext: {
      authorizer: {
        claims: { email: EMAIL, "cognito:groups": groups },
      },
    },
  };
}

function attendanceEvent(body) {
  return {
    path: "/attendance",
    httpMethod: "POST",
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: { email: EMAIL, "cognito:groups": ["Employee"] },
      },
    },
  };
}

function bind(db) {
  setLeaveDdb(db);
  setAttendanceDdb(db);
}

(async () => {
  freeze("2026-09-30T10:00:00+05:30");

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    bind(db);
    const res = parse(await leaveHandler(leaveEvent("GET", null, { weekOff: "true" })));
    assert.strictEqual(res.statusCode, 200, res.body.error);
    assert.strictEqual(res.body.weekStart, WEEK.weekStart);
    assert.strictEqual(res.body.weekEnd, WEEK.weekEnd);
    assert.strictEqual(res.body.weekOffEntitlement, 1);
    assert.strictEqual(res.body.weekOffUsed, 0);
    assert.strictEqual(res.body.weekOffAvailable, 1);
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    bind(db);
    const res = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-10-03",
          toDate: "2026-10-03",
          reason: "Off",
        })
      )
    );
    assert.strictEqual(res.statusCode, 201, res.body.error);
    assert.strictEqual(res.body.status, "PLANNED_OFF");
    const state = parse(await leaveHandler(leaveEvent("GET", null, { weekOff: "true" })));
    assert.strictEqual(state.body.weekOffUsed, 1);
    assert.strictEqual(state.body.weekOffAvailable, 0);
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    bind(db);
    const res = parse(
      await attendanceHandler(
        attendanceEvent([{ date: TODAY, status: "WeeklyOff" }])
      )
    );
    assert.strictEqual(res.statusCode, 200, res.body.error);
    assert.strictEqual(res.body.attendance.status, "WeeklyOff");
    const state = parse(await leaveHandler(leaveEvent("GET", null, { weekOff: "true" })));
    assert.strictEqual(state.body.weekOffUsed, 1);
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    bind(db);
    const first = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-10-02",
          toDate: "2026-10-02",
        })
      )
    );
    assert.strictEqual(first.statusCode, 201, first.body.error);
    const second = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-10-03",
          toDate: "2026-10-03",
        })
      )
    );
    assert.strictEqual(second.statusCode, 409);
    assert.strictEqual(second.body.error, WEEK_OFF_EXHAUSTED_MESSAGE);
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    bind(db);
    const first = parse(
      await attendanceHandler(
        attendanceEvent([{ date: TODAY, status: "WeeklyOff" }])
      )
    );
    assert.strictEqual(first.statusCode, 200, first.body.error);
    const second = parse(
      await attendanceHandler(
        attendanceEvent([{ date: TODAY, status: "WeeklyOff" }])
      )
    );
    assert.ok(second.statusCode === 409 || second.statusCode === 400);
    assert.match(
      String(second.body.error),
      /Week Off exhausted|already been submitted/
    );
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    bind(db);
    const leave = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-10-01",
          toDate: "2026-10-01",
        })
      )
    );
    assert.strictEqual(leave.statusCode, 201, leave.body.error);
    const attendance = parse(
      await attendanceHandler(
        attendanceEvent([{ date: TODAY, status: "WeeklyOff" }])
      )
    );
    assert.strictEqual(attendance.statusCode, 409);
    assert.strictEqual(attendance.body.error, WEEK_OFF_EXHAUSTED_MESSAGE);
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    bind(db);
    const leaveReq = leaveHandler(
      leaveEvent("POST", {
        category: "PLANNED_OFF",
        type: "PLANNED_OFF",
        fromDate: "2026-10-01",
        toDate: "2026-10-01",
      })
    );
    const attendanceReq = attendanceHandler(
      attendanceEvent([{ date: TODAY, status: "WeeklyOff" }])
    );
    const settled = await Promise.allSettled([leaveReq, attendanceReq]);
    const bodies = settled.map((row) => parse(row.value || { statusCode: 500, body: "{}" }));
    const created = bodies.filter(
      (row) =>
        row.statusCode === 201 ||
        (row.statusCode === 200 && row.body.attendance?.status === "WeeklyOff")
    );
    const blocked = bodies.filter((row) => row.statusCode >= 400);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(blocked.length, 1);
    assert.strictEqual(
      Object.values(db.attendanceStore).filter((row) =>
        String(row.SK || "").startsWith("WEEKOFF#")
      ).length,
      1
    );
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    bind(db);
    const range = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-10-01",
          toDate: "2026-10-03",
        })
      )
    );
    assert.strictEqual(range.statusCode, 400);
    assert.strictEqual(range.body.error, WEEK_OFF_ONE_DATE_MESSAGE);
  }

  {
    freeze("2026-09-30T12:00:00+05:30");
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    bind(db);
    const afterStart = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: TODAY,
          toDate: TODAY,
          emergencyReason: "Urgent",
        })
      )
    );
    assert.strictEqual(afterStart.statusCode, 400);
    assert.match(afterStart.body.error, /before your assigned shift starts/);
  }

  {
    freeze("2026-09-30T10:00:00+05:30");
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    bind(db);
    const beforeStart = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: TODAY,
          toDate: TODAY,
          emergencyReason: "Urgent",
        })
      )
    );
    assert.strictEqual(beforeStart.statusCode, 201, beforeStart.body.error);
  }

  {
    freeze("2026-09-30T10:00:00+05:30");
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    bind(db);
    const noShift = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: TODAY,
          toDate: TODAY,
          emergencyReason: "Urgent",
        })
      )
    );
    assert.strictEqual(noShift.statusCode, 400);
    assert.match(noShift.body.error, /assigned shift/);
  }

  {
    freeze("2026-09-30T10:00:00+05:30");
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, overnight);
    bind(db);
    const windowStart = companyDateTimeIso("2026-09-29", "22:00");
    freeze(windowStart.replace("Z", "").includes("T") ? "2026-09-30T10:00:00+05:30" : "2026-09-30T10:00:00+05:30");
    const res = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-10-02",
          toDate: "2026-10-02",
        })
      )
    );
    assert.strictEqual(res.statusCode, 201, res.body.error);
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    bind(db);
    const weekOff = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-09-30",
          toDate: "2026-09-30",
          emergencyReason: "Urgent",
        })
      )
    );
    assert.strictEqual(weekOff.statusCode, 201, weekOff.body.error);
    const leave = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "LEAVE",
          type: "CASUAL",
          fromDate: "2026-09-30",
          toDate: "2026-09-30",
          reason: "Sick",
        })
      )
    );
    assert.strictEqual(leave.statusCode, 400);
    assert.match(leave.body.error, /overlap an existing Week Off/);
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    seedLeave(db, {
      leaveId: "approved-1",
      email: EMAIL,
      fromDate: "2026-09-30",
      toDate: "2026-09-30",
      status: "APPROVED",
      category: "LEAVE",
      type: "CASUAL",
    });
    bind(db);
    const weekOff = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-09-30",
          toDate: "2026-09-30",
          emergencyReason: "Urgent",
        })
      )
    );
    assert.strictEqual(weekOff.statusCode, 400);
    assert.match(weekOff.body.error, /overlap existing leave/);
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    bind(db);
    const weekOff = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-10-03",
          toDate: "2026-10-03",
        })
      )
    );
    assert.strictEqual(weekOff.statusCode, 201, weekOff.body.error);
    const leave = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "LEAVE",
          type: "CASUAL",
          fromDate: "2026-10-01",
          toDate: "2026-10-04",
          emergencyReason: "Urgent",
        })
      )
    );
    assert.strictEqual(leave.statusCode, 400);
    assert.match(leave.body.error, /2026-10-03/);
  }

  {
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    seedLeave(db, {
      leaveId: "leave-only",
      email: EMAIL,
      fromDate: "2026-10-01",
      toDate: "2026-10-02",
      status: "APPROVED",
      category: "LEAVE",
      type: "CASUAL",
    });
    bind(db);
    const state = parse(await leaveHandler(leaveEvent("GET", null, { weekOff: "true" })));
    assert.strictEqual(state.body.weekOffAvailable, 1);
    assert.strictEqual(state.body.leaveUsed, 2);
    const weekOff = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-10-03",
          toDate: "2026-10-03",
        })
      )
    );
    assert.strictEqual(weekOff.statusCode, 201, weekOff.body.error);
  }

  {
    freeze("2026-09-30T10:00:00+05:30");
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    bind(db);
    const created = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-10-03",
          toDate: "2026-10-03",
        })
      )
    );
    assert.strictEqual(created.statusCode, 201, created.body.error);
    const cancelled = parse(
      await leaveHandler(
        leaveEvent("PUT", { leaveId: created.body.leaveId, action: "cancel" })
      )
    );
    assert.strictEqual(cancelled.statusCode, 200, cancelled.body.error);
    assert.strictEqual(cancelled.body.status, "CANCELLED");
    assert.strictEqual(
      db.attendanceStore[`${EMAIL}|${weekOffClaimSk(WEEK.weekStart)}`],
      undefined
    );
    const state = parse(await leaveHandler(leaveEvent("GET", null, { weekOff: "true" })));
    assert.strictEqual(state.body.weekOffAvailable, 1);
    assert.strictEqual(state.body.weekOffUsed, 0);
  }

  {
    freeze("2026-09-30T10:00:00+05:30");
    const db = createFakeDdb({
      access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    });
    seedShift(db, morning);
    seedLeave(db, {
      leaveId: "old-week",
      email: EMAIL,
      fromDate: "2026-09-22",
      toDate: "2026-09-22",
      status: "PLANNED_OFF",
      category: "PLANNED_OFF",
      type: "PLANNED_OFF",
    });
    bind(db);
    const state = parse(
      await leaveHandler(leaveEvent("GET", null, { weekOff: "true", weekStart: TODAY }))
    );
    assert.strictEqual(state.body.weekOffAvailable, 1);
    const next = parse(
      await leaveHandler(
        leaveEvent("POST", {
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate: "2026-10-03",
          toDate: "2026-10-03",
        })
      )
    );
    assert.strictEqual(next.statusCode, 201, next.body.error);
  }

  console.log("handler.weekOff.test.js ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

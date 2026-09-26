process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.ATTENDANCE_TABLE = "Attendance";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.WORK_TABLE = "WorkTasks";
process.env.AWS_REGION = "ap-south-1";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const email = require("../common/email");
email.sendEmail = async () => ({ ok: true, messageId: "ses-test" });
const {
  handler,
  todayAttendanceRange,
  setDocumentClientForTests,
  setNowMsForTests,
} = require("./handler");

const EMAIL = "worker@mydgv.com";
const TODAY = "2026-09-25";
const TOMORROW = "2026-09-26";
const DAY_AFTER = "2026-09-27";

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

function createFakeDdb({ access = {}, attendance = {}, work = {} } = {}) {
  const puts = [];
  const attendanceStore = { ...attendance };
  const workStore = { ...work };
  return {
    puts,
    attendanceStore,
    workStore,
    send: async (cmd) => {
      const name = cmd.constructor?.name || "";
      const input = cmd.input || {};
      const table = input.TableName;
      if (name === "DeleteCommand" && input.Key) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        if (table === process.env.ATTENDANCE_TABLE) delete attendanceStore[key];
        if (table === process.env.WORK_TABLE) delete workStore[key];
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
        const pk = input.ExpressionAttributeValues?.[":pk"];
        return {
          Items: Object.values(workStore).filter((row) => row.PK === pk),
        };
      }
      if (input.Key) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        if (table === process.env.USER_ACCESS_TABLE) {
          return { Item: access[input.Key.PK] || null };
        }
        if (table === process.env.USER_PROFILE_TABLE) {
          return { Item: { name: "Pat", empId: "E1" } };
        }
        if (table === process.env.WORK_TABLE) {
          return { Item: workStore[key] || null };
        }
        return { Item: attendanceStore[key] || null };
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

function eventFor(method, email, body, groups = []) {
  return {
    path: "/leave",
    httpMethod: method,
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: { email, "cognito:groups": groups },
      },
    },
  };
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function freeze(iso) {
  const ms = Date.parse(iso);
  setNowMsForTests(() => ms);
  return ms;
}

function attendancePuts(db) {
  return db.puts.filter((row) => row.table === process.env.ATTENDANCE_TABLE);
}

function pendingLeave(overrides = {}) {
  return {
    leaveId: "leave-1",
    email: EMAIL,
    category: "LEAVE",
    type: "CASUAL",
    fromDate: TOMORROW,
    toDate: TOMORROW,
    startDate: TOMORROW,
    endDate: TOMORROW,
    status: "PENDING",
    submittedAt: "2026-09-24T04:00:00.000Z",
    approvalDeadline: "2099-09-25T20:00:00.000Z",
    ...overrides,
  };
}

assert.deepStrictEqual(
  todayAttendanceRange(TODAY, TODAY, new Date("2026-09-25T10:59:00+05:30")),
  { fromDate: TODAY, toDate: TODAY }
);
assert.strictEqual(
  todayAttendanceRange(TOMORROW, DAY_AFTER, new Date("2026-09-25T10:59:00+05:30")),
  null
);
assert.deepStrictEqual(
  todayAttendanceRange(TODAY, DAY_AFTER, new Date("2026-09-25T10:59:00+05:30")),
  { fromDate: TODAY, toDate: TODAY }
);

(async () => {
{
  freeze("2026-09-25T10:59:00+05:30");
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(db, pendingLeave({ leaveId: "future-approve" }));
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("PUT", "boss@mydgv.com", { leaveId: "future-approve", status: "APPROVED" }, [
        "Admin",
      ])
    )
  );
  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(res.body.status, "APPROVED");
  assert.strictEqual(attendancePuts(db).length, 0);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TOMORROW}`], undefined);
  assert.ok(db.workStore["ENTITY#LEAVE|LEAVE#future-approve"]);
}

{
  freeze("2026-09-25T10:59:00+05:30");
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(
    db,
    pendingLeave({
      leaveId: "today-approve",
      fromDate: TODAY,
      toDate: TODAY,
      startDate: TODAY,
      endDate: TODAY,
    })
  );
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("PUT", "boss@mydgv.com", { leaveId: "today-approve", status: "APPROVED" }, [
        "Admin",
      ])
    )
  );
  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].status, "Leave");
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TOMORROW}`], undefined);
}

{
  freeze("2026-09-25T10:59:00+05:30");
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("POST", EMAIL, {
        category: "PLANNED_OFF",
        type: "PLANNED_OFF",
        fromDate: TOMORROW,
        toDate: TOMORROW,
        reason: "Off",
      })
    )
  );
  assert.strictEqual(res.statusCode, 201, res.body.error);
  assert.strictEqual(res.body.status, "PLANNED_OFF");
  assert.strictEqual(attendancePuts(db).length, 0);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TOMORROW}`], undefined);
}

{
  freeze("2026-09-25T10:59:00+05:30");
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedShift(db, morning);
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("POST", EMAIL, {
        category: "PLANNED_OFF",
        type: "PLANNED_OFF",
        fromDate: TODAY,
        toDate: TODAY,
        reason: "Off",
        emergencyReason: "Urgent",
      })
    )
  );
  assert.strictEqual(res.statusCode, 201, res.body.error);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].status, "PlannedOff");
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TOMORROW}`], undefined);
}

{
  freeze("2026-09-25T10:59:00+05:30");
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(
    db,
    pendingLeave({
      leaveId: "multi-day",
      fromDate: TODAY,
      toDate: DAY_AFTER,
      startDate: TODAY,
      endDate: DAY_AFTER,
    })
  );
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("PUT", "boss@mydgv.com", { leaveId: "multi-day", status: "APPROVED" }, [
        "Admin",
      ])
    )
  );
  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].status, "Leave");
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TOMORROW}`], undefined);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${DAY_AFTER}`], undefined);
  assert.strictEqual(
    attendancePuts(db).filter((row) => row.item.status === "Leave").length,
    1
  );
}

{
  freeze("2026-09-25T10:59:00+05:30");
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(db, {
    leaveId: "future-cancel",
    email: EMAIL,
    category: "LEAVE",
    type: "CASUAL",
    fromDate: TOMORROW,
    toDate: DAY_AFTER,
    status: "APPROVED",
    approvedBy: "boss@mydgv.com",
    approvedAt: "2026-09-24T05:00:00.000Z",
  });
  db.attendanceStore[`${EMAIL}|${TOMORROW}`] = {
    PK: EMAIL,
    SK: TOMORROW,
    email: EMAIL,
    date: TOMORROW,
    status: "Leave",
    attendanceId: "stale-future-shell",
  };
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("PUT", EMAIL, { leaveId: "future-cancel", status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(res.body.status, "CANCELLED");
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TOMORROW}`], undefined);
  assert.ok(db.workStore["ENTITY#LEAVE|LEAVE#future-cancel"]);
}

{
  freeze("2026-09-25T10:59:00+05:30");
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(db, pendingLeave({ leaveId: "reject-future" }));
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor(
        "PUT",
        "boss@mydgv.com",
        { leaveId: "reject-future", status: "REJECTED", rejectionReason: "No" },
        ["Admin"]
      )
    )
  );
  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(res.body.status, "REJECTED");
  assert.strictEqual(attendancePuts(db).length, 0);
}

{
  freeze("2026-09-25T11:00:00+05:30");
  const db = createFakeDdb();
  seedShift(db, morning);
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("POST", EMAIL, {
        category: "LEAVE",
        type: "CASUAL",
        fromDate: TODAY,
        toDate: TODAY,
        reason: "Need off",
      })
    )
  );
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error || "", /before your assigned shift starts/i);
}

setNowMsForTests(null);
console.log("leave today-only attendance materialization tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

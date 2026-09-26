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
  appendStatusHistory,
  setDocumentClientForTests,
  setNowMsForTests,
} = require("./handler");

function todayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(key, n) {
  const [y, m, d] = String(key)
    .split("-")
    .map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function createFakeDdb({ access = {}, attendance = {}, work = {} } = {}) {
  const puts = [];
  const deletes = [];
  const attendanceStore = { ...attendance };
  const workStore = { ...work };
  return {
    puts,
    deletes,
    attendanceStore,
    workStore,
    send: async (cmd) => {
      const name = cmd.constructor?.name || "";
      const input = cmd.input || {};
      const table = input.TableName;
      if (name === "DeleteCommand" && input.Key) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        deletes.push({ table, key: input.Key });
        if (table === process.env.ATTENDANCE_TABLE) delete attendanceStore[key];
        if (table === process.env.WORK_TABLE) delete workStore[key];
        return {};
      }
      if (input.Item) {
        const item = {
          ...input.Item,
          statusHistory: Array.isArray(input.Item.statusHistory)
            ? input.Item.statusHistory.map((entry) => ({ ...entry }))
            : input.Item.statusHistory,
        };
        puts.push({ table, item });
        const key = `${item.PK}|${item.SK}`;
        if (table === process.env.ATTENDANCE_TABLE) attendanceStore[key] = item;
        else workStore[key] = item;
        return {};
      }
      if (input.KeyConditionExpression) {
        const pk = input.ExpressionAttributeValues?.[":pk"];
        const items = Object.values(workStore).filter((row) => row.PK === pk);
        return { Items: items };
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

function seedLeave(db, item) {
  const entity = {
    PK: "ENTITY#LEAVE",
    SK: `LEAVE#${item.leaveId}`,
    ...item,
  };
  const userCopy = {
    ...entity,
    PK: `USER#${item.email}`,
    SK: `LEAVE#${item.leaveId}`,
  };
  db.workStore[`${entity.PK}|${entity.SK}`] = entity;
  db.workStore[`${userCopy.PK}|${userCopy.SK}`] = userCopy;
  return entity;
}

function eventFor(email, body, groups = []) {
  return {
    path: "/leave",
    httpMethod: "PUT",
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: {
          email,
          "cognito:groups": groups,
        },
      },
    },
  };
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function approvedLeave(overrides = {}) {
  const today = todayKey();
  const fromDate = addDays(today, 2);
  return {
    leaveId: "leave-future-1",
    email: "worker@mydgv.com",
    category: "LEAVE",
    type: "CASUAL",
    fromDate,
    toDate: fromDate,
    startDate: fromDate,
    endDate: fromDate,
    days: 1,
    status: "APPROVED",
    submittedAt: "2026-09-20T04:00:00.000Z",
    approvedBy: "boss@mydgv.com",
    approvedAt: "2026-09-20T05:00:00.000Z",
    reviewedBy: "boss@mydgv.com",
    reviewedAt: "2026-09-20T05:00:00.000Z",
    statusHistory: [
      {
        status: "PENDING",
        at: "2026-09-20T04:00:00.000Z",
        by: "worker@mydgv.com",
      },
      {
        status: "APPROVED",
        previousStatus: "PENDING",
        at: "2026-09-20T05:00:00.000Z",
        by: "boss@mydgv.com",
      },
    ],
    ...overrides,
  };
}

(async () => {
{
  const history = appendStatusHistory(
    {
      status: "APPROVED",
      approvedBy: "boss@mydgv.com",
      approvedAt: "2026-09-20T05:00:00.000Z",
    },
    { status: "CANCELLED", by: "worker@mydgv.com", at: "2026-09-21T06:00:00.000Z" }
  );
  assert.strictEqual(history[0].status, "APPROVED");
  assert.strictEqual(history[1].status, "CANCELLED");
  assert.strictEqual(history[1].previousStatus, "APPROVED");
  assert.strictEqual(history[1].by, "worker@mydgv.com");
}

{
  const leave = approvedLeave();
  const attKey = `${leave.email}|${leave.fromDate}`;
  const db = createFakeDdb({
    access: { [leave.email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    attendance: {
      [attKey]: {
        PK: leave.email,
        SK: leave.fromDate,
        email: leave.email,
        date: leave.fromDate,
        status: "Leave",
        attendanceId: "leave-row-1",
      },
    },
  });
  seedLeave(db, leave);
  setDocumentClientForTests(db);

  const res = parse(
    await handler(
      eventFor(leave.email, { leaveId: leave.leaveId, status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, "CANCELLED");
  assert.strictEqual(res.body.cancelledBy, leave.email);
  assert.ok(res.body.cancelledAt);
  assert.strictEqual(res.body.approvedBy, "boss@mydgv.com");
  assert.strictEqual(res.body.approvedAt, "2026-09-20T05:00:00.000Z");

  const last = res.body.statusHistory[res.body.statusHistory.length - 1];
  assert.strictEqual(last.status, "CANCELLED");
  assert.strictEqual(last.previousStatus, "APPROVED");
  assert.strictEqual(last.by, leave.email);
  const approvedEntry = res.body.statusHistory.find((e) => e.status === "APPROVED");
  assert.ok(approvedEntry);
  assert.strictEqual(approvedEntry.previousStatus, "PENDING");

  const entity = db.workStore[`ENTITY#LEAVE|LEAVE#${leave.leaveId}`];
  const userCopy = db.workStore[`USER#${leave.email}|LEAVE#${leave.leaveId}`];
  assert.ok(entity);
  assert.ok(userCopy);
  assert.strictEqual(entity.status, "CANCELLED");
  assert.strictEqual(userCopy.status, "CANCELLED");
  assert.strictEqual(entity.approvedBy, "boss@mydgv.com");
  assert.ok(!db.deletes.some((row) => row.table === process.env.WORK_TABLE));
  assert.strictEqual(db.attendanceStore[attKey], undefined);
}

{
  const leave = approvedLeave({ leaveId: "leave-other" });
  const db = createFakeDdb();
  seedLeave(db, leave);
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("other@mydgv.com", { leaveId: leave.leaveId, status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(
    db.workStore[`ENTITY#LEAVE|LEAVE#${leave.leaveId}`].status,
    "APPROVED"
  );
}

{
  const today = todayKey();
  const fromDate = addDays(today, -2);
  const leave = approvedLeave({
    leaveId: "leave-past",
    fromDate,
    toDate: fromDate,
    startDate: fromDate,
    endDate: fromDate,
  });
  const db = createFakeDdb({
    attendance: {
      [`${leave.email}|${fromDate}`]: {
        PK: leave.email,
        SK: fromDate,
        email: leave.email,
        date: fromDate,
        status: "Leave",
        attendanceId: "keep-past",
      },
    },
  });
  seedLeave(db, leave);
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor(leave.email, { leaveId: leave.leaveId, status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error || "", /past/i);
  assert.strictEqual(
    db.workStore[`ENTITY#LEAVE|LEAVE#${leave.leaveId}`].status,
    "APPROVED"
  );
  assert.strictEqual(
    db.attendanceStore[`${leave.email}|${fromDate}`].attendanceId,
    "keep-past"
  );
}

{
  const nowMs = Date.parse("2026-09-23T11:30:00+05:30");
  setNowMsForTests(() => nowMs);
  const today = todayKey(new Date(nowMs));
  const leave = approvedLeave({
    leaveId: "leave-started",
    fromDate: today,
    toDate: addDays(today, 1),
    startDate: today,
    endDate: addDays(today, 1),
  });
  const db = createFakeDdb({
    attendance: {
      [`${leave.email}|${today}`]: {
        PK: leave.email,
        SK: today,
        email: leave.email,
        date: today,
        status: "Leave",
        attendanceId: "keep-today",
      },
    },
  });
  db.workStore[`USER#${leave.email}|SHIFT#CURRENT`] = {
    PK: `USER#${leave.email}`,
    SK: "SHIFT#CURRENT",
    shiftId: "morning",
    name: "Morning Shift",
    startTime: "11:00",
    endTime: "20:00",
    crossesMidnight: false,
  };
  seedLeave(db, leave);
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor(leave.email, { leaveId: leave.leaveId, status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error || "", /started/i);
  assert.strictEqual(
    db.attendanceStore[`${leave.email}|${today}`].attendanceId,
    "keep-today"
  );
  setNowMsForTests(null);
}

{
  const leave = approvedLeave({ leaveId: "leave-keep-activity" });
  const future = leave.fromDate;
  const db = createFakeDdb({
    attendance: {
      [`${leave.email}|${future}`]: {
        PK: leave.email,
        SK: future,
        email: leave.email,
        date: future,
        status: "Leave",
        attendanceId: "keep-punched",
        checkInTime: "2026-09-25T05:30:00.000Z",
        actualCheckInTime: "2026-09-25T05:30:00.000Z",
        sessionStatus: "Active",
      },
    },
  });
  seedLeave(db, leave);
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor(leave.email, { leaveId: leave.leaveId, status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(
    db.attendanceStore[`${leave.email}|${future}`].attendanceId,
    "keep-punched"
  );
}

{
  const pending = approvedLeave({
    leaveId: "leave-pending-approve",
    status: "PENDING",
    approvedBy: null,
    approvedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    approvalDeadline: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    statusHistory: [
      {
        status: "PENDING",
        at: "2026-09-20T04:00:00.000Z",
        by: "worker@mydgv.com",
      },
    ],
  });
  const db = createFakeDdb({
    access: { [pending.email]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(db, pending);
  setDocumentClientForTests(db);
  const approved = parse(
    await handler(
      eventFor(
        "boss@mydgv.com",
        { leaveId: pending.leaveId, status: "APPROVED" },
        ["Admin"]
      )
    )
  );
  assert.strictEqual(approved.statusCode, 200);
  assert.strictEqual(approved.body.status, "APPROVED");
  assert.strictEqual(approved.body.approvedBy, "boss@mydgv.com");
  const last = approved.body.statusHistory[approved.body.statusHistory.length - 1];
  assert.strictEqual(last.status, "APPROVED");
  assert.strictEqual(last.previousStatus, "PENDING");
  assert.strictEqual(
    db.attendanceStore[`${pending.email}|${pending.fromDate}`],
    undefined
  );
}

{
  const pending = approvedLeave({
    leaveId: "leave-pending-reject",
    status: "PENDING",
    approvedBy: null,
    approvedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    approvalDeadline: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    statusHistory: [],
  });
  const db = createFakeDdb({
    access: { [pending.email]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(db, pending);
  setDocumentClientForTests(db);
  const rejected = parse(
    await handler(
      eventFor(
        "boss@mydgv.com",
        {
          leaveId: pending.leaveId,
          status: "REJECTED",
          rejectionReason: "Coverage needed",
        },
        ["Admin"]
      )
    )
  );
  assert.strictEqual(rejected.statusCode, 200);
  assert.strictEqual(rejected.body.status, "REJECTED");
  assert.strictEqual(rejected.body.rejectedBy, "boss@mydgv.com");
  assert.strictEqual(rejected.body.rejectionReason, "Coverage needed");
  const last = rejected.body.statusHistory[rejected.body.statusHistory.length - 1];
  assert.strictEqual(last.status, "REJECTED");
  assert.strictEqual(last.previousStatus, "PENDING");
  assert.strictEqual(
    db.attendanceStore[`${pending.email}|${pending.fromDate}`],
    undefined
  );
}

{
  const pending = approvedLeave({
    leaveId: "leave-emp-cannot-approve",
    status: "PENDING",
    approvedBy: null,
    approvedAt: null,
    approvalDeadline: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  });
  const db = createFakeDdb();
  seedLeave(db, pending);
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor(pending.email, { leaveId: pending.leaveId, status: "APPROVED" })
    )
  );
  assert.strictEqual(res.statusCode, 403);
}

{
  const leave = approvedLeave({
    leaveId: "leave-pending-cancel",
    status: "PENDING",
    approvedBy: null,
    approvedAt: null,
    approvalDeadline: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  });
  const db = createFakeDdb();
  seedLeave(db, leave);
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor(leave.email, { leaveId: leave.leaveId, status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 400);
}

console.log("leave cancel + history tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

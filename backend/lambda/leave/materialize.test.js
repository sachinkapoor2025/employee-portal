process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.ATTENDANCE_TABLE = "Attendance";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.WORK_TABLE = "WorkTasks";
process.env.AWS_REGION = "ap-south-1";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  materializeTodaysConfirmedLeave,
  SOURCE_LEAVE_MATERIALIZED,
} = require("./materialize");
const {
  handler: leaveHandler,
  setDocumentClientForTests: setLeaveDdb,
  setNowMsForTests,
} = require("./handler");

const EMAIL = "worker@mydgv.com";
const TODAY = "2026-09-25";
const TOMORROW = "2026-09-26";
const DAY_AFTER = "2026-09-27";

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
        const key = `${input.Item.PK}|${input.Item.SK}`;
        const existing =
          table === process.env.ATTENDANCE_TABLE
            ? attendanceStore[key]
            : workStore[key];
        const ce = String(input.ConditionExpression || "");
        if (ce.includes("attribute_not_exists(submittedAt)")) {
          if (
            existing?.submittedAt ||
            existing?.actualCheckInTime ||
            existing?.actualCheckOutTime
          ) {
            const err = new Error("ConditionalCheckFailed");
            err.name = "ConditionalCheckFailedException";
            throw err;
          }
        }
        const item = { ...input.Item };
        puts.push({ table, item });
        if (table === process.env.ATTENDANCE_TABLE) attendanceStore[key] = item;
        else workStore[key] = item;
        return {};
      }
      if (input.KeyConditionExpression) {
        const pk = input.ExpressionAttributeValues?.[":pk"];
        const skPrefix = input.ExpressionAttributeValues?.[":sk"];
        const items = Object.values(workStore).filter((row) => {
          if (row.PK !== pk) return false;
          if (!skPrefix) return true;
          return String(row.SK || "").startsWith(skPrefix);
        });
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
  db.workStore[`${entity.PK}|${entity.SK}`] = entity;
  db.workStore[`USER#${item.email}|LEAVE#${item.leaveId}`] = {
    ...entity,
    PK: `USER#${item.email}`,
    SK: `LEAVE#${item.leaveId}`,
  };
}

function approved(overrides = {}) {
  return {
    leaveId: "leave-1",
    email: EMAIL,
    category: "LEAVE",
    type: "CASUAL",
    fromDate: TOMORROW,
    toDate: TOMORROW,
    status: "APPROVED",
    approvedBy: "boss@mydgv.com",
    approvedAt: "2026-09-24T05:00:00.000Z",
    ...overrides,
  };
}

function eventFor(method, email, body, groups = []) {
  return {
    path: "/leave",
    httpMethod: method,
    body: JSON.stringify(body),
    requestContext: {
      authorizer: { claims: { email, "cognito:groups": groups } },
    },
  };
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

const now = new Date("2026-09-25T10:59:00+05:30");
setNowMsForTests(() => now.getTime());

(async () => {
{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(db, approved({ leaveId: "future-only", fromDate: TOMORROW, toDate: TOMORROW }));
  const result = await materializeTodaysConfirmedLeave({ ddb: db, now });
  assert.strictEqual(result.written, 0);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TOMORROW}`], undefined);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`], undefined);
}

{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(db, approved({ leaveId: "today-leave", fromDate: TODAY, toDate: TODAY }));
  const first = await materializeTodaysConfirmedLeave({ ddb: db, now });
  assert.strictEqual(first.written, 1);
  const row = db.attendanceStore[`${EMAIL}|${TODAY}`];
  assert.strictEqual(row.status, "Leave");
  assert.strictEqual(row.leaveId, "today-leave");
  assert.strictEqual(row.source, SOURCE_LEAVE_MATERIALIZED);
  assert.ok(row.submittedAt);
  assert.strictEqual(row.checkInTime, null);
  assert.strictEqual(row.checkOutTime, null);
  assert.strictEqual(row.actualCheckInTime, undefined);
  assert.strictEqual(row.actualCheckOutTime, undefined);
  assert.strictEqual(row.sessionStatus, null);
  assert.strictEqual(row.workingTime, null);
  const attendanceId = row.attendanceId;
  const putCount = db.puts.filter((p) => p.table === process.env.ATTENDANCE_TABLE).length;
  const second = await materializeTodaysConfirmedLeave({ ddb: db, now });
  assert.strictEqual(second.written, 0);
  assert.strictEqual(second.exists, 1);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].attendanceId, attendanceId);
  assert.strictEqual(
    db.puts.filter((p) => p.table === process.env.ATTENDANCE_TABLE).length,
    putCount
  );
}

{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(
    db,
    approved({
      leaveId: "multi",
      fromDate: TODAY,
      toDate: DAY_AFTER,
    })
  );
  await materializeTodaysConfirmedLeave({ ddb: db, now });
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].status, "Leave");
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TOMORROW}`], undefined);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${DAY_AFTER}`], undefined);
}

{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(
    db,
    approved({
      leaveId: "cancelled",
      fromDate: TODAY,
      toDate: TODAY,
      status: "CANCELLED",
    })
  );
  const result = await materializeTodaysConfirmedLeave({ ddb: db, now });
  assert.strictEqual(result.written, 0);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`], undefined);
}

{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    attendance: {
      [`${EMAIL}|${TODAY}`]: {
        PK: EMAIL,
        SK: TODAY,
        email: EMAIL,
        date: TODAY,
        status: "Working",
        attendanceId: "keep-working",
        submittedAt: "2026-09-25T03:00:00.000Z",
        actualCheckInTime: "2026-09-25T05:30:00.000Z",
        checkInTime: "2026-09-25T05:30:00.000Z",
        sessionStatus: "Active",
      },
    },
  });
  seedLeave(db, approved({ leaveId: "after-punch", fromDate: TODAY, toDate: TODAY }));
  const result = await materializeTodaysConfirmedLeave({ ddb: db, now });
  assert.strictEqual(result.preserved, 1);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].attendanceId, "keep-working");
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].status, "Working");
  assert.strictEqual(
    db.attendanceStore[`${EMAIL}|${TODAY}`].actualCheckInTime,
    "2026-09-25T05:30:00.000Z"
  );
}

{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedLeave(db, approved({ leaveId: "recover-missing", fromDate: TODAY, toDate: TODAY }));
  const recovered = await materializeTodaysConfirmedLeave({ ddb: db, now });
  assert.strictEqual(recovered.written, 1);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].status, "Leave");
  assert.ok(db.attendanceStore[`${EMAIL}|${TODAY}`].submittedAt);
}

{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  db.workStore[`USER#${EMAIL}|SHIFT#CURRENT`] = {
    PK: `USER#${EMAIL}`,
    SK: "SHIFT#CURRENT",
    startTime: "11:00",
    endTime: "20:00",
    crossesMidnight: false,
  };
  seedLeave(db, {
    leaveId: "cancel-today-lock",
    email: EMAIL,
    category: "LEAVE",
    type: "CASUAL",
    fromDate: TODAY,
    toDate: TODAY,
    status: "APPROVED",
    approvedBy: "boss@mydgv.com",
    approvedAt: "2026-09-24T05:00:00.000Z",
  });
  await materializeTodaysConfirmedLeave({ ddb: db, now });
  assert.ok(db.attendanceStore[`${EMAIL}|${TODAY}`].submittedAt);
  setLeaveDdb(db);
  const res = parse(
    await leaveHandler(
      eventFor("PUT", EMAIL, { leaveId: "cancel-today-lock", status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(res.body.status, "CANCELLED");
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`], undefined);
}

{
  const sweep = fs.readFileSync(
    path.join(__dirname, "../projects/handler.js"),
    "utf8"
  );
  const start = sweep.indexOf("async function runEscalationSweep");
  const end = sweep.indexOf("async function getProjectName");
  const fn = sweep.slice(start, end);
  assert.ok(fn.includes("materializeTodaysConfirmedLeave"));
  assert.ok(
    fn.indexOf("materializeTodaysConfirmedLeave") <
      fn.indexOf("assignDueScheduledTasks")
  );
}

{
  const leaveSrc = fs.readFileSync(path.join(__dirname, "handler.js"), "utf8");
  const start = leaveSrc.indexOf("if (isAutoApproveEvent(event))");
  const fn = leaveSrc.slice(start, start + 900);
  assert.ok(fn.includes("materializeTodaysConfirmedLeave"));
  assert.ok(fn.indexOf("autoApproveExpiredSafe") < fn.indexOf("materializeTodaysConfirmedLeave"));
}

setNowMsForTests(null);
console.log("leave materialize tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

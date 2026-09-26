process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.ATTENDANCE_TABLE = "Attendance";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.WORK_TABLE = "WorkTasks";
process.env.AWS_REGION = "ap-south-1";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const {
  handler,
  setDocumentClientForTests,
} = require("./handler");

const EMAIL = "worker@mydgv.com";

function createFakeDdb({ attendance = {}, work = {} } = {}) {
  const attendanceStore = { ...attendance };
  const workStore = { ...work };
  return {
    attendanceStore,
    workStore,
    send: async (cmd) => {
      const input = cmd.input || {};
      const table = input.TableName;
      if (input.KeyConditionExpression) {
        const pk = input.ExpressionAttributeValues?.[":pk"];
        const skPrefix = input.ExpressionAttributeValues?.[":sk"];
        const start = input.ExpressionAttributeValues?.[":start"];
        const end = input.ExpressionAttributeValues?.[":end"];
        const source =
          table === process.env.ATTENDANCE_TABLE ? attendanceStore : workStore;
        const items = Object.values(source).filter((row) => {
          if (row.PK !== pk) return false;
          if (skPrefix) return String(row.SK || "").startsWith(skPrefix);
          if (start && end) return row.SK >= start && row.SK <= end;
          return true;
        });
        return { Items: items };
      }
      if (input.Key) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        if (table === process.env.WORK_TABLE) {
          return { Item: workStore[key] || null };
        }
        return { Item: attendanceStore[key] || null };
      }
      return { Items: [] };
    },
  };
}

function getEvent(email, startDate, endDate) {
  return {
    path: "/attendance",
    httpMethod: "GET",
    queryStringParameters: { startDate, endDate },
    requestContext: {
      authorizer: { claims: { email, "cognito:groups": [] } },
    },
  };
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function byDate(rows) {
  const map = {};
  for (const row of rows || []) map[row.date] = row;
  return map;
}

function seedUserLeave(db, item) {
  db.workStore[`USER#${item.email}|LEAVE#${item.leaveId}`] = {
    PK: `USER#${item.email}`,
    SK: `LEAVE#${item.leaveId}`,
    ...item,
  };
}

(async () => {
{
  const db = createFakeDdb();
  seedUserLeave(db, {
    leaveId: "approved-leave",
    email: EMAIL,
    status: "APPROVED",
    category: "LEAVE",
    fromDate: "2026-09-25",
    toDate: "2026-09-25",
  });
  setDocumentClientForTests(db);
  const res = parse(await handler(getEvent(EMAIL, "2026-09-25", "2026-09-25")));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(byDate(res.body)["2026-09-25"].status, "Leave");
}

{
  const db = createFakeDdb();
  seedUserLeave(db, {
    leaveId: "planned",
    email: EMAIL,
    status: "PLANNED_OFF",
    category: "PLANNED_OFF",
    type: "PLANNED_OFF",
    fromDate: "2026-09-25",
    toDate: "2026-09-25",
  });
  setDocumentClientForTests(db);
  const res = parse(await handler(getEvent(EMAIL, "2026-09-25", "2026-09-25")));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(byDate(res.body)["2026-09-25"].status, "PlannedOff");
}

{
  const db = createFakeDdb();
  seedUserLeave(db, {
    leaveId: "cancelled-leave",
    email: EMAIL,
    status: "CANCELLED",
    category: "LEAVE",
    fromDate: "2026-09-25",
    toDate: "2026-09-25",
  });
  setDocumentClientForTests(db);
  const res = parse(await handler(getEvent(EMAIL, "2026-09-25", "2026-09-25")));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(byDate(res.body)["2026-09-25"], undefined);
}

{
  const db = createFakeDdb();
  seedUserLeave(db, {
    leaveId: "cancelled-planned",
    email: EMAIL,
    status: "CANCELLED",
    category: "PLANNED_OFF",
    type: "PLANNED_OFF",
    fromDate: "2026-09-25",
    toDate: "2026-09-25",
  });
  setDocumentClientForTests(db);
  const res = parse(await handler(getEvent(EMAIL, "2026-09-25", "2026-09-25")));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(byDate(res.body)["2026-09-25"], undefined);
}

{
  const db = createFakeDdb({
    attendance: {
      [`${EMAIL}|2026-09-25`]: {
        PK: EMAIL,
        SK: "2026-09-25",
        email: EMAIL,
        date: "2026-09-25",
        status: "Leave",
        attendanceId: "stored-leave",
        submittedAt: "2026-09-25T03:00:00.000Z",
        leaveId: "stored",
      },
    },
  });
  seedUserLeave(db, {
    leaveId: "stored",
    email: EMAIL,
    status: "APPROVED",
    category: "LEAVE",
    fromDate: "2026-09-25",
    toDate: "2026-09-25",
  });
  setDocumentClientForTests(db);
  const res = parse(await handler(getEvent(EMAIL, "2026-09-25", "2026-09-25")));
  assert.strictEqual(res.statusCode, 200);
  const row = byDate(res.body)["2026-09-25"];
  assert.strictEqual(row.status, "Leave");
  assert.strictEqual(row.attendanceId, "stored-leave");
  assert.strictEqual(row.submittedAt, "2026-09-25T03:00:00.000Z");
}

{
  const db = createFakeDdb({
    attendance: {
      [`${EMAIL}|2026-09-24`]: {
        PK: EMAIL,
        SK: "2026-09-24",
        email: EMAIL,
        date: "2026-09-24",
        status: "Working",
        attendanceId: "hist-working",
        checkInTime: "2026-09-24T05:30:00.000Z",
        submittedAt: "2026-09-24T05:40:00.000Z",
      },
    },
  });
  seedUserLeave(db, {
    leaveId: "cancelled-over-history",
    email: EMAIL,
    status: "CANCELLED",
    category: "PLANNED_OFF",
    fromDate: "2026-09-24",
    toDate: "2026-09-25",
  });
  setDocumentClientForTests(db);
  const res = parse(await handler(getEvent(EMAIL, "2026-09-24", "2026-09-25")));
  assert.strictEqual(res.statusCode, 200);
  const map = byDate(res.body);
  assert.strictEqual(map["2026-09-24"].status, "Working");
  assert.strictEqual(map["2026-09-24"].attendanceId, "hist-working");
  assert.strictEqual(map["2026-09-25"], undefined);
}

console.log("attendance leave overlay tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

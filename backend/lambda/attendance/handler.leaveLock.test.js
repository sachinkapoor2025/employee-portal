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
  setNowMsForTests,
} = require("./handler");

const EMAIL = "doer@mydgv.com";
const NOW = Date.parse("2026-09-25T10:59:00+05:30");
const TODAY = "2026-09-25";

function createFakeDdb({ access = {}, attendance = {}, work = {} } = {}) {
  const puts = [];
  const attendanceStore = { ...attendance };
  const workStore = { ...work };
  return {
    puts,
    attendanceStore,
    workStore,
    send: async (cmd) => {
      const input = cmd.input || {};
      const table = input.TableName;
      if (input.Item) {
        puts.push({ table, item: { ...input.Item } });
        const key = `${input.Item.PK}|${input.Item.SK}`;
        if (table === process.env.ATTENDANCE_TABLE) {
          attendanceStore[key] = { ...input.Item };
        } else {
          workStore[key] = { ...input.Item };
        }
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

function postEvent(email, body, groups = []) {
  return {
    path: "/attendance",
    httpMethod: "POST",
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

function seedShift(db) {
  db.workStore[`USER#${EMAIL}|SHIFT#CURRENT`] = {
    PK: `USER#${EMAIL}`,
    SK: "SHIFT#CURRENT",
    shiftId: "morning",
    name: "Morning Shift",
    startTime: "11:00",
    endTime: "20:00",
    graceMinutes: 15,
    crossesMidnight: false,
  };
}

setNowMsForTests(() => NOW);

(async () => {
{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
    attendance: {
      [`${EMAIL}|${TODAY}`]: {
        PK: EMAIL,
        SK: TODAY,
        email: EMAIL,
        date: TODAY,
        status: "Leave",
        submittedAt: "2026-09-25T03:00:00.000Z",
        leaveId: "leave-lock",
        attendanceId: "leave-row",
      },
    },
  });
  seedShift(db);
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      postEvent(EMAIL, [{ date: TODAY, status: "Working", workPeriod: "FULL_DAY" }])
    )
  );
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.error || "", /approved leave/i);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].status, "Leave");
}

{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedShift(db);
  db.workStore[`USER#${EMAIL}|LEAVE#missing-row`] = {
    PK: `USER#${EMAIL}`,
    SK: "LEAVE#missing-row",
    leaveId: "missing-row",
    email: EMAIL,
    category: "LEAVE",
    status: "APPROVED",
    fromDate: TODAY,
    toDate: TODAY,
  };
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      postEvent(EMAIL, [{ date: TODAY, status: "Working", workPeriod: "FULL_DAY" }])
    )
  );
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.error || "", /approved leave/i);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`], undefined);
}

{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedShift(db);
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      postEvent(EMAIL, [{ date: TODAY, status: "Working", workPeriod: "FULL_DAY" }])
    )
  );
  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].status, "Working");
  assert.ok(db.attendanceStore[`${EMAIL}|${TODAY}`].submittedAt);
}

{
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  setDocumentClientForTests(db);
  const res = parse(
    await handler(postEvent(EMAIL, [{ date: TODAY, status: "Holiday" }]))
  );
  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(db.attendanceStore[`${EMAIL}|${TODAY}`].status, "Holiday");
}

setNowMsForTests(null);
console.log("attendance leave-lock tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

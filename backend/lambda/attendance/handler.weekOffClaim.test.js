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
const { queryStore } = require("../common/memoryTransact");

const EMAIL = "worker@mydgv.com";
const ADMIN = "admin@mydgv.com";
const WEEK_START = "2026-09-28";
const CLAIM_SK = `WEEKOFF#${WEEK_START}`;

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function adminEvent(qs = {}) {
  return {
    path: "/admin/attendance-activity",
    httpMethod: "GET",
    queryStringParameters: qs,
    requestContext: {
      authorizer: {
        claims: {
          email: ADMIN,
          "cognito:groups": ["Admin"],
        },
      },
    },
  };
}

function rangeEvent(qs) {
  return {
    path: "/attendance",
    httpMethod: "GET",
    queryStringParameters: qs,
    requestContext: {
      authorizer: {
        claims: {
          email: EMAIL,
          "cognito:groups": ["Employee"],
        },
      },
    },
  };
}

function seedRows() {
  return {
    [`${EMAIL}|2026-09-30`]: {
      PK: EMAIL,
      SK: "2026-09-30",
      email: EMAIL,
      date: "2026-09-30",
      status: "Working",
      submittedAt: "2026-09-30T05:30:00.000Z",
      sessionStatus: "Present",
    },
    [`${EMAIL}|2026-10-01`]: {
      PK: EMAIL,
      SK: "2026-10-01",
      email: EMAIL,
      date: "2026-10-01",
      status: "WeeklyOff",
      submittedAt: "2026-10-01T05:30:00.000Z",
    },
    [`${EMAIL}|2026-10-02`]: {
      PK: EMAIL,
      SK: "2026-10-02",
      email: EMAIL,
      date: "2026-10-02",
      status: "PlannedOff",
    },
    [`${EMAIL}|${CLAIM_SK}`]: {
      PK: EMAIL,
      SK: CLAIM_SK,
      email: EMAIL,
      date: "2026-09-30",
      weekStart: WEEK_START,
      weekEnd: "2026-10-04",
      weekOffUsed: 1,
      source: "WeeklyOff",
      createdAt: "2026-09-30T05:30:00.000Z",
    },
  };
}

function createFakeDdb(attendance = {}) {
  const attendanceStore = { ...attendance };
  return {
    attendanceStore,
    send: async (cmd) => {
      const name = cmd.constructor?.name || "";
      const input = cmd.input || {};
      const table = input.TableName;
      if (name === "ScanCommand") {
        if (table === process.env.ATTENDANCE_TABLE) {
          return { Items: Object.values(attendanceStore).filter(Boolean) };
        }
        return { Items: [] };
      }
      if (input.KeyConditionExpression) {
        return { Items: queryStore(attendanceStore, input) };
      }
      if (input.Key) {
        if (table === process.env.USER_PROFILE_TABLE) {
          return { Item: { name: "Pat", empId: "E1" } };
        }
        return {
          Item: attendanceStore[`${input.Key.PK}|${input.Key.SK}`] || null,
        };
      }
      return { Items: [] };
    },
  };
}

function assertNormalAttendance(rows) {
  const byDate = Object.fromEntries(
    rows.map((row) => [String(row.date), row])
  );
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(byDate["2026-09-30"].status, "Working");
  assert.strictEqual(byDate["2026-10-01"].status, "WeeklyOff");
  assert.strictEqual(byDate["2026-10-02"].status, "PlannedOff");
  assert.ok(
    rows.every(
      (row) =>
        !String(row.date || "").startsWith("WEEKOFF#") &&
        String(row.status || "") !== ""
    )
  );
}

(async () => {
  {
    const db = createFakeDdb(seedRows());
    setDocumentClientForTests(db);
    const res = parse(
      await handler(adminEvent({ search: EMAIL, pageSize: "100" }))
    );
    assert.strictEqual(res.statusCode, 200);
    assertNormalAttendance(res.body.items);
    assert.ok(db.attendanceStore[`${EMAIL}|${CLAIM_SK}`]);
    assert.strictEqual(
      db.attendanceStore[`${EMAIL}|${CLAIM_SK}`].SK,
      CLAIM_SK
    );
  }

  {
    const db = createFakeDdb(seedRows());
    setDocumentClientForTests(db);
    const res = parse(await handler(adminEvent({ pageSize: "100" })));
    assert.strictEqual(res.statusCode, 200);
    assertNormalAttendance(res.body.items);
    assert.ok(db.attendanceStore[`${EMAIL}|${CLAIM_SK}`]);
  }

  {
    const db = createFakeDdb(seedRows());
    setDocumentClientForTests(db);
    const res = parse(
      await handler(
        rangeEvent({
          startDate: "2026-09-01",
          endDate: "ZZZ",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.body));
    assertNormalAttendance(res.body);
    assert.ok(db.attendanceStore[`${EMAIL}|${CLAIM_SK}`]);
  }

  console.log("handler.weekOffClaim.test.js ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

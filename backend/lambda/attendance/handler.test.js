process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.ATTENDANCE_TABLE = "Attendance";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.AWS_REGION = "ap-south-1";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const { handler, setDocumentClientForTests } = require("./handler");
const { isSuperAdminRole, normalizeRole, ROLES } = require("../common/roles");

function todayKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function createFakeDdb({ access = {}, attendance = {} } = {}) {
  const puts = [];
  const attendanceStore = { ...attendance };
  return {
    puts,
    attendanceStore,
    send: async (cmd) => {
      const input = cmd.input || {};
      const table = input.TableName;
      if (input.Item) {
        puts.push({ table, item: input.Item });
        attendanceStore[`${input.Item.PK}|${input.Item.SK}`] = { ...input.Item };
        return {};
      }
      if (input.Key) {
        if (table === process.env.USER_ACCESS_TABLE) {
          return { Item: access[input.Key.PK] || null };
        }
        if (table === process.env.USER_PROFILE_TABLE) {
          return { Item: null };
        }
        return {
          Item: attendanceStore[`${input.Key.PK}|${input.Key.SK}`] || null,
        };
      }
      return { Items: [] };
    },
  };
}

function postEvent(email, body, groups = ["Admin"]) {
  return {
    path: "/attendance",
    httpMethod: "POST",
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

assert.strictEqual(isSuperAdminRole("SUPER_ADMIN"), true);
assert.strictEqual(isSuperAdminRole("super_admin"), true);
assert.strictEqual(isSuperAdminRole(ROLES.ADMIN), false);
assert.strictEqual(isSuperAdminRole(ROLES.MANAGER), false);
assert.strictEqual(isSuperAdminRole(ROLES.EMPLOYEE), false);
assert.strictEqual(normalizeRole("USER"), ROLES.EMPLOYEE);
assert.strictEqual(isSuperAdminRole("USER"), false);

(async () => {
{
  const db = createFakeDdb({
    access: {
      "boss@mydgv.com": { role: "SUPER_ADMIN", status: "ACTIVE" },
    },
  });
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      postEvent("boss@mydgv.com", {
        action: "checkIn",
        date: "2026-09-14",
        checkInTime: "2026-09-14T05:30:00.000Z",
      })
    )
  );
  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.error, /SUPER_ADMIN/);
  assert.strictEqual(db.puts.length, 0);
}

{
  const existing = {
    "doer@mydgv.com|2026-09-14": {
      PK: "doer@mydgv.com",
      SK: "2026-09-14",
      email: "doer@mydgv.com",
      date: "2026-09-14",
      checkInTime: "2026-09-14T05:30:00.000Z",
      status: "Working",
      attendanceId: "hist-1",
    },
  };
  const db = createFakeDdb({
    access: {
      "doer@mydgv.com": { role: "SUPER_ADMIN", status: "ACTIVE" },
    },
    attendance: existing,
  });
  setDocumentClientForTests(db);
  const before = { ...db.attendanceStore["doer@mydgv.com|2026-09-14"] };
  const res = parse(
    await handler(
      postEvent("doer@mydgv.com", {
        action: "checkOut",
        date: "2026-09-14",
        checkOutTime: "2026-09-14T14:30:00.000Z",
      })
    )
  );
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(db.puts.length, 0);
  assert.deepStrictEqual(
    db.attendanceStore["doer@mydgv.com|2026-09-14"],
    before
  );
}

{
  const db = createFakeDdb({
    access: {
      "boss@mydgv.com": { role: "SUPER_ADMIN", status: "ACTIVE" },
    },
  });
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      postEvent("boss@mydgv.com", [
        { date: todayKey(), status: "Working", dayType: "Full Day", shift: "Morning Shift" },
      ])
    )
  );
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(db.puts.length, 0);
}

for (const role of ["ADMIN", "MANAGER", "EMPLOYEE"]) {
  const email = `${role.toLowerCase()}@mydgv.com`;
  const db = createFakeDdb({
    access: { [email]: { role, status: "ACTIVE" } },
  });
  setDocumentClientForTests(db);
  const groups = role === "EMPLOYEE" ? ["Employee"] : ["Admin"];
  const res = parse(
    await handler(
      postEvent(
        email,
        {
          action: "checkIn",
          date: "2026-09-14",
          checkInTime: "2026-09-14T05:30:00.000Z",
        },
        groups
      )
    )
  );
  assert.strictEqual(res.statusCode, 200, `${role} check-in should succeed`);
  assert.strictEqual(db.puts.length, 1, `${role} should write attendance`);
  assert.strictEqual(db.puts[0].item.status, "Working");
}

{
  const email = "manager@mydgv.com";
  const db = createFakeDdb({
    access: { [email]: { role: "MANAGER", status: "ACTIVE" } },
  });
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      postEvent(email, [
        {
          date: todayKey(),
          status: "WeeklyOff",
        },
      ])
    )
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.puts.length, 1);
  assert.strictEqual(db.puts[0].item.status, "WeeklyOff");
  assert.ok(db.puts[0].item.submittedAt);
}

console.log("attendance handler exemption tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

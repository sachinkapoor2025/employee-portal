process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.ATTENDANCE_TABLE = "Attendance";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.AWS_REGION = "ap-south-1";

const assert = require("assert");
const {
  applyAttendanceStatus,
  setDocumentClientForTests,
} = require("./handler");

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

(async () => {
{
  const historical = {
    "boss@mydgv.com|2026-09-10": {
      PK: "boss@mydgv.com",
      SK: "2026-09-10",
      email: "boss@mydgv.com",
      date: "2026-09-10",
      status: "Working",
      attendanceId: "keep-me",
      checkInTime: "2026-09-10T05:30:00.000Z",
    },
  };
  const db = createFakeDdb({
    access: { "boss@mydgv.com": { role: "SUPER_ADMIN", status: "ACTIVE" } },
    attendance: historical,
  });
  setDocumentClientForTests(db);
  await applyAttendanceStatus(
    "boss@mydgv.com",
    "2026-09-14",
    "2026-09-14",
    "Leave"
  );
  assert.strictEqual(db.puts.length, 0);
  assert.strictEqual(
    db.attendanceStore["boss@mydgv.com|2026-09-10"].attendanceId,
    "keep-me"
  );
}

{
  const db = createFakeDdb({
    access: { "boss@mydgv.com": { role: "SUPER_ADMIN", status: "ACTIVE" } },
  });
  setDocumentClientForTests(db);
  await applyAttendanceStatus(
    "boss@mydgv.com",
    "2026-09-15",
    "2026-09-16",
    "PlannedOff"
  );
  assert.strictEqual(db.puts.length, 0);
}

for (const role of ["ADMIN", "MANAGER", "EMPLOYEE"]) {
  const email = `${role.toLowerCase()}@mydgv.com`;
  const db = createFakeDdb({
    access: { [email]: { role, status: "ACTIVE" } },
  });
  setDocumentClientForTests(db);
  await applyAttendanceStatus(email, "2026-09-14", "2026-09-14", "Leave");
  assert.strictEqual(db.puts.length, 1, `${role} leave should write attendance`);
  assert.strictEqual(db.puts[0].item.status, "Leave");
  assert.strictEqual(db.puts[0].item.email, email);
}

{
  const email = "worker@mydgv.com";
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  setDocumentClientForTests(db);
  await applyAttendanceStatus(email, "2026-09-20", "2026-09-20", "PlannedOff");
  assert.strictEqual(db.puts.length, 1);
  assert.strictEqual(db.puts[0].item.status, "PlannedOff");
}

console.log("leave attendance exemption tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

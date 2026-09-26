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
const { companyDateTimeIso } = require("../common/shiftWindows");
const {
  handler,
  resolveApplicableLeaveShiftWindow,
  setDocumentClientForTests,
  setNowMsForTests,
} = require("./handler");

const EMAIL = "worker@mydgv.com";
const TODAY = "2026-09-23";
const TOMORROW = "2026-09-24";

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

function createFakeDdb({ access = {}, work = {} } = {}) {
  const puts = [];
  const workStore = { ...work };
  return {
    puts,
    workStore,
    send: async (cmd) => {
      const input = cmd.input || {};
      const table = input.TableName;
      if (input.Item) {
        puts.push({ table, item: input.Item });
        workStore[`${input.Item.PK}|${input.Item.SK}`] = { ...input.Item };
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

function leaveBody(fromDate, extra = {}) {
  return {
    category: "LEAVE",
    type: "CASUAL",
    fromDate,
    toDate: extra.toDate || fromDate,
    startDate: fromDate,
    endDate: extra.toDate || fromDate,
    reason: "Need time off",
    ...extra,
  };
}

{
  const at0100 = new Date("2026-09-24T01:00:00+05:30");
  const w1 = resolveApplicableLeaveShiftWindow(overnight, at0100);
  assert.strictEqual(w1.shiftDateKey, "2026-09-23");
  assert.strictEqual(w1.startIso, companyDateTimeIso("2026-09-23", "22:00"));
  assert.strictEqual(w1.endIso, companyDateTimeIso("2026-09-24", "06:00"));
}

{
  const at0559 = new Date("2026-09-24T05:59:00+05:30");
  const w2 = resolveApplicableLeaveShiftWindow(overnight, at0559);
  assert.strictEqual(w2.shiftDateKey, "2026-09-23");
  assert.strictEqual(w2.startIso, companyDateTimeIso("2026-09-23", "22:00"));
}

{
  const at2200 = new Date("2026-09-24T22:00:00+05:30");
  const w3 = resolveApplicableLeaveShiftWindow(overnight, at2200);
  assert.strictEqual(w3.shiftDateKey, "2026-09-24");
  assert.strictEqual(w3.startIso, companyDateTimeIso("2026-09-24", "22:00"));
  assert.strictEqual(w3.endIso, companyDateTimeIso("2026-09-25", "06:00"));
}

(async () => {
{
  freeze("2026-09-23T10:59:00+05:30");
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedShift(db, morning);
  setDocumentClientForTests(db);
  const res = parse(await handler(eventFor("POST", EMAIL, leaveBody(TODAY))));
  assert.strictEqual(res.statusCode, 201, res.body.error);
  assert.strictEqual(res.body.status, "PENDING_APPROVAL");
  assert.strictEqual(res.body.fromDate, TODAY);
}

{
  freeze("2026-09-23T11:00:00+05:30");
  const db = createFakeDdb();
  seedShift(db, morning);
  setDocumentClientForTests(db);
  const res = parse(await handler(eventFor("POST", EMAIL, leaveBody(TODAY))));
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error || "", /before your assigned shift starts/i);
}

{
  freeze("2026-09-23T11:30:00+05:30");
  const db = createFakeDdb();
  seedShift(db, morning);
  setDocumentClientForTests(db);
  const res = parse(await handler(eventFor("POST", EMAIL, leaveBody(TODAY))));
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error || "", /before your assigned shift starts/i);
}

{
  freeze("2026-09-23T10:59:00+05:30");
  const db = createFakeDdb();
  setDocumentClientForTests(db);
  const res = parse(await handler(eventFor("POST", EMAIL, leaveBody(TODAY))));
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error || "", /assigned shift/i);
}

{
  freeze("2026-09-24T01:00:00+05:30");
  const db = createFakeDdb();
  seedShift(db, overnight);
  setDocumentClientForTests(db);
  const res = parse(await handler(eventFor("POST", EMAIL, leaveBody(TOMORROW))));
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error || "", /before your assigned shift starts/i);
}

{
  freeze("2026-09-24T05:59:00+05:30");
  const db = createFakeDdb();
  seedShift(db, overnight);
  setDocumentClientForTests(db);
  const res = parse(await handler(eventFor("POST", EMAIL, leaveBody(TOMORROW))));
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error || "", /before your assigned shift starts/i);
}

{
  freeze("2026-09-24T21:59:00+05:30");
  const db = createFakeDdb();
  seedShift(db, overnight);
  setDocumentClientForTests(db);
  const res = parse(await handler(eventFor("POST", EMAIL, leaveBody(TOMORROW))));
  assert.strictEqual(res.statusCode, 201, res.body.error);
}

{
  freeze("2026-09-24T22:00:00+05:30");
  const db = createFakeDdb();
  seedShift(db, overnight);
  setDocumentClientForTests(db);
  const res = parse(await handler(eventFor("POST", EMAIL, leaveBody(TOMORROW))));
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error || "", /before your assigned shift starts/i);
}

{
  freeze("2026-09-23T11:30:00+05:30");
  const db = createFakeDdb();
  setDocumentClientForTests(db);
  const res = parse(await handler(eventFor("POST", EMAIL, leaveBody(TOMORROW))));
  assert.strictEqual(res.statusCode, 201, res.body.error);
  assert.strictEqual(res.body.fromDate, TOMORROW);
}

{
  freeze("2026-09-23T10:59:00+05:30");
  const db = createFakeDdb({
    access: { [EMAIL]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  seedShift(db, morning);
  seedLeave(db, {
    leaveId: "cancel-before",
    email: EMAIL,
    category: "LEAVE",
    type: "CASUAL",
    fromDate: TODAY,
    toDate: TODAY,
    status: "APPROVED",
    approvedBy: "boss@mydgv.com",
    approvedAt: "2026-09-22T05:00:00.000Z",
  });
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("PUT", EMAIL, { leaveId: "cancel-before", status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(res.body.status, "CANCELLED");
  assert.strictEqual(res.body.approvedBy, "boss@mydgv.com");
  const last = res.body.statusHistory[res.body.statusHistory.length - 1];
  assert.strictEqual(last.status, "CANCELLED");
  assert.strictEqual(last.previousStatus, "APPROVED");
}

{
  freeze("2026-09-23T11:00:00+05:30");
  const db = createFakeDdb();
  seedShift(db, morning);
  seedLeave(db, {
    leaveId: "cancel-at-start",
    email: EMAIL,
    category: "LEAVE",
    type: "CASUAL",
    fromDate: TODAY,
    toDate: TODAY,
    status: "APPROVED",
    approvedBy: "boss@mydgv.com",
    approvedAt: "2026-09-22T05:00:00.000Z",
  });
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("PUT", EMAIL, { leaveId: "cancel-at-start", status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error || "", /started/i);
}

{
  freeze("2026-09-23T11:30:00+05:30");
  const db = createFakeDdb();
  seedLeave(db, {
    leaveId: "future-cancel",
    email: EMAIL,
    category: "LEAVE",
    type: "CASUAL",
    fromDate: TOMORROW,
    toDate: TOMORROW,
    status: "APPROVED",
    approvedBy: "boss@mydgv.com",
    approvedAt: "2026-09-22T05:00:00.000Z",
  });
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      eventFor("PUT", EMAIL, { leaveId: "future-cancel", status: "CANCELLED" })
    )
  );
  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(res.body.status, "CANCELLED");
}

setNowMsForTests(null);
console.log("leave same-day shift cutoff tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

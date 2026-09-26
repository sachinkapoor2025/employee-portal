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
const { isSuperAdminRole, normalizeRole, ROLES } = require("../common/roles");
const { TIME_SOURCE_EXPECTED_WINDOW, TIMING_STATUS } = require("./assignedShift");
const { companyDateTimeIso } = require("../common/shiftWindows");

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

function createFakeDdb({ access = {}, attendance = {}, work = {} } = {}) {
  const puts = [];
  const attendanceStore = { ...attendance };
  const workStore = { ...work };
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
        if (table === process.env.WORK_TABLE) {
          return { Item: workStore[`${input.Key.PK}|${input.Key.SK}`] || null };
        }
        return {
          Item: attendanceStore[`${input.Key.PK}|${input.Key.SK}`] || null,
        };
      }
      return { Items: [] };
    },
  };
}

function morningAssignment(email) {
  return {
    [`USER#${email}|SHIFT#CURRENT`]: {
      PK: `USER#${email}`,
      SK: "SHIFT#CURRENT",
      shiftId: "morning",
      name: "Morning Shift",
      startTime: "11:00",
      endTime: "20:00",
      graceMinutes: 15,
      crossesMidnight: false,
    },
  };
}

function splitAssignment(email, extra = {}) {
  return {
    [`USER#${email}|SHIFT#CURRENT`]: {
      PK: `USER#${email}`,
      SK: "SHIFT#CURRENT",
      shiftId: "morning",
      name: "Morning Shift",
      startTime: "11:00",
      endTime: "20:00",
      graceMinutes: 15,
      crossesMidnight: false,
      halfDayEnabled: true,
      firstHalf: { startTime: "11:00", endTime: "15:30", graceMinutes: 10 },
      secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 20 },
      ...extra,
    },
  };
}

function overnightSplitAssignment(email) {
  return {
    [`USER#${email}|SHIFT#CURRENT`]: {
      PK: `USER#${email}`,
      SK: "SHIFT#CURRENT",
      shiftId: "night",
      name: "Night Shift",
      startTime: "22:00",
      endTime: "06:00",
      graceMinutes: 10,
      crossesMidnight: true,
      halfDayEnabled: true,
      firstHalf: { startTime: "22:00", endTime: "02:00", graceMinutes: 8 },
      secondHalf: { startTime: "02:00", endTime: "06:00", graceMinutes: 12 },
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
          date: todayKey(),
        },
        groups
      )
    )
  );
  assert.strictEqual(res.statusCode, 400, `${role} check-in requires Working attendance`);
  assert.match(res.body.error, /Submit Working attendance/);
  assert.strictEqual(db.puts.length, 0, `${role} should not punch without Working`);
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

{
  const email = "worker@mydgv.com";
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
  });
  setDocumentClientForTests(db);
  const res = parse(
    await handler(
      postEvent(
        email,
        [
          {
            date: todayKey(),
            status: "Working",
            dayType: "Full Day",
            shift: "Evening Shift",
          },
        ],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /No shift is assigned/);
  assert.strictEqual(db.puts.length, 0);
}

{
  const email = "worker@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: morningAssignment(email),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T11:20:00+05:30`));
  const res = parse(
    await handler(
      postEvent(
        email,
        [
          {
            date,
            status: "Working",
            dayType: "Full Day",
            shift: "Evening Shift",
          },
        ],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(res.statusCode, 200);
  const item = db.puts[0].item;
  assert.strictEqual(item.shiftId, "morning");
  assert.strictEqual(item.shiftName, "Morning Shift");
  assert.strictEqual(item.shift, "Morning Shift");
  assert.strictEqual(item.dayType, "Full Day");
  assert.strictEqual(item.workPeriod, "FULL_DAY");
  assert.strictEqual(item.timeSource, TIME_SOURCE_EXPECTED_WINDOW);
  assert.strictEqual(item.timingStatus, TIMING_STATUS.LATE);
  assert.strictEqual(item.lateMinutes, 20);
  assert.strictEqual(item.graceMinutes, 15);
  assert.strictEqual(item.crossesMidnight, false);
  assert.strictEqual(item.checkInTime, companyDateTimeIso(date, "11:00"));
  assert.strictEqual(item.checkOutTime, companyDateTimeIso(date, "20:00"));
  assert.strictEqual(item.expectedStartTime, item.checkInTime);
  assert.strictEqual(item.expectedEndTime, item.checkOutTime);
  assert.ok(item.submittedAt);
  assert.ok(item.attendanceSubmittedAt);
}

{
  const email = "early@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: morningAssignment(email),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T10:45:00+05:30`));
  const res = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "FULL_DAY" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.puts[0].item.timingStatus, TIMING_STATUS.BEFORE_SHIFT);
  assert.strictEqual(db.puts[0].item.lateMinutes, 0);
}

{
  const email = "grace@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: morningAssignment(email),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T11:15:00+05:30`));
  const res = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", dayType: "Half Day" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /First Half/);
  assert.strictEqual(db.puts.length, 0);
}

{
  const email = "puncher@mydgv.com";
  const date = todayKey();
  const historicalKey = `${email}|2026-01-01`;
  const historical = {
    PK: email,
    SK: "2026-01-01",
    email,
    date: "2026-01-01",
    status: "Working",
    checkInTime: "2026-01-01T05:30:00.000Z",
    checkOutTime: "2026-01-01T14:30:00.000Z",
    submittedAt: "2026-01-01T05:40:00.000Z",
  };
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: morningAssignment(email),
    attendance: { [historicalKey]: historical },
  });
  setDocumentClientForTests(db);
  const groups = ["Employee"];

  setNowMsForTests(() => Date.parse(`${date}T11:20:00+05:30`));
  const submitted = parse(
    await handler(
      postEvent(email, [{ date, status: "Working", workPeriod: "FULL_DAY" }], groups)
    )
  );
  assert.strictEqual(submitted.statusCode, 200);
  const afterSubmit = db.attendanceStore[`${email}|${date}`];
  const expectedIn = afterSubmit.checkInTime;
  const expectedOut = afterSubmit.checkOutTime;
  const hoursAfterSubmit = afterSubmit.hours;

  const clientStamp = "2000-01-01T00:00:00.000Z";
  const checkedIn = parse(
    await handler(
      postEvent(
        email,
        { action: "checkIn", date, checkInTime: clientStamp },
        groups
      )
    )
  );
  assert.strictEqual(checkedIn.statusCode, 200);
  const afterIn = db.attendanceStore[`${email}|${date}`];
  const serverIn = new Date(Date.parse(`${date}T11:20:00+05:30`)).toISOString();
  assert.strictEqual(afterIn.actualCheckInTime, serverIn);
  assert.notStrictEqual(afterIn.actualCheckInTime, clientStamp);
  assert.strictEqual(afterIn.checkInTime, expectedIn);
  assert.strictEqual(afterIn.expectedStartTime, expectedIn);
  assert.strictEqual(afterIn.submittedAt, afterSubmit.submittedAt);
  assert.strictEqual(afterIn.sessionStatus, "Active");

  const duplicateIn = parse(
    await handler(postEvent(email, { action: "checkIn", date }, groups))
  );
  assert.strictEqual(duplicateIn.statusCode, 200);
  assert.strictEqual(duplicateIn.body.message, "Already checked in");
  assert.strictEqual(
    db.attendanceStore[`${email}|${date}`].actualCheckInTime,
    serverIn
  );

  setNowMsForTests(() => Date.parse(`${date}T20:30:00+05:30`));
  const beyond = parse(
    await handler(
      postEvent(
        email,
        {
          action: "checkOut",
          date,
          checkOutTime: clientStamp,
          workedBeyondReason: "Finished a client call",
        },
        groups
      )
    )
  );
  assert.strictEqual(beyond.statusCode, 200);
  const afterBeyond = db.attendanceStore[`${email}|${date}`];
  const serverOut = new Date(Date.parse(`${date}T20:30:00+05:30`)).toISOString();
  assert.strictEqual(afterBeyond.actualCheckOutTime, serverOut);
  assert.notStrictEqual(afterBeyond.actualCheckOutTime, clientStamp);
  assert.strictEqual(afterBeyond.checkOutTime, expectedOut);
  assert.strictEqual(afterBeyond.expectedEndTime, expectedOut);
  assert.strictEqual(afterBeyond.workedBeyondShift, true);
  assert.strictEqual(afterBeyond.workedBeyondReason, "Finished a client call");
  assert.strictEqual(afterBeyond.reason, afterSubmit.reason);
  assert.strictEqual(afterBeyond.hours, hoursAfterSubmit);
  assert.ok(afterBeyond.submittedAt);

  const duplicateOut = parse(
    await handler(postEvent(email, { action: "checkOut", date }, groups))
  );
  assert.strictEqual(duplicateOut.statusCode, 200);
  assert.strictEqual(duplicateOut.body.message, "Already checked out");
  assert.strictEqual(
    db.attendanceStore[`${email}|${date}`].actualCheckOutTime,
    serverOut
  );
  assert.deepStrictEqual(db.attendanceStore[historicalKey], historical);
}

{
  const email = "ontime@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: morningAssignment(email),
  });
  setDocumentClientForTests(db);
  const groups = ["Employee"];
  setNowMsForTests(() => Date.parse(`${date}T11:20:00+05:30`));
  assert.strictEqual(
    (
      await handler(
        postEvent(email, [{ date, status: "Working", workPeriod: "FULL_DAY" }], groups)
      ).then(parse)
    ).statusCode,
    200
  );
  assert.strictEqual(
    (await handler(postEvent(email, { action: "checkIn", date }, groups)).then(parse))
      .statusCode,
    200
  );
  setNowMsForTests(() => Date.parse(`${date}T19:00:00+05:30`));
  const within = parse(
    await handler(
      postEvent(
        email,
        { action: "checkOut", date, workedBeyondReason: "should be ignored" },
        groups
      )
    )
  );
  assert.strictEqual(within.statusCode, 200);
  const row = db.attendanceStore[`${email}|${date}`];
  assert.strictEqual(row.workedBeyondShift, false);
  assert.strictEqual(row.workedBeyondReason, null);
}

{
  const email = "offday@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: morningAssignment(email),
  });
  setDocumentClientForTests(db);
  const groups = ["Employee"];
  for (const status of ["Leave", "Holiday", "WeeklyOff"]) {
    setNowMsForTests(() => Date.parse(`${date}T11:20:00+05:30`));
    const saved = parse(
      await handler(postEvent(email, [{ date, status }], groups))
    );
    assert.strictEqual(saved.statusCode, 200, `${status} submit`);
    const punch = parse(
      await handler(postEvent(email, { action: "checkIn", date }, groups))
    );
    assert.strictEqual(punch.statusCode, 400, `${status} cannot check in`);
    assert.match(punch.body.error, /Working attendance/);
    const out = parse(
      await handler(postEvent(email, { action: "checkOut", date }, groups))
    );
    assert.strictEqual(out.statusCode, 400, `${status} cannot check out`);
    db.attendanceStore[`${email}|${date}`] = undefined;
  }
}

{
  const email = "legacyhalf@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: morningAssignment(email),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T11:20:00+05:30`));
  for (const workPeriod of ["FIRST_HALF", "SECOND_HALF"]) {
    const res = parse(
      await handler(
        postEvent(email, [{ date, status: "Working", workPeriod }], ["Employee"])
      )
    );
    assert.strictEqual(res.statusCode, 400, workPeriod);
    assert.strictEqual(db.puts.length, 0, workPeriod);
  }
  const full = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "FULL_DAY" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(full.statusCode, 200);
  assert.strictEqual(full.body.attendance.workPeriod, "FULL_DAY");
}

{
  const email = "offhalf@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: splitAssignment(email, { halfDayEnabled: false }),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T11:20:00+05:30`));
  const first = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "FIRST_HALF" }],
        ["Employee"]
      )
    )
  );
  const second = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "SECOND_HALF" }],
        ["Employee"]
      )
    )
  );
  const alias = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", dayType: "Half Day" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(first.statusCode, 400);
  assert.strictEqual(second.statusCode, 400);
  assert.strictEqual(alias.statusCode, 400);
  assert.strictEqual(db.puts.length, 0);
  const full = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "FULL_DAY" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(full.statusCode, 200);
  assert.strictEqual(db.puts[0].item.workPeriod, "FULL_DAY");
  assert.strictEqual(db.puts[0].item.expectedStartTime, companyDateTimeIso(date, "11:00"));
  assert.strictEqual(db.puts[0].item.expectedEndTime, companyDateTimeIso(date, "20:00"));
}

{
  const email = "splithalf@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: splitAssignment(email),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T10:50:00+05:30`));
  const before = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "FIRST_HALF" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(before.statusCode, 200);
  assert.strictEqual(before.body.attendance.workPeriod, "FIRST_HALF");
  assert.strictEqual(before.body.attendance.timingStatus, TIMING_STATUS.BEFORE_SHIFT);
  assert.strictEqual(before.body.attendance.lateMinutes, 0);
  assert.strictEqual(before.body.attendance.graceMinutes, 10);
  assert.strictEqual(
    before.body.attendance.expectedStartTime,
    companyDateTimeIso(date, "11:00")
  );
  assert.strictEqual(
    before.body.attendance.expectedEndTime,
    companyDateTimeIso(date, "15:30")
  );
}

{
  const email = "firstgrace@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: splitAssignment(email),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T11:10:00+05:30`));
  const res = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "FIRST_HALF" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.attendance.timingStatus, TIMING_STATUS.WITHIN_GRACE);
  assert.strictEqual(res.body.attendance.lateMinutes, 10);
  assert.strictEqual(res.body.attendance.graceMinutes, 10);
}

{
  const email = "firstlate@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: splitAssignment(email),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T11:11:00+05:30`));
  const res = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "FIRST_HALF" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.attendance.timingStatus, TIMING_STATUS.LATE);
  assert.strictEqual(res.body.attendance.lateMinutes, 11);
}

{
  const email = "secondlate@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: splitAssignment(email),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T15:51:00+05:30`));
  const res = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "SECOND_HALF" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.attendance.workPeriod, "SECOND_HALF");
  assert.strictEqual(res.body.attendance.timingStatus, TIMING_STATUS.LATE);
  assert.strictEqual(res.body.attendance.lateMinutes, 21);
  assert.strictEqual(res.body.attendance.graceMinutes, 20);
  assert.strictEqual(
    res.body.attendance.expectedStartTime,
    companyDateTimeIso(date, "15:30")
  );
  assert.strictEqual(
    res.body.attendance.expectedEndTime,
    companyDateTimeIso(date, "20:00")
  );
}

{
  const email = "aliason@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: splitAssignment(email),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T11:00:00+05:30`));
  const res = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", dayType: "Half Day" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.attendance.workPeriod, "FIRST_HALF");
  assert.strictEqual(res.body.attendance.dayType, "Half Day");
  assert.strictEqual(res.body.attendance.graceMinutes, 10);
}

{
  const email = "nighthalf@mydgv.com";
  const date = todayKey();
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work: overnightSplitAssignment(email),
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T01:00:00+05:30`));
  const res = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "SECOND_HALF" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(
    res.body.attendance.expectedStartTime,
    companyDateTimeIso(date, "02:00")
  );
  assert.strictEqual(
    res.body.attendance.expectedEndTime,
    companyDateTimeIso(date, "06:00")
  );
  assert.strictEqual(res.body.attendance.workPeriod, "SECOND_HALF");
  assert.strictEqual(res.body.attendance.timingStatus, TIMING_STATUS.BEFORE_SHIFT);
  assert.strictEqual(res.body.attendance.graceMinutes, 12);
  assert.strictEqual(res.body.attendance.crossesMidnight, true);
}

{
  const email = "frozen@mydgv.com";
  const date = todayKey();
  const work = splitAssignment(email);
  const db = createFakeDdb({
    access: { [email]: { role: "EMPLOYEE", status: "ACTIVE" } },
    work,
  });
  setDocumentClientForTests(db);
  setNowMsForTests(() => Date.parse(`${date}T11:11:00+05:30`));
  const saved = parse(
    await handler(
      postEvent(
        email,
        [{ date, status: "Working", workPeriod: "FIRST_HALF" }],
        ["Employee"]
      )
    )
  );
  assert.strictEqual(saved.statusCode, 200);
  const storedStart = db.puts[0].item.expectedStartTime;
  const storedEnd = db.puts[0].item.expectedEndTime;
  const storedGrace = db.puts[0].item.graceMinutes;
  work[`USER#${email}|SHIFT#CURRENT`].firstHalf = {
    startTime: "11:00",
    endTime: "14:00",
    graceMinutes: 0,
  };
  work[`USER#${email}|SHIFT#CURRENT`].startTime = "10:00";
  const frozen = db.attendanceStore[`${email}|${date}`];
  assert.strictEqual(frozen.expectedStartTime, storedStart);
  assert.strictEqual(frozen.expectedEndTime, storedEnd);
  assert.strictEqual(frozen.graceMinutes, storedGrace);
  assert.strictEqual(frozen.expectedEndTime, companyDateTimeIso(date, "15:30"));
  assert.notStrictEqual(frozen.expectedEndTime, companyDateTimeIso(date, "14:00"));
}

setNowMsForTests();
console.log("attendance handler exemption tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

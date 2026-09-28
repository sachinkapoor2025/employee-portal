process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.WORK_TABLE = "work-table";
process.env.ATTENDANCE_TABLE = "attendance-table";

const assert = require("assert");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { ASSIGNED_SHIFT_FIT } = require("./assignedShiftFit");
const { planAssignmentSchedule } = require("./assignmentPlan");

const EMAIL = "mohammad.ashaz@mydgv.com";
const WORK = process.env.WORK_TABLE;
const ATTENDANCE = process.env.ATTENDANCE_TABLE;
const afternoon = {
  shiftId: "afternoon",
  name: "Afternoon Shift",
  startTime: "14:00",
  endTime: "19:00",
  crossesMidnight: false,
};

function createDdb(shift, attendanceRows = []) {
  const items = [];
  if (shift) {
    items.push({
      TableName: WORK,
      Item: {
        PK: `USER#${EMAIL}`,
        SK: "SHIFT#CURRENT",
        ...shift,
      },
    });
  }
  for (const row of attendanceRows) {
    items.push({
      TableName: ATTENDANCE,
      Item: {
        PK: EMAIL,
        SK: row.date,
        email: EMAIL,
        date: row.date,
        status: row.status,
      },
    });
  }
  return {
    send: async (cmd) => {
      assert.ok(cmd instanceof GetCommand);
      const found = items.find(
        (row) =>
          row.TableName === cmd.input.TableName &&
          row.Item.PK === cmd.input.Key.PK &&
          row.Item.SK === cmd.input.Key.SK
      );
      return { Item: found ? { ...found.Item } : undefined };
    },
  };
}

function sameInstant(actual, expected) {
  assert.strictEqual(Date.parse(actual), Date.parse(expected));
}

async function plan(ddb, start, due, extra = {}) {
  return planAssignmentSchedule({
    ddb,
    tableName: WORK,
    attendanceTable: ATTENDANCE,
    emails: [EMAIL],
    startDate: start,
    dueDate: due,
    ...extra,
  });
}

(async () => {
  const withShift = createDdb(afternoon);

  const sameDayFit = await plan(
    withShift,
    "2026-09-28T16:00:00+05:30",
    "2026-09-28T18:00:00+05:30"
  );
  assert.strictEqual(sameDayFit.ok, true);
  assert.strictEqual(sameDayFit.postponementCount, 0);

  const sameDayConflict = await plan(
    withShift,
    "2026-09-28T18:00:00+05:30",
    "2026-09-28T20:00:00+05:30"
  );
  assert.strictEqual(sameDayConflict.ok, false);
  assert.strictEqual(sameDayConflict.conflicts[0].result, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);

  const multiFit = await plan(
    withShift,
    "2026-09-28T16:00:00+05:30",
    "2026-09-30T19:00:00+05:30"
  );
  assert.strictEqual(multiFit.ok, true);

  const multiStart = await plan(
    withShift,
    "2026-09-28T11:00:00+05:30",
    "2026-09-30T19:00:00+05:30"
  );
  assert.strictEqual(multiStart.ok, false);

  const multiDue = await plan(
    withShift,
    "2026-09-28T16:00:00+05:30",
    "2026-09-30T20:00:00+05:30"
  );
  assert.strictEqual(multiDue.ok, false);

  const productionConflict = await plan(
    withShift,
    "2026-09-28T11:00:00+05:30",
    "2026-09-30T20:00:00+05:30"
  );
  assert.strictEqual(productionConflict.ok, false);
  assert.strictEqual(
    productionConflict.conflicts[0].result,
    ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT
  );

  const overnight = await plan(
    createDdb({
      shiftId: "night",
      name: "Night Shift",
      startTime: "22:00",
      endTime: "06:00",
      crossesMidnight: true,
    }),
    "2026-09-23T23:00:00+05:30",
    "2026-09-24T02:00:00+05:30"
  );
  assert.strictEqual(overnight.ok, true);

  const noShift = await plan(
    createDdb(null),
    "2026-09-28T16:00:00+05:30",
    "2026-09-28T18:00:00+05:30"
  );
  assert.strictEqual(noShift.ok, false);
  assert.strictEqual(noShift.conflicts[0].result, ASSIGNED_SHIFT_FIT.NO_SHIFT);

  const oneWeekOff = await plan(
    createDdb(afternoon, [{ date: "2026-09-28", status: "Week Off" }]),
    "2026-09-28T16:00:00+05:30",
    "2026-09-30T19:00:00+05:30"
  );
  assert.strictEqual(oneWeekOff.ok, true);
  assert.strictEqual(oneWeekOff.postponementCount, 1);
  sameInstant(oneWeekOff.startDate, "2026-09-29T16:00:00+05:30");
  sameInstant(oneWeekOff.dueDate, "2026-10-01T19:00:00+05:30");
  assert.ok(oneWeekOff.reasons.includes("WEEKLY_OFF"));

  const consecutiveWeekOff = await plan(
    createDdb(afternoon, [
      { date: "2026-09-28", status: "WeeklyOff" },
      { date: "2026-09-29", status: "Week Off" },
    ]),
    "2026-09-28T16:00:00+05:30",
    "2026-09-30T19:00:00+05:30"
  );
  assert.strictEqual(consecutiveWeekOff.ok, true);
  assert.strictEqual(consecutiveWeekOff.postponementCount, 2);
  sameInstant(consecutiveWeekOff.startDate, "2026-09-30T16:00:00+05:30");

  const oneLeave = await plan(
    createDdb(afternoon, [{ date: "2026-09-28", status: "Leave" }]),
    "2026-09-28T16:00:00+05:30",
    "2026-09-30T19:00:00+05:30"
  );
  assert.strictEqual(oneLeave.ok, true);
  assert.strictEqual(oneLeave.postponementCount, 1);
  assert.ok(oneLeave.reasons.includes("LEAVE"));
  sameInstant(oneLeave.startDate, "2026-09-29T16:00:00+05:30");

  const consecutiveLeave = await plan(
    createDdb(afternoon, [
      { date: "2026-09-28", status: "Leave" },
      { date: "2026-09-29", status: "Leave" },
    ]),
    "2026-09-28T16:00:00+05:30",
    "2026-09-30T19:00:00+05:30"
  );
  assert.strictEqual(consecutiveLeave.ok, true);
  assert.strictEqual(consecutiveLeave.postponementCount, 2);

  const mixed = await plan(
    createDdb(afternoon, [
      { date: "2026-09-29", status: "Week Off" },
      { date: "2026-09-30", status: "Leave" },
      { date: "2026-10-01", status: "WeeklyOff" },
    ]),
    "2026-09-29T16:00:00+05:30",
    "2026-10-02T19:00:00+05:30"
  );
  assert.strictEqual(mixed.ok, true);
  assert.strictEqual(mixed.postponementCount, 3);
  sameInstant(mixed.startDate, "2026-10-02T16:00:00+05:30");
  sameInstant(mixed.dueDate, "2026-10-05T19:00:00+05:30");

  const conflictAfterPostpone = await plan(
    createDdb(afternoon, [{ date: "2026-09-28", status: "Week Off" }]),
    "2026-09-28T18:00:00+05:30",
    "2026-09-28T20:00:00+05:30"
  );
  assert.strictEqual(conflictAfterPostpone.ok, false);
  assert.strictEqual(conflictAfterPostpone.postponementCount, 1);
  assert.strictEqual(
    conflictAfterPostpone.conflicts[0].result,
    ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT
  );

  console.log("assignmentPlan tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

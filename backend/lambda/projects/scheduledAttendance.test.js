process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const {
  ACTION_ASSIGN,
  ACTION_POSTPONE,
  REASON_NOT_MARKED,
  REASON_WORKING,
  REASON_LEAVE,
  REASON_PLANNED_OFF,
  REASON_HOLIDAY,
  REASON_WEEKLY_OFF,
  REASON_ABSENT,
  REASON_OUTSIDE_SHIFT,
  decideScheduledAttendance,
  isSameDayTask,
  loadAttendanceRecord,
  nextScheduleFields,
  taskEvaluationRange,
  attendanceDateKeyForTask,
} = require("./scheduledAttendance");
const { parseInstantMs } = require("../common/shiftWindows");

const DATE = "2026-09-22";
const HALF_MORNING = {
  status: "Working",
  dayType: "Half Day",
  shift: "Morning Shift",
  date: DATE,
  SK: DATE,
};
const FULL_MORNING = {
  status: "Working",
  dayType: "Full Day",
  shift: "Morning Shift",
  date: DATE,
  SK: DATE,
};
const FULL_EVENING = {
  status: "Working",
  dayType: "Full Day",
  shift: "Evening Shift",
  date: DATE,
  SK: DATE,
};

function range(start, end) {
  return {
    taskStartMs: parseInstantMs(start),
    taskEndMs: parseInstantMs(end),
    dateKey: DATE,
  };
}

function decide(record, start, end) {
  return decideScheduledAttendance({
    record,
    ...range(start, end),
  });
}

assert.strictEqual(
  isSameDayTask(
    parseInstantMs("2026-09-22T11:30:00+05:30"),
    parseInstantMs("2026-09-22T20:00:00+05:30")
  ),
  true
);
assert.strictEqual(
  isSameDayTask(
    parseInstantMs("2026-09-22T11:30:00+05:30"),
    parseInstantMs("2026-10-03T18:00:00+05:30")
  ),
  false
);

assert.deepStrictEqual(decide(null, "2026-09-22T14:00:00+05:30", "2026-09-22T14:30:00+05:30"), {
  action: ACTION_ASSIGN,
  reason: REASON_NOT_MARKED,
  attendanceStatus: "NOT_MARKED",
});
assert.strictEqual(
  decide(null, "2026-09-22T11:30:00+05:30", "2026-10-03T18:00:00+05:30").action,
  ACTION_ASSIGN
);

assert.strictEqual(
  decide(FULL_MORNING, "2026-09-22T11:30:00+05:30", "2026-10-03T18:00:00+05:30").action,
  ACTION_ASSIGN
);
assert.strictEqual(
  decide(FULL_MORNING, "2026-09-22T11:30:00+05:30", "2026-10-03T18:00:00+05:30").reason,
  REASON_WORKING
);
assert.strictEqual(
  decide(FULL_MORNING, "2026-09-22T19:45:00+05:30", "2026-10-03T18:00:00+05:30").action,
  ACTION_ASSIGN
);

assert.strictEqual(
  decide(FULL_MORNING, "2026-09-22T11:00:00+05:30", "2026-09-22T20:00:00+05:30").reason,
  REASON_WORKING
);
assert.strictEqual(
  decide(HALF_MORNING, "2026-09-22T14:00:00+05:30", "2026-09-22T14:30:00+05:30").action,
  ACTION_ASSIGN
);
assert.strictEqual(
  decide(HALF_MORNING, "2026-09-22T12:00:00+05:30", "2026-09-22T12:30:00+05:30").action,
  ACTION_ASSIGN
);
assert.strictEqual(
  decide(HALF_MORNING, "2026-09-22T15:15:00+05:30", "2026-09-22T15:45:00+05:30").reason,
  REASON_OUTSIDE_SHIFT
);
assert.strictEqual(
  decide(HALF_MORNING, "2026-09-22T10:30:00+05:30", "2026-09-22T11:30:00+05:30").reason,
  REASON_OUTSIDE_SHIFT
);
assert.strictEqual(
  decide(HALF_MORNING, "2026-09-22T15:00:00+05:30", "2026-09-22T16:00:00+05:30").reason,
  REASON_OUTSIDE_SHIFT
);
assert.strictEqual(
  decide(HALF_MORNING, "2026-09-22T15:30:00+05:30", "2026-09-22T16:00:00+05:30").reason,
  REASON_OUTSIDE_SHIFT
);
assert.strictEqual(
  decide(HALF_MORNING, "2026-09-22T14:00:00+05:30", "2026-09-22T15:30:00+05:30").action,
  ACTION_ASSIGN
);
assert.strictEqual(
  decide(HALF_MORNING, "2026-09-22T15:30:00+05:30", "2026-09-22T15:30:00+05:30").action,
  ACTION_ASSIGN
);

assert.strictEqual(
  decide(FULL_EVENING, "2026-09-22T17:30:00+05:30", "2026-10-03T18:00:00+05:30").action,
  ACTION_ASSIGN
);
assert.strictEqual(
  decide(FULL_EVENING, "2026-09-22T14:00:00+05:30", "2026-09-22T14:30:00+05:30").reason,
  REASON_OUTSIDE_SHIFT
);

assert.strictEqual(
  decide({ status: "Leave" }, "2026-09-22T11:30:00+05:30", "2026-10-03T18:00:00+05:30")
    .reason,
  REASON_LEAVE
);
assert.strictEqual(decide({ status: "PlannedOff" }).reason, REASON_PLANNED_OFF);
assert.strictEqual(
  decide({ status: "Holiday" }, "2026-09-22T11:30:00+05:30", "2026-10-03T18:00:00+05:30")
    .reason,
  REASON_HOLIDAY
);
assert.strictEqual(
  decide({ status: "WeeklyOff" }, "2026-09-22T11:30:00+05:30", "2026-10-03T18:00:00+05:30")
    .reason,
  REASON_WEEKLY_OFF
);
assert.strictEqual(
  decide({ status: "Week Off" }, "2026-09-22T11:30:00+05:30", "2026-10-03T18:00:00+05:30")
    .reason,
  REASON_WEEKLY_OFF
);
assert.strictEqual(
  decide({ status: "Absent" }, "2026-09-22T11:30:00+05:30", "2026-10-03T18:00:00+05:30")
    .reason,
  REASON_ABSENT
);
assert.ok(decide({ status: "Leave" }).action === ACTION_POSTPONE);
assert.strictEqual(
  decide({ status: "Present", dayType: "Full Day", shift: "Morning Shift" }, "2026-09-22T11:30:00+05:30", "2026-10-03T18:00:00+05:30").action,
  ACTION_ASSIGN
);

const fields = nextScheduleFields(
  {
    scheduledAssignAt: "2026-09-22T08:30:00.000Z",
    startDate: "2026-09-22T08:30:00.000Z",
    dueDate: "2026-10-03T12:30:00.000Z",
  },
  { moveTaskDates: true }
);
assert.strictEqual(fields.scheduledAssignAt, "2026-09-23T08:30:00.000Z");
assert.strictEqual(fields.startDate, "2026-09-23T08:30:00.000Z");
assert.strictEqual(fields.dueDate, "2026-10-04T12:30:00.000Z");
assert.strictEqual(
  parseInstantMs(fields.dueDate) - parseInstantMs(fields.startDate),
  parseInstantMs("2026-10-03T12:30:00.000Z") - parseInstantMs("2026-09-22T08:30:00.000Z")
);

const assignedRange = taskEvaluationRange({
  assignmentState: "ASSIGNED",
  startDate: "2026-09-22T08:30:00.000Z",
  dueDate: "2026-09-22T09:00:00.000Z",
  scheduledAssignAt: "2026-09-23T08:30:00.000Z",
});
assert.strictEqual(assignedRange.startMs, parseInstantMs("2026-09-23T08:30:00.000Z"));
assert.strictEqual(assignedRange.endMs, parseInstantMs("2026-09-23T09:00:00.000Z"));

const leftoverMultiDay = taskEvaluationRange({
  assignmentState: "ASSIGNED",
  startDate: "2026-09-22T06:00:00.000Z",
  dueDate: "2026-10-03T12:30:00.000Z",
  scheduledAssignAt: "2026-09-23T06:00:00.000Z",
});
assert.strictEqual(
  isSameDayTask(leftoverMultiDay.startMs, leftoverMultiDay.endMs),
  false
);
assert.strictEqual(
  decide(FULL_MORNING, "2026-09-23T11:30:00+05:30", "2026-10-04T18:00:00+05:30").action,
  ACTION_ASSIGN
);

assert.strictEqual(
  attendanceDateKeyForTask({ scheduledAssignAt: "2026-10-14T18:30:00.000Z" }),
  "2026-10-15"
);
assert.strictEqual(
  attendanceDateKeyForTask({ scheduledAssignAt: "2026-10-14T18:29:59.000Z" }),
  "2026-10-14"
);

async function runLoad() {
  const gets = [];
  const puts = [];
  const ddb = {
    async send(command) {
      if (command instanceof GetCommand) {
        gets.push(command.input);
        return { Item: { PK: "priya@mydgv.com", SK: DATE, status: "Leave" } };
      }
      puts.push(command);
      throw new Error("attendance write is not allowed");
    },
  };
  const item = await loadAttendanceRecord(
    ddb,
    "Attendance",
    "Priya@mydgv.com",
    DATE
  );
  assert.strictEqual(item.status, "Leave");
  assert.deepStrictEqual(gets[0].Key, { PK: "priya@mydgv.com", SK: DATE });
  assert.strictEqual(puts.length, 0);
  console.log("scheduledAttendance tests passed");
}

runLoad().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const {
  WORK_PERIODS,
  TIMING_STATUS,
  TIME_SOURCE_EXPECTED_WINDOW,
  resolveWorkPeriod,
  workPeriodEligibility,
  expectedWindow,
  classifyTiming,
  buildWorkingAttendanceShift,
  loadCurrentAssignedShift,
} = require("./assignedShift");
const { companyDateTimeIso, companyDateKey } = require("../common/shiftWindows");

assert.strictEqual(resolveWorkPeriod({ dayType: "Full Day" }), WORK_PERIODS.FULL_DAY);
assert.strictEqual(resolveWorkPeriod({ dayType: "Half Day" }), WORK_PERIODS.FIRST_HALF);
assert.strictEqual(resolveWorkPeriod({ workPeriod: "SECOND_HALF" }), WORK_PERIODS.SECOND_HALF);
assert.strictEqual(resolveWorkPeriod({ dayType: "Evening Shift" }), null);

const morning = {
  shiftId: "morning",
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 15,
  crossesMidnight: false,
};

const morningSplit = {
  ...morning,
  halfDayEnabled: true,
  firstHalf: { startTime: "11:00", endTime: "15:30", graceMinutes: 10 },
  secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 20 },
};

const fullMorning = expectedWindow(morning, "2026-09-23", WORK_PERIODS.FULL_DAY);
assert.strictEqual(fullMorning.startIso, companyDateTimeIso("2026-09-23", "11:00"));
assert.strictEqual(fullMorning.endIso, companyDateTimeIso("2026-09-23", "20:00"));

assert.strictEqual(
  expectedWindow(morning, "2026-09-23", WORK_PERIODS.FIRST_HALF),
  null
);
assert.strictEqual(
  expectedWindow(morning, "2026-09-23", WORK_PERIODS.SECOND_HALF),
  null
);
assert.strictEqual(workPeriodEligibility(morning, WORK_PERIODS.FULL_DAY).ok, true);
assert.strictEqual(workPeriodEligibility(morning, WORK_PERIODS.FIRST_HALF).ok, false);
assert.strictEqual(workPeriodEligibility(morning, WORK_PERIODS.SECOND_HALF).ok, false);

const firstMorning = expectedWindow(morningSplit, "2026-09-23", WORK_PERIODS.FIRST_HALF);
assert.strictEqual(firstMorning.startIso, companyDateTimeIso("2026-09-23", "11:00"));
assert.strictEqual(firstMorning.endIso, companyDateTimeIso("2026-09-23", "15:30"));

const secondMorning = expectedWindow(morningSplit, "2026-09-23", WORK_PERIODS.SECOND_HALF);
assert.strictEqual(secondMorning.startIso, companyDateTimeIso("2026-09-23", "15:30"));
assert.strictEqual(secondMorning.endIso, companyDateTimeIso("2026-09-23", "20:00"));
assert.strictEqual(workPeriodEligibility(morningSplit, WORK_PERIODS.FIRST_HALF).ok, true);
assert.strictEqual(workPeriodEligibility(morningSplit, WORK_PERIODS.SECOND_HALF).ok, true);

const disabledHalves = {
  ...morning,
  halfDayEnabled: false,
  firstHalf: { startTime: "11:00", endTime: "15:30", graceMinutes: 10 },
  secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 20 },
};
assert.strictEqual(workPeriodEligibility(disabledHalves, WORK_PERIODS.FIRST_HALF).ok, false);
assert.strictEqual(
  expectedWindow(disabledHalves, "2026-09-23", WORK_PERIODS.FIRST_HALF),
  null
);

const overnight = {
  shiftId: "night",
  name: "Night Shift",
  startTime: "22:00",
  endTime: "06:00",
  graceMinutes: 10,
  crossesMidnight: true,
};

const overnightSplit = {
  ...overnight,
  halfDayEnabled: true,
  firstHalf: { startTime: "22:00", endTime: "02:00", graceMinutes: 8 },
  secondHalf: { startTime: "02:00", endTime: "06:00", graceMinutes: 12 },
};

const overnightFull = expectedWindow(overnight, "2026-09-23", WORK_PERIODS.FULL_DAY);
assert.strictEqual(overnightFull.startIso, companyDateTimeIso("2026-09-23", "22:00"));
assert.strictEqual(overnightFull.endIso, companyDateTimeIso("2026-09-24", "06:00"));
assert.strictEqual(
  expectedWindow(overnight, "2026-09-23", WORK_PERIODS.FIRST_HALF),
  null
);

const overnightFirst = expectedWindow(
  overnightSplit,
  "2026-09-23",
  WORK_PERIODS.FIRST_HALF
);
assert.strictEqual(overnightFirst.startIso, companyDateTimeIso("2026-09-23", "22:00"));
assert.strictEqual(overnightFirst.endIso, companyDateTimeIso("2026-09-24", "02:00"));

const overnightSecond = expectedWindow(
  overnightSplit,
  "2026-09-23",
  WORK_PERIODS.SECOND_HALF
);
assert.strictEqual(overnightSecond.startIso, companyDateTimeIso("2026-09-24", "02:00"));
assert.strictEqual(overnightSecond.endIso, companyDateTimeIso("2026-09-24", "06:00"));

const startMs = Date.parse("2026-09-23T11:00:00+05:30");
assert.deepStrictEqual(
  classifyTiming({
    submittedMs: Date.parse("2026-09-23T10:59:00+05:30"),
    shiftStartMs: startMs,
    graceMinutes: 15,
  }),
  { timingStatus: TIMING_STATUS.BEFORE_SHIFT, lateMinutes: 0 }
);
assert.deepStrictEqual(
  classifyTiming({
    submittedMs: Date.parse("2026-09-23T11:00:00+05:30"),
    shiftStartMs: startMs,
    graceMinutes: 15,
  }),
  { timingStatus: TIMING_STATUS.WITHIN_GRACE, lateMinutes: 0 }
);
assert.deepStrictEqual(
  classifyTiming({
    submittedMs: Date.parse("2026-09-23T11:15:00+05:30"),
    shiftStartMs: startMs,
    graceMinutes: 15,
  }),
  { timingStatus: TIMING_STATUS.WITHIN_GRACE, lateMinutes: 15 }
);
assert.deepStrictEqual(
  classifyTiming({
    submittedMs: Date.parse("2026-09-23T11:16:00+05:30"),
    shiftStartMs: startMs,
    graceMinutes: 15,
  }),
  { timingStatus: TIMING_STATUS.LATE, lateMinutes: 16 }
);

const lateSnapshot = buildWorkingAttendanceShift(morning, {
  dateKey: "2026-09-23",
  workPeriod: WORK_PERIODS.FULL_DAY,
  submittedMs: Date.parse("2026-09-23T11:20:00+05:30"),
});
assert.strictEqual(lateSnapshot.shiftId, "morning");
assert.strictEqual(lateSnapshot.shiftName, "Morning Shift");
assert.strictEqual(lateSnapshot.shift, "Morning Shift");
assert.strictEqual(lateSnapshot.dayType, "Full Day");
assert.strictEqual(lateSnapshot.graceMinutes, 15);
assert.strictEqual(lateSnapshot.crossesMidnight, false);
assert.strictEqual(lateSnapshot.timeSource, TIME_SOURCE_EXPECTED_WINDOW);
assert.strictEqual(lateSnapshot.timingStatus, TIMING_STATUS.LATE);
assert.strictEqual(lateSnapshot.lateMinutes, 20);
assert.strictEqual(lateSnapshot.checkInTime, lateSnapshot.expectedStartTime);
assert.strictEqual(lateSnapshot.checkOutTime, lateSnapshot.expectedEndTime);
assert.ok(lateSnapshot.attendanceSubmittedAt);

const firstGraceSnapshot = buildWorkingAttendanceShift(morningSplit, {
  dateKey: "2026-09-23",
  workPeriod: WORK_PERIODS.FIRST_HALF,
  submittedMs: Date.parse("2026-09-23T11:08:00+05:30"),
});
assert.strictEqual(firstGraceSnapshot.timingStatus, TIMING_STATUS.WITHIN_GRACE);
assert.strictEqual(firstGraceSnapshot.lateMinutes, 8);
assert.strictEqual(firstGraceSnapshot.graceMinutes, 10);
assert.strictEqual(
  firstGraceSnapshot.expectedStartTime,
  companyDateTimeIso("2026-09-23", "11:00")
);
assert.strictEqual(
  firstGraceSnapshot.expectedEndTime,
  companyDateTimeIso("2026-09-23", "15:30")
);

const secondLateSnapshot = buildWorkingAttendanceShift(morningSplit, {
  dateKey: "2026-09-23",
  workPeriod: WORK_PERIODS.SECOND_HALF,
  submittedMs: Date.parse("2026-09-23T15:51:00+05:30"),
});
assert.strictEqual(secondLateSnapshot.timingStatus, TIMING_STATUS.LATE);
assert.strictEqual(secondLateSnapshot.lateMinutes, 21);
assert.strictEqual(secondLateSnapshot.graceMinutes, 20);
assert.strictEqual(
  secondLateSnapshot.expectedStartTime,
  companyDateTimeIso("2026-09-23", "15:30")
);

const halfSnapshot = buildWorkingAttendanceShift(overnightSplit, {
  dateKey: "2026-09-23",
  workPeriod: WORK_PERIODS.SECOND_HALF,
  submittedMs: Date.parse("2026-09-24T01:50:00+05:30"),
});
assert.strictEqual(halfSnapshot.dayType, "Half Day");
assert.strictEqual(halfSnapshot.shift, "Night Shift");
assert.strictEqual(halfSnapshot.timingStatus, TIMING_STATUS.BEFORE_SHIFT);
assert.strictEqual(halfSnapshot.expectedStartTime, companyDateTimeIso("2026-09-24", "02:00"));
assert.strictEqual(halfSnapshot.expectedEndTime, companyDateTimeIso("2026-09-24", "06:00"));

function overnightSnapshot(submittedIso, workPeriod = WORK_PERIODS.FULL_DAY) {
  const submittedMs = Date.parse(submittedIso);
  return buildWorkingAttendanceShift(overnight, {
    dateKey: companyDateKey(new Date(submittedMs)),
    workPeriod,
    submittedMs,
  });
}

function overnightHalfSnapshot(submittedIso, workPeriod) {
  const submittedMs = Date.parse(submittedIso);
  return buildWorkingAttendanceShift(overnightSplit, {
    dateKey: companyDateKey(new Date(submittedMs)),
    workPeriod,
    submittedMs,
  });
}

{
  const before = overnightSnapshot("2026-09-23T21:30:00+05:30");
  assert.strictEqual(before.timingStatus, TIMING_STATUS.BEFORE_SHIFT);
  assert.strictEqual(before.lateMinutes, 0);
  assert.strictEqual(before.expectedStartTime, companyDateTimeIso("2026-09-23", "22:00"));
  assert.strictEqual(before.expectedEndTime, companyDateTimeIso("2026-09-24", "06:00"));
}

{
  const grace = overnightSnapshot("2026-09-23T22:05:00+05:30");
  assert.strictEqual(grace.timingStatus, TIMING_STATUS.WITHIN_GRACE);
  assert.strictEqual(grace.lateMinutes, 5);
  assert.strictEqual(grace.expectedStartTime, companyDateTimeIso("2026-09-23", "22:00"));
}

{
  const late = overnightSnapshot("2026-09-23T22:11:00+05:30");
  assert.strictEqual(late.timingStatus, TIMING_STATUS.LATE);
  assert.strictEqual(late.lateMinutes, 11);
}

{
  const afterMidnight = overnightSnapshot("2026-09-24T01:00:00+05:30");
  assert.strictEqual(companyDateKey("2026-09-24T01:00:00+05:30"), "2026-09-24");
  assert.strictEqual(afterMidnight.expectedStartTime, companyDateTimeIso("2026-09-23", "22:00"));
  assert.strictEqual(afterMidnight.expectedEndTime, companyDateTimeIso("2026-09-24", "06:00"));
  assert.strictEqual(afterMidnight.timingStatus, TIMING_STATUS.LATE);
  assert.strictEqual(afterMidnight.lateMinutes, 180);
}

{
  const nearEnd = overnightSnapshot("2026-09-24T05:59:00+05:30");
  assert.strictEqual(nearEnd.expectedStartTime, companyDateTimeIso("2026-09-23", "22:00"));
  assert.strictEqual(nearEnd.expectedEndTime, companyDateTimeIso("2026-09-24", "06:00"));
  assert.strictEqual(nearEnd.timingStatus, TIMING_STATUS.LATE);
}

{
  const firstAfterMidnight = overnightHalfSnapshot(
    "2026-09-24T01:00:00+05:30",
    WORK_PERIODS.FIRST_HALF
  );
  assert.strictEqual(firstAfterMidnight.expectedStartTime, companyDateTimeIso("2026-09-23", "22:00"));
  assert.strictEqual(firstAfterMidnight.expectedEndTime, companyDateTimeIso("2026-09-24", "02:00"));
  assert.strictEqual(firstAfterMidnight.timingStatus, TIMING_STATUS.LATE);
  assert.strictEqual(firstAfterMidnight.graceMinutes, 8);
}

{
  const secondBeforeMid = overnightHalfSnapshot(
    "2026-09-24T01:00:00+05:30",
    WORK_PERIODS.SECOND_HALF
  );
  assert.strictEqual(secondBeforeMid.expectedStartTime, companyDateTimeIso("2026-09-24", "02:00"));
  assert.strictEqual(secondBeforeMid.expectedEndTime, companyDateTimeIso("2026-09-24", "06:00"));
  assert.strictEqual(secondBeforeMid.timingStatus, TIMING_STATUS.BEFORE_SHIFT);
  assert.strictEqual(secondBeforeMid.graceMinutes, 12);
}

{
  const secondNearEnd = overnightHalfSnapshot(
    "2026-09-24T05:59:00+05:30",
    WORK_PERIODS.SECOND_HALF
  );
  assert.strictEqual(secondNearEnd.expectedStartTime, companyDateTimeIso("2026-09-24", "02:00"));
  assert.strictEqual(secondNearEnd.expectedEndTime, companyDateTimeIso("2026-09-24", "06:00"));
  assert.strictEqual(secondNearEnd.timingStatus, TIMING_STATUS.LATE);
}

(async () => {
  const items = {
    "USER#doer@mydgv.com|SHIFT#CURRENT": {
      PK: "USER#doer@mydgv.com",
      SK: "SHIFT#CURRENT",
      ...morning,
    },
  };
  const ddb = {
    send: async (cmd) => {
      assert.ok(cmd instanceof GetCommand);
      const key = `${cmd.input.Key.PK}|${cmd.input.Key.SK}`;
      return { Item: items[key] || null };
    },
  };
  const loaded = await loadCurrentAssignedShift(ddb, "WorkTasks", "doer@mydgv.com");
  assert.strictEqual(loaded.shiftId, "morning");
  const missing = await loadCurrentAssignedShift(ddb, "WorkTasks", "none@mydgv.com");
  assert.strictEqual(missing, null);
  console.log("assignedShift tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

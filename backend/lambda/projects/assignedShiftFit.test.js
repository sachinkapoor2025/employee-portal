process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { companyDateTimeIso, companyDateKey } = require("../common/shiftWindows");
const {
  ASSIGNED_SHIFT_FIT,
  evaluateAssignedShiftFit,
  assignedShiftFit,
} = require("./assignedShiftFit");

const EMAIL = "doer@mydgv.com";
const DATE = "2026-09-23";
const NEXT = "2026-09-24";

function iso(dateKey, hhmm) {
  return companyDateTimeIso(dateKey, hhmm);
}

const morning = {
  shiftId: "morning",
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 15,
  crossesMidnight: false,
};

const afternoon = {
  shiftId: "afternoon",
  name: "Afternoon Shift",
  startTime: "14:00",
  endTime: "23:00",
  graceMinutes: 0,
  crossesMidnight: false,
};

const evening = {
  shiftId: "evening",
  name: "Evening Shift",
  startTime: "17:00",
  endTime: "23:00",
  graceMinutes: 0,
  crossesMidnight: false,
};

const overnight = {
  shiftId: "night",
  name: "Night Shift",
  startTime: "22:00",
  endTime: "06:00",
  graceMinutes: 10,
  crossesMidnight: true,
};

function fit(assignment, startIso, endIso, evaluatedAt) {
  return evaluateAssignedShiftFit({
    assignment,
    taskStart: startIso,
    taskEnd: endIso,
    evaluatedAt,
  });
}

function assertFit(assignment, startIso, endIso, evaluatedAt) {
  const result = fit(assignment, startIso, endIso, evaluatedAt);
  assert.strictEqual(result.result, ASSIGNED_SHIFT_FIT.FIT, `${startIso}–${endIso}`);
  return result;
}

function assertConflict(assignment, startIso, endIso, evaluatedAt) {
  const result = fit(assignment, startIso, endIso, evaluatedAt);
  assert.strictEqual(result.result, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT, `${startIso}–${endIso}`);
  return result;
}

// 11:00–20:00
assertFit(morning, iso(DATE, "18:00"), iso(DATE, "20:00"));
assertConflict(morning, iso(DATE, "18:00"), iso(DATE, "21:00"));
assertConflict(morning, iso(DATE, "10:00"), iso(DATE, "12:00"));
assertConflict(morning, iso(DATE, "20:00"), iso(DATE, "21:00"));

// inclusive boundaries
assertFit(morning, iso(DATE, "11:00"), iso(DATE, "20:00"));
assertFit(morning, iso(DATE, "11:00"), iso(DATE, "11:00"));
assertFit(morning, iso(DATE, "20:00"), iso(DATE, "20:00"));

// grace must not extend the window
assertConflict(morning, iso(DATE, "10:50"), iso(DATE, "12:00"));

// 14:00–23:00 and 17:00–23:00
assertFit(afternoon, iso(DATE, "14:00"), iso(DATE, "23:00"));
assertConflict(afternoon, iso(DATE, "22:00"), iso(DATE, "23:30"));
assertFit(evening, iso(DATE, "17:00"), iso(DATE, "23:00"));
assertConflict(evening, iso(DATE, "16:59"), iso(DATE, "18:00"));

// 22:00–06:00 overnight
assertFit(overnight, iso(DATE, "23:00"), iso(NEXT, "02:00"));
assertFit(overnight, iso(NEXT, "05:00"), iso(NEXT, "06:00"));
assertConflict(overnight, iso(NEXT, "05:00"), iso(NEXT, "07:00"));
assertConflict(overnight, iso(DATE, "21:00"), iso(DATE, "23:00"));
assertFit(overnight, iso(DATE, "22:00"), iso(NEXT, "06:00"));

{
  const at0100 = iso(NEXT, "01:00");
  assert.strictEqual(companyDateKey(at0100), NEXT);
  const result = assertFit(overnight, at0100, iso(NEXT, "02:00"), at0100);
  assert.strictEqual(result.shiftDateKey, DATE);
  assert.strictEqual(result.window.startIso, iso(DATE, "22:00"));
  assert.strictEqual(result.window.endIso, iso(NEXT, "06:00"));
}

assert.strictEqual(
  evaluateAssignedShiftFit({
    assignment: null,
    taskStart: iso(DATE, "18:00"),
    taskEnd: iso(DATE, "20:00"),
  }).result,
  ASSIGNED_SHIFT_FIT.NO_SHIFT
);

(async () => {
  const items = {
    [`USER#${EMAIL}|SHIFT#CURRENT`]: {
      PK: `USER#${EMAIL}`,
      SK: "SHIFT#CURRENT",
      ...morning,
    },
  };
  const ddb = {
    send: async (cmd) => {
      assert.ok(cmd instanceof GetCommand);
      assert.strictEqual(cmd.input.TableName, "WorkTasks");
      const key = `${cmd.input.Key.PK}|${cmd.input.Key.SK}`;
      return { Item: items[key] || undefined };
    },
  };

  const loadedFit = await assignedShiftFit(ddb, "WorkTasks", {
    email: EMAIL,
    taskStart: iso(DATE, "18:00"),
    taskEnd: iso(DATE, "20:00"),
  });
  assert.strictEqual(loadedFit.result, ASSIGNED_SHIFT_FIT.FIT);
  assert.strictEqual(loadedFit.assignment.shiftId, "morning");

  const noShift = await assignedShiftFit(ddb, "WorkTasks", {
    email: "none@mydgv.com",
    taskStart: iso(DATE, "18:00"),
    taskEnd: iso(DATE, "20:00"),
  });
  assert.strictEqual(noShift.result, ASSIGNED_SHIFT_FIT.NO_SHIFT);
  assert.strictEqual(noShift.window, null);
  assert.strictEqual(noShift.assignment, null);

  const loadedConflict = await assignedShiftFit(ddb, "WorkTasks", {
    email: EMAIL,
    taskStart: iso(DATE, "18:00"),
    taskEnd: iso(DATE, "21:00"),
  });
  assert.strictEqual(loadedConflict.result, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);

  console.log("assignedShiftFit tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

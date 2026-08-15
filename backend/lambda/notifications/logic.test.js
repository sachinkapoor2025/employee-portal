const assert = require("assert");
const {
  addDaysToKey,
  isWeekend,
  isRequiredWorkingDay,
  isMissedRequiredDay,
  findMissedWorkingStreak,
  overlayStatusForDate,
} = require("./logic");

// 2026-08-10 = Monday, 2026-08-11 = Tuesday, 2026-08-14 = Friday,
// 2026-08-15 = Saturday, 2026-08-16 = Sunday, 2026-08-17 = Monday

assert.strictEqual(addDaysToKey("2026-08-17", -1), "2026-08-16");
assert.strictEqual(isWeekend("2026-08-15"), true);
assert.strictEqual(isWeekend("2026-08-16"), true);
assert.strictEqual(isWeekend("2026-08-14"), false);

assert.strictEqual(
  overlayStatusForDate("2026-08-11", [
    { fromDate: "2026-08-11", toDate: "2026-08-11", status: "APPROVED" },
  ]),
  "Leave"
);
assert.strictEqual(
  overlayStatusForDate("2026-08-11", [
    { fromDate: "2026-08-11", toDate: "2026-08-12", status: "PLANNED_OFF", category: "PLANNED_OFF" },
  ]),
  "PlannedOff"
);

// Weekend is not a required working day unless present
assert.strictEqual(isRequiredWorkingDay("2026-08-15", null, []), false);
assert.strictEqual(
  isRequiredWorkingDay("2026-08-15", { status: "Working", checkInTime: "x" }, []),
  true
);

assert.strictEqual(isRequiredWorkingDay("2026-08-10", { status: "WeeklyOff" }, []), false);
assert.strictEqual(isRequiredWorkingDay("2026-08-10", { status: "Holiday" }, []), false);
assert.strictEqual(
  isRequiredWorkingDay("2026-08-10", null, [
    { fromDate: "2026-08-10", toDate: "2026-08-10", status: "APPROVED" },
  ]),
  false
);

assert.strictEqual(isMissedRequiredDay("2026-08-10", null, []), true);
assert.strictEqual(
  isMissedRequiredDay("2026-08-10", { status: "Working" }, []),
  false
);
assert.strictEqual(
  isMissedRequiredDay("2026-08-10", { checkInTime: "2026-08-10T03:30:00.000Z" }, []),
  false
);

// Test 1: attendance present on current required days → no notify
{
  const result = findMissedWorkingStreak({
    todayKey: "2026-08-12", // Wed
    recordsByDate: {
      "2026-08-10": { status: "Working" },
      "2026-08-11": { checkInTime: "2026-08-11T03:30:00.000Z" },
    },
  });
  assert.strictEqual(result.shouldNotify, false);
}

// Test 2: missed only 1 required working day → no notify
{
  const result = findMissedWorkingStreak({
    todayKey: "2026-08-12",
    recordsByDate: {
      "2026-08-10": { status: "Working" },
    },
  });
  assert.strictEqual(result.shouldNotify, false);
  assert.deepStrictEqual(result.streak, ["2026-08-11"]);
}

// Test 3: missed Monday and Tuesday → notify
{
  const result = findMissedWorkingStreak({
    todayKey: "2026-08-12",
    recordsByDate: {},
    lookbackDays: 3,
  });
  assert.strictEqual(result.shouldNotify, true);
  assert.deepStrictEqual(result.missedDays, ["2026-08-10", "2026-08-11"]);
  assert.strictEqual(result.eventKey, "2026-08-10");
}

// Weekend skipped: missed Friday and Monday (Sat/Sun ignored)
{
  const result = findMissedWorkingStreak({
    todayKey: "2026-08-18", // Tue
    recordsByDate: {},
    lookbackDays: 7,
  });
  assert.strictEqual(result.shouldNotify, true);
  assert.deepStrictEqual(result.missedDays, ["2026-08-14", "2026-08-17"]);
}

// Test 4: approved leave / planned off → do not notify
{
  const leave = findMissedWorkingStreak({
    todayKey: "2026-08-12",
    recordsByDate: {
      "2026-08-06": { status: "Working" },
      "2026-08-07": { status: "Working" },
    },
    leaves: [{ fromDate: "2026-08-10", toDate: "2026-08-11", status: "APPROVED" }],
  });
  assert.strictEqual(leave.shouldNotify, false);

  const planned = findMissedWorkingStreak({
    todayKey: "2026-08-12",
    recordsByDate: {
      "2026-08-06": { status: "Working" },
      "2026-08-07": { status: "Working" },
    },
    leaves: [
      {
        fromDate: "2026-08-10",
        toDate: "2026-08-11",
        status: "PLANNED_OFF",
        category: "PLANNED_OFF",
      },
    ],
  });
  assert.strictEqual(planned.shouldNotify, false);
}

// Pending leave is not an excuse
{
  const result = findMissedWorkingStreak({
    todayKey: "2026-08-12",
    recordsByDate: {},
    leaves: [{ fromDate: "2026-08-10", toDate: "2026-08-11", status: "PENDING" }],
  });
  assert.strictEqual(result.shouldNotify, true);
}

// Do not count days before joining
{
  const result = findMissedWorkingStreak({
    todayKey: "2026-08-12",
    recordsByDate: {},
    lookbackDays: 10,
    notBeforeKey: "2026-08-11",
  });
  assert.strictEqual(result.shouldNotify, false);
}

console.log("notifications logic tests passed");

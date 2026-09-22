process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const {
  SHIFT_TIMES,
  companyDateKey,
  companyDateTimeIso,
  resolveShiftTimes,
  addDaysIso,
  parseInstantMs,
  isSameCompanyDay,
  taskFitsWindow,
} = require("./shiftWindows");

assert.deepStrictEqual(SHIFT_TIMES["Full Day"]["Morning Shift"], {
  in: "11:00",
  out: "20:00",
});
assert.deepStrictEqual(SHIFT_TIMES["Half Day"]["Morning Shift"], {
  in: "11:00",
  out: "15:30",
});
assert.deepStrictEqual(SHIFT_TIMES["Half Day"]["Afternoon Shift"], {
  in: "14:00",
  out: "18:30",
});
assert.deepStrictEqual(SHIFT_TIMES["Half Day"]["Evening Shift"], {
  in: "17:00",
  out: "20:30",
});

assert.strictEqual(
  companyDateKey("2026-10-14T18:30:00.000Z"),
  "2026-10-15"
);
assert.strictEqual(
  companyDateKey("2026-10-14T18:29:59.000Z"),
  "2026-10-14"
);
assert.strictEqual(
  companyDateKey("2026-09-22T08:30:00.000Z"),
  "2026-09-22"
);

assert.strictEqual(
  isSameCompanyDay(
    parseInstantMs("2026-09-22T11:30:00+05:30"),
    parseInstantMs("2026-09-22T20:00:00+05:30")
  ),
  true
);
assert.strictEqual(
  isSameCompanyDay(
    parseInstantMs("2026-09-22T11:30:00+05:30"),
    parseInstantMs("2026-10-03T18:00:00+05:30")
  ),
  false
);

const morningHalf = resolveShiftTimes("Half Day", "Morning Shift", "2026-09-22");
assert.strictEqual(
  morningHalf.checkInTime,
  companyDateTimeIso("2026-09-22", "11:00")
);
assert.strictEqual(
  morningHalf.checkOutTime,
  companyDateTimeIso("2026-09-22", "15:30")
);

const start = parseInstantMs("2026-09-22T14:00:00+05:30");
const endInside = parseInstantMs("2026-09-22T14:30:00+05:30");
const endAfter = parseInstantMs("2026-09-22T15:45:00+05:30");
const windowStart = parseInstantMs(morningHalf.checkInTime);
const windowEnd = parseInstantMs(morningHalf.checkOutTime);
assert.strictEqual(taskFitsWindow(start, endInside, windowStart, windowEnd), true);
assert.strictEqual(taskFitsWindow(start, endAfter, windowStart, windowEnd), false);
assert.strictEqual(
  taskFitsWindow(
    parseInstantMs("2026-09-22T15:30:00+05:30"),
    parseInstantMs("2026-09-22T15:30:00+05:30"),
    windowStart,
    windowEnd
  ),
  true
);
assert.strictEqual(
  taskFitsWindow(
    parseInstantMs("2026-09-22T15:30:00+05:30"),
    parseInstantMs("2026-09-22T16:00:00+05:30"),
    windowStart,
    windowEnd
  ),
  false
);

const original = "2026-09-22T08:30:00.000Z";
assert.strictEqual(addDaysIso(original, 1), "2026-09-23T08:30:00.000Z");
assert.strictEqual(
  parseInstantMs(addDaysIso(original, 1)) - parseInstantMs(original),
  24 * 60 * 60 * 1000
);

console.log("shiftWindows tests passed");

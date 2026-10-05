import {
  HH_MM_INVALID,
  HH_MM_PLACEHOLDER,
  HH_MM_POSITIVE,
  HH_MM_HELPER,
  formatStoredHoursAsHhMm,
  hoursToHhMm,
  minutesToStoredHours,
  parseHhMmInput,
  parseStoredHours,
  stepDuration,
  storedHoursToMinutes,
} from "./durationHours";

test("parses HH:MM including values longer than 23:59", () => {
  expect(parseHhMmInput("00:01")).toEqual({ ok: true, value: 0.02 });
  expect(parseHhMmInput("02:30")).toEqual({ ok: true, value: 2.5 });
  expect(parseHhMmInput("23:59")).toEqual({
    ok: true,
    value: minutesToStoredHours(23 * 60 + 59),
  });
  expect(parseHhMmInput("24:00")).toEqual({ ok: true, value: 24 });
  expect(parseHhMmInput("24:30")).toEqual({ ok: true, value: 24.5 });
  expect(parseHhMmInput("36:45")).toEqual({ ok: true, value: 36.75 });
  expect(parseHhMmInput("100:00")).toEqual({ ok: true, value: 100 });
});

test("converts through whole minutes to avoid float drift", () => {
  expect(parseHhMmInput("02:30").value).toBe(2.5);
  expect(hoursToHhMm(2.5)).toBe("02:30");
  expect(hoursToHhMm(parseHhMmInput("24:30").value)).toBe("24:30");
  expect(hoursToHhMm(parseHhMmInput("36:45").value)).toBe("36:45");
  expect(hoursToHhMm(parseHhMmInput("100:00").value)).toBe("100:00");
  expect(hoursToHhMm(parseHhMmInput("00:01").value)).toBe("00:01");
  expect(storedHoursToMinutes(2.5)).toBe(150);
  expect(minutesToStoredHours(150)).toBe(2.5);
});

test("rejects invalid incomplete decimal negative and out-of-range minutes", () => {
  expect(parseHhMmInput("").empty).toBe(true);
  expect(parseHhMmInput("2.5").error).toBe(HH_MM_INVALID);
  expect(parseHhMmInput("abc").error).toBe(HH_MM_INVALID);
  expect(parseHhMmInput("2").error).toBe(HH_MM_INVALID);
  expect(parseHhMmInput("02").error).toBe(HH_MM_INVALID);
  expect(parseHhMmInput("02:").error).toBe(HH_MM_INVALID);
  expect(parseHhMmInput("1:60").error).toBe(HH_MM_INVALID);
  expect(parseHhMmInput("25:90").error).toBe(HH_MM_INVALID);
  expect(parseHhMmInput("-01:00").error).toBe(HH_MM_INVALID);
  expect(parseHhMmInput("00:00").error).toBe(HH_MM_POSITIVE);
});

test("converts stored decimal hours to HH:MM without treating them as clock text", () => {
  expect(hoursToHhMm(0.5)).toBe("00:30");
  expect(hoursToHhMm(1)).toBe("01:00");
  expect(hoursToHhMm(2.5)).toBe("02:30");
  expect(hoursToHhMm(8.75)).toBe("08:45");
  expect(parseStoredHours(2.5)).toEqual({ ok: true, value: 2.5 });
  expect(parseStoredHours("2.5")).toEqual({ ok: true, value: 2.5 });
  expect(formatStoredHoursAsHhMm(2.5)).toBe("02:30");
  expect(formatStoredHoursAsHhMm(24.5)).toBe("24:30");
  expect(formatStoredHoursAsHhMm(null)).toBe("—");
});

test("steps hours and minutes without a 23-hour cap", () => {
  expect(stepDuration("23:59", "hours", 1)).toBe("24:59");
  expect(stepDuration("23:59", "minutes", 1)).toBe("24:00");
  expect(stepDuration("24:00", "minutes", -1)).toBe("23:59");
  expect(stepDuration("", "minutes", 1)).toBe("00:01");
  expect(stepDuration("", "hours", 1)).toBe("01:00");
  expect(stepDuration("23:", "hours", 1)).toBe("24:00");
  expect(HH_MM_PLACEHOLDER).toBe("HH:MM");
});

test("helper text shows HH:MM and duration examples", () => {
  expect(HH_MM_HELPER).toContain("Enter time as HH:MM");
  expect(HH_MM_HELPER).toContain("00:30 = 30 minutes");
  expect(HH_MM_HELPER).toContain("01:00 = 1 hour");
  expect(HH_MM_HELPER).toContain("02:30 = 2 hours 30 minutes");
  expect(HH_MM_HELPER).toContain("08:00 = 8 hours");
  expect(HH_MM_HELPER).toContain("24:30 = 24 hours 30 minutes");
});

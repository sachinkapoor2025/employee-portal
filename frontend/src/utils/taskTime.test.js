import { parseRequiredHours, formatHours, parseHoursInput } from "./taskTime";
import { HH_MM_INVALID, HH_MM_POSITIVE } from "./durationHours";

test("rejects blank zero negative and malformed hours", () => {
  expect(parseRequiredHours("").ok).toBe(false);
  expect(parseRequiredHours(0).ok).toBe(false);
  expect(parseRequiredHours(-2).ok).toBe(false);
  expect(parseRequiredHours("abc").ok).toBe(false);
});

test("accepts stored integer and decimal hours without reinterpreting them as HH:MM", () => {
  expect(parseRequiredHours(2)).toEqual({ ok: true, value: 2 });
  expect(parseRequiredHours("1.5")).toEqual({ ok: true, value: 1.5 });
  expect(parseRequiredHours("2.25")).toEqual({ ok: true, value: 2.25 });
  expect(parseRequiredHours(2.5)).toEqual({ ok: true, value: 2.5 });
});

test("parses HH:MM input into stored hours", () => {
  expect(parseHoursInput("02:30")).toEqual({ ok: true, value: 2.5 });
  expect(parseHoursInput("24:30")).toEqual({ ok: true, value: 24.5 });
  expect(parseHoursInput("100:00")).toEqual({ ok: true, value: 100 });
  expect(parseHoursInput("2.5").ok).toBe(false);
  expect(parseHoursInput("2.5").error).toBe(HH_MM_INVALID);
  expect(parseHoursInput("00:00").error).toBe(HH_MM_POSITIVE);
});

test("HH:MM actual hours reject blank and invalid values", () => {
  expect(parseHoursInput("").ok).toBe(false);
  expect(parseHoursInput("").empty).toBe(true);
  expect(parseHoursInput("  ").empty).toBe(true);
  expect(parseHoursInput("02:30")).toEqual({ ok: true, value: 2.5 });
  expect(parseHoursInput("24:30")).toEqual({ ok: true, value: 24.5 });
  expect(parseHoursInput("00:00").ok).toBe(false);
  expect(parseHoursInput("1:60").ok).toBe(false);
});

test("formats stored hours as HH:MM", () => {
  expect(formatHours(null)).toBe("—");
  expect(formatHours(1)).toBe("01:00");
  expect(formatHours(1.5)).toBe("01:30");
  expect(formatHours(2.5)).toBe("02:30");
  expect(formatHours(24.5)).toBe("24:30");
  expect(formatHours(100)).toBe("100:00");
});

import {
  ESTIMATED_HOURS_HELPER,
  ESTIMATED_HOURS_INVALID,
  formatEstimatedHours,
  parseEstimatedHours,
  parseEstimatedHoursInput,
} from "./estimatedHours";
import { HH_MM_INVALID, HH_MM_POSITIVE } from "./durationHours";

test("blank values are rejected", () => {
  expect(parseEstimatedHours("").ok).toBe(false);
  expect(parseEstimatedHours("  ").ok).toBe(false);
  expect(parseEstimatedHours(null).ok).toBe(false);
  expect(parseEstimatedHoursInput("").ok).toBe(false);
  expect(parseEstimatedHoursInput("").empty).toBe(true);
});

test("stored positive decimals are kept to two places", () => {
  expect(parseEstimatedHours("1.5")).toEqual({ ok: true, value: 1.5 });
  expect(parseEstimatedHours("2.25")).toEqual({ ok: true, value: 2.25 });
  expect(parseEstimatedHours(2)).toEqual({ ok: true, value: 2 });
  expect(parseEstimatedHours("1.234")).toEqual({ ok: true, value: 1.23 });
});

test("HH:MM input converts to stored hours and rejects decimals", () => {
  expect(parseEstimatedHoursInput("01:30")).toEqual({ ok: true, value: 1.5 });
  expect(parseEstimatedHoursInput("02:00")).toEqual({ ok: true, value: 2 });
  expect(parseEstimatedHoursInput("24:30")).toEqual({ ok: true, value: 24.5 });
  expect(parseEstimatedHoursInput("2.5").error).toBe(HH_MM_INVALID);
  expect(parseEstimatedHoursInput("00:00").error).toBe(HH_MM_POSITIVE);
});

test("zero negative and malformed stored values are rejected", () => {
  expect(parseEstimatedHours(0).ok).toBe(false);
  expect(parseEstimatedHours(-2).error).toBe(ESTIMATED_HOURS_INVALID);
  expect(parseEstimatedHours("abc").ok).toBe(false);
  expect(parseEstimatedHours("1e2").ok).toBe(false);
});

test("display helper and formatted hours use HH:MM", () => {
  expect(ESTIMATED_HOURS_HELPER).toMatch(/excluding lunch and breaks/);
  expect(formatEstimatedHours(null)).toBe("—");
  expect(formatEstimatedHours(1)).toBe("01:00");
  expect(formatEstimatedHours(1.5)).toBe("01:30");
  expect(formatEstimatedHours(8.75)).toBe("08:45");
  expect(formatEstimatedHours(24.5)).toBe("24:30");
});

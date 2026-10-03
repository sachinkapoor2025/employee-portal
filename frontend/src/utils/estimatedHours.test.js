import {
  ESTIMATED_HOURS_HELPER,
  ESTIMATED_HOURS_INVALID,
  formatEstimatedHours,
  parseEstimatedHours,
} from "./estimatedHours";

test("blank values are null", () => {
  expect(parseEstimatedHours("")).toEqual({ ok: true, value: null });
  expect(parseEstimatedHours("  ")).toEqual({ ok: true, value: null });
  expect(parseEstimatedHours(null)).toEqual({ ok: true, value: null });
});

test("positive decimals are kept to two places", () => {
  expect(parseEstimatedHours("1.5")).toEqual({ ok: true, value: 1.5 });
  expect(parseEstimatedHours("2.25")).toEqual({ ok: true, value: 2.25 });
  expect(parseEstimatedHours(2)).toEqual({ ok: true, value: 2 });
  expect(parseEstimatedHours("1.234")).toEqual({ ok: true, value: 1.23 });
});

test("zero negative and malformed values are rejected", () => {
  expect(parseEstimatedHours(0).ok).toBe(false);
  expect(parseEstimatedHours(-2).error).toBe(ESTIMATED_HOURS_INVALID);
  expect(parseEstimatedHours("abc").ok).toBe(false);
  expect(parseEstimatedHours("1e2").ok).toBe(false);
});

test("display helper and formatted hours", () => {
  expect(ESTIMATED_HOURS_HELPER).toMatch(/excluding lunch and breaks/);
  expect(formatEstimatedHours(null)).toBe("—");
  expect(formatEstimatedHours(1)).toBe("1 hour");
  expect(formatEstimatedHours(1.5)).toBe("1.5 hours");
});

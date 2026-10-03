import { parseRequiredHours, formatHours } from "./taskTime";

test("rejects blank zero negative and malformed hours", () => {
  expect(parseRequiredHours("").ok).toBe(false);
  expect(parseRequiredHours(0).ok).toBe(false);
  expect(parseRequiredHours(-2).ok).toBe(false);
  expect(parseRequiredHours("abc").ok).toBe(false);
});

test("accepts integer and decimal hours", () => {
  expect(parseRequiredHours("2")).toEqual({ ok: true, value: 2 });
  expect(parseRequiredHours("1.5")).toEqual({ ok: true, value: 1.5 });
  expect(parseRequiredHours("2.25")).toEqual({ ok: true, value: 2.25 });
});

test("formats hours for display", () => {
  expect(formatHours(null)).toBe("—");
  expect(formatHours(1)).toBe("1 hour");
  expect(formatHours(1.5)).toBe("1.5 hours");
});

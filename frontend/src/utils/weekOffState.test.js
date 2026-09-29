import { formatWeekOffRange, weekOffDisplay } from "./weekOffState";

test("formats Monday-Sunday range without using browser UTC today", () => {
  expect(formatWeekOffRange("2026-09-28", "2026-10-04")).toBe("28 Sept – 04 Oct");
  expect(formatWeekOffRange("2026-09-30")).toBe("28 Sept – 04 Oct");
});

test("available state copy", () => {
  const copy = weekOffDisplay({
    weekStart: "2026-09-28",
    weekEnd: "2026-10-04",
    weekOffEntitlement: 1,
    weekOffUsed: 0,
    weekOffAvailable: 1,
    leaveUsed: 0,
    balance: 1,
  });
  expect(copy.weekLabel).toBe("This week: 28 Sept – 04 Oct");
  expect(copy.statusLabel).toBe("Week Off: Available");
  expect(copy.detail).toBe("1 day available");
  expect(copy.available).toBe(true);
  expect(copy.dashboardHint).toBe("This week · Available");
});

test("used state copy", () => {
  const copy = weekOffDisplay({
    weekStart: "2026-09-28",
    weekEnd: "2026-10-04",
    weekOffEntitlement: 1,
    weekOffUsed: 1,
    weekOffAvailable: 0,
    leaveUsed: 2,
    balance: -2,
  });
  expect(copy.statusLabel).toBe("Week Off: Used");
  expect(copy.detail).toBe("You have already used your Week Off for this week.");
  expect(copy.available).toBe(false);
  expect(copy.leaveUsed).toBe(2);
  expect(copy.balance).toBe(-2);
  expect(copy.weekOffUsedLabel).toBe("1/1");
});

test("pending and rejected leave days are not inferred by the display helper", () => {
  const copy = weekOffDisplay({
    weekStart: "2026-09-28",
    weekEnd: "2026-10-04",
    weekOffUsed: 0,
    leaveUsed: 0,
    balance: 1,
  });
  expect(copy.leaveUsed).toBe(0);
  expect(copy.balance).toBe(1);
});

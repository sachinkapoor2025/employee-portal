import {
  isTodayLeave,
  isHistoryLeave,
  splitLeaveViews,
} from "./leaveAdminViews";

const TODAY = "2026-09-26";

function row(extra) {
  return {
    leaveId: extra.leaveId || "id",
    email: extra.email || "rahul@mydgv.com",
    fromDate: extra.fromDate,
    toDate: extra.toDate,
    startDate: extra.startDate,
    endDate: extra.endDate,
    status: extra.status,
    category: extra.category,
    type: extra.type,
  };
}

test("Today includes an approved leave covering today's IST date", () => {
  const leave = row({
    leaveId: "approved-today",
    fromDate: "2026-09-25",
    toDate: "2026-09-26",
    status: "APPROVED",
    category: "LEAVE",
    type: "CASUAL",
  });
  expect(isTodayLeave(leave, TODAY)).toBe(true);
  expect(isHistoryLeave(leave, TODAY)).toBe(false);
});

test("Today includes Planned Off covering today's IST date", () => {
  const leave = row({
    leaveId: "week-off-today",
    fromDate: TODAY,
    toDate: TODAY,
    status: "PLANNED_OFF",
    category: "PLANNED_OFF",
    type: "PLANNED_OFF",
  });
  expect(isTodayLeave(leave, TODAY)).toBe(true);
  expect(splitLeaveViews([leave], TODAY).today.map((r) => r.leaveId)).toEqual([
    "week-off-today",
  ]);
});

test("Today includes pending leave covering today", () => {
  const leave = row({
    leaveId: "pending-today",
    fromDate: TODAY,
    toDate: "2026-09-28",
    status: "PENDING_APPROVAL",
    category: "LEAVE",
    type: "SICK",
  });
  expect(isTodayLeave(leave, TODAY)).toBe(true);
});

test("Tomorrow-only leave does not appear in Today", () => {
  const leave = row({
    leaveId: "tomorrow",
    fromDate: "2026-09-27",
    toDate: "2026-09-27",
    status: "APPROVED",
    category: "LEAVE",
    type: "CASUAL",
  });
  expect(isTodayLeave(leave, TODAY)).toBe(false);
  expect(isHistoryLeave(leave, TODAY)).toBe(true);
});

test("Cancelled leave does not appear in Today", () => {
  const leave = row({
    leaveId: "cancelled-today",
    fromDate: TODAY,
    toDate: TODAY,
    status: "CANCELLED",
    category: "LEAVE",
    type: "CASUAL",
  });
  expect(isTodayLeave(leave, TODAY)).toBe(false);
});

test("Rejected leave does not appear in Today", () => {
  const leave = row({
    leaveId: "rejected-today",
    fromDate: TODAY,
    toDate: TODAY,
    status: "REJECTED",
    category: "LEAVE",
    type: "CASUAL",
  });
  expect(isTodayLeave(leave, TODAY)).toBe(false);
});

test("History contains past, rejected, and cancelled records", () => {
  const rows = [
    row({
      leaveId: "past-approved",
      fromDate: "2026-09-20",
      toDate: "2026-09-21",
      status: "APPROVED",
      category: "LEAVE",
      type: "CASUAL",
    }),
    row({
      leaveId: "rejected",
      fromDate: TODAY,
      toDate: TODAY,
      status: "REJECTED",
      category: "LEAVE",
      type: "SICK",
    }),
    row({
      leaveId: "cancelled",
      fromDate: TODAY,
      toDate: TODAY,
      status: "CANCELLED",
      category: "PLANNED_OFF",
      type: "PLANNED_OFF",
    }),
    row({
      leaveId: "past-week-off",
      fromDate: "2026-09-19",
      toDate: "2026-09-19",
      status: "PLANNED_OFF",
      category: "PLANNED_OFF",
      type: "PLANNED_OFF",
    }),
  ];
  const { history } = splitLeaveViews(rows, TODAY);
  expect(history.map((r) => r.leaveId).sort()).toEqual([
    "cancelled",
    "past-approved",
    "past-week-off",
    "rejected",
  ]);
});

test("A record covering today is not incorrectly treated as History", () => {
  const leave = row({
    leaveId: "today-not-history",
    fromDate: TODAY,
    toDate: TODAY,
    status: "APPROVED",
    category: "LEAVE",
    type: "EARNED",
  });
  const { today, history } = splitLeaveViews([leave], TODAY);
  expect(today.map((r) => r.leaveId)).toEqual(["today-not-history"]);
  expect(history).toEqual([]);
  expect(isHistoryLeave(leave, TODAY)).toBe(false);
});

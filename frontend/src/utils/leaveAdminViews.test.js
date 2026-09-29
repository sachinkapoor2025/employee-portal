import {
  isTodayLeave,
  isHistoryLeave,
  splitLeaveViews,
  isWeeklyOffAttendance,
  mergeTodayWeekOffRows,
  toAttendanceWeekOffRow,
  WEEK_OFF_SOURCE_LEAVE,
  WEEK_OFF_SOURCE_ATTENDANCE,
  todayTimeOffSummaryCounts,
  historyDefaultFromKey,
  mergeHistoryWeekOffRows,
  filterHistoryLeaveRows,
  filterHistoryWeekOffRows,
  matchesEmployeeSearch,
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

test("direct Attendance WeeklyOff for today is included in Week Off merge", () => {
  const attendance = {
    email: "nitesh@mydgv.com",
    date: TODAY,
    status: "WeeklyOff",
    submittedAt: "2026-09-26T03:30:00.000Z",
  };
  expect(isWeeklyOffAttendance(attendance)).toBe(true);
  const merged = mergeTodayWeekOffRows([], [attendance], TODAY);
  expect(merged).toHaveLength(1);
  expect(merged[0].email).toBe("nitesh@mydgv.com");
  expect(merged[0].fromDate).toBe(TODAY);
  expect(merged[0].source).toBe(WEEK_OFF_SOURCE_ATTENDANCE);
});

test("existing PLANNED_OFF Week Off still appears after merge", () => {
  const leave = row({
    leaveId: "week-off-today",
    email: "rahul@mydgv.com",
    fromDate: TODAY,
    toDate: TODAY,
    status: "PLANNED_OFF",
    category: "PLANNED_OFF",
    type: "PLANNED_OFF",
  });
  const merged = mergeTodayWeekOffRows([leave], [], TODAY);
  expect(merged).toHaveLength(1);
  expect(merged[0].leaveId).toBe("week-off-today");
  expect(merged[0].source).toBe(WEEK_OFF_SOURCE_LEAVE);
});

test("regular Leave records are not treated as WeeklyOff attendance", () => {
  expect(
    isWeeklyOffAttendance({ email: "today@mydgv.com", date: TODAY, status: "Leave" })
  ).toBe(false);
  const leave = row({
    leaveId: "casual-today",
    email: "today@mydgv.com",
    fromDate: TODAY,
    toDate: TODAY,
    status: "APPROVED",
    category: "LEAVE",
    type: "CASUAL",
  });
  const merged = mergeTodayWeekOffRows([], [{ ...leave, date: TODAY, status: "Leave" }], TODAY);
  expect(merged).toEqual([]);
});

test("multiple employees with WeeklyOff are all shown", () => {
  const merged = mergeTodayWeekOffRows(
    [],
    [
      { email: "nitesh@mydgv.com", date: TODAY, status: "WeeklyOff" },
      { email: "priya@mydgv.com", date: TODAY, status: "WeeklyOff" },
      { email: "ankit@mydgv.com", date: TODAY, status: "Working" },
    ],
    TODAY
  );
  expect(merged.map((r) => r.email).sort()).toEqual([
    "nitesh@mydgv.com",
    "priya@mydgv.com",
  ]);
});

test("same employee and date from both sources is displayed once", () => {
  const leave = row({
    leaveId: "planned-nitesh",
    email: "nitesh@mydgv.com",
    fromDate: TODAY,
    toDate: TODAY,
    status: "PLANNED_OFF",
    category: "PLANNED_OFF",
    type: "PLANNED_OFF",
  });
  const attendance = {
    email: "Nitesh@mydgv.com",
    date: TODAY,
    status: "WeeklyOff",
  };
  const merged = mergeTodayWeekOffRows([leave], [attendance], TODAY);
  expect(merged).toHaveLength(1);
  expect(merged[0].leaveId).toBe("planned-nitesh");
  expect(merged[0].source).toBe(WEEK_OFF_SOURCE_LEAVE);
});

test("WeeklyOff from another company date is not shown for Today", () => {
  const merged = mergeTodayWeekOffRows(
    [],
    [
      { email: "nitesh@mydgv.com", date: "2026-09-25", status: "WeeklyOff" },
      { email: "nitesh@mydgv.com", date: TODAY, status: "WeeklyOff" },
    ],
    TODAY
  );
  expect(merged).toHaveLength(1);
  expect(merged[0].fromDate).toBe(TODAY);
});

test("IST company date field is used instead of UTC submittedAt", () => {
  const afterIstMidnightUtc = {
    email: "nitesh@mydgv.com",
    date: "2026-09-25",
    status: "WeeklyOff",
    submittedAt: "2026-09-25T18:31:00.000Z",
  };
  const beforeIstMidnightUtc = {
    email: "priya@mydgv.com",
    date: TODAY,
    status: "WeeklyOff",
    submittedAt: "2026-09-25T18:29:00.000Z",
  };
  const merged = mergeTodayWeekOffRows(
    [],
    [afterIstMidnightUtc, beforeIstMidnightUtc],
    TODAY
  );
  expect(merged.map((r) => r.email)).toEqual(["priya@mydgv.com"]);
  expect(toAttendanceWeekOffRow(afterIstMidnightUtc).fromDate).toBe("2026-09-25");
});

test("today summary counts unique employees per metric", () => {
  const weekOffRows = [
    { email: "nitesh@mydgv.com", source: WEEK_OFF_SOURCE_ATTENDANCE },
    { email: "priya@mydgv.com", source: WEEK_OFF_SOURCE_LEAVE },
    { email: "NITESH@mydgv.com", source: WEEK_OFF_SOURCE_LEAVE },
  ];
  const todayLeaveRows = [
    row({
      leaveId: "approved-1",
      email: "leave@mydgv.com",
      fromDate: TODAY,
      toDate: TODAY,
      status: "APPROVED",
      category: "LEAVE",
      type: "SICK",
    }),
    row({
      leaveId: "approved-dup",
      email: "leave@mydgv.com",
      fromDate: TODAY,
      toDate: TODAY,
      status: "APPROVED",
      category: "LEAVE",
      type: "CASUAL",
    }),
    row({
      leaveId: "pending-1",
      email: "today@mydgv.com",
      fromDate: TODAY,
      toDate: TODAY,
      status: "PENDING_APPROVAL",
      category: "LEAVE",
      type: "CASUAL",
    }),
    row({
      leaveId: "pending-dup",
      email: "today@mydgv.com",
      fromDate: TODAY,
      toDate: TODAY,
      status: "PENDING",
      category: "LEAVE",
      type: "SICK",
    }),
    row({
      leaveId: "week-off",
      email: "rahul@mydgv.com",
      fromDate: TODAY,
      toDate: TODAY,
      status: "PLANNED_OFF",
      category: "PLANNED_OFF",
      type: "PLANNED_OFF",
    }),
  ];
  expect(
    todayTimeOffSummaryCounts({ weekOffRows, todayLeaveRows })
  ).toEqual({
    weekOff: 2,
    onLeave: 1,
    pending: 1,
  });
});

test("history default from date is last 30 company calendar days", () => {
  expect(historyDefaultFromKey(TODAY)).toBe("2026-08-28");
});

test("history week off merge reuses today dedupe across a date range", () => {
  const leave = row({
    leaveId: "wo-nitesh",
    email: "nitesh@mydgv.com",
    fromDate: TODAY,
    toDate: TODAY,
    status: "PLANNED_OFF",
    category: "PLANNED_OFF",
    type: "PLANNED_OFF",
  });
  const merged = mergeHistoryWeekOffRows(
    [leave],
    [
      { email: "nitesh@mydgv.com", date: TODAY, status: "WeeklyOff" },
      { email: "priya@mydgv.com", date: "2026-09-20", status: "WeeklyOff" },
      { email: "old@mydgv.com", date: "2026-08-01", status: "WeeklyOff" },
    ],
    "2026-09-01",
    TODAY
  );
  expect(merged.filter((r) => r.email === "nitesh@mydgv.com")).toHaveLength(1);
  expect(merged.find((r) => r.email === "nitesh@mydgv.com").source).toBe(
    WEEK_OFF_SOURCE_LEAVE
  );
  expect(merged.find((r) => r.email === "priya@mydgv.com").source).toBe(
    WEEK_OFF_SOURCE_ATTENDANCE
  );
  expect(merged.some((r) => r.email === "old@mydgv.com")).toBe(false);
});

test("history leave filters by approved rejected cancelled and pending", () => {
  const rows = [
    row({
      leaveId: "approved",
      email: "a@mydgv.com",
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
      status: "APPROVED",
      category: "LEAVE",
      type: "CASUAL",
    }),
    row({
      leaveId: "rejected",
      email: "r@mydgv.com",
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
      status: "REJECTED",
      category: "LEAVE",
      type: "SICK",
    }),
    row({
      leaveId: "cancelled",
      email: "c@mydgv.com",
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
      status: "CANCELLED",
      category: "LEAVE",
      type: "EARNED",
    }),
    row({
      leaveId: "pending",
      email: "p@mydgv.com",
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
      status: "PENDING_APPROVAL",
      category: "LEAVE",
      type: "CASUAL",
    }),
    row({
      leaveId: "week-off",
      email: "w@mydgv.com",
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
      status: "PLANNED_OFF",
      category: "PLANNED_OFF",
      type: "PLANNED_OFF",
    }),
  ];
  const range = { fromKey: "2026-09-01", toKey: TODAY, search: "" };
  expect(
    filterHistoryLeaveRows(rows, { ...range, status: "APPROVED" }).map((r) => r.leaveId)
  ).toEqual(["approved"]);
  expect(
    filterHistoryLeaveRows(rows, { ...range, status: "REJECTED" }).map((r) => r.leaveId)
  ).toEqual(["rejected"]);
  expect(
    filterHistoryLeaveRows(rows, { ...range, status: "CANCELLED" }).map((r) => r.leaveId)
  ).toEqual(["cancelled"]);
  expect(
    filterHistoryLeaveRows(rows, { ...range, status: "PENDING" }).map((r) => r.leaveId)
  ).toEqual(["pending"]);
  expect(
    filterHistoryLeaveRows(rows, { ...range, status: "APPROVED" }).some(
      (r) => r.leaveId === "week-off"
    )
  ).toBe(false);
});

test("week off history search matches name or email and ignores leave status", () => {
  const rows = [
    {
      email: "nitesh@mydgv.com",
      employeeName: "Nitesh Shukla",
      fromDate: TODAY,
      source: WEEK_OFF_SOURCE_ATTENDANCE,
    },
    {
      email: "priya@mydgv.com",
      employeeName: "Priya",
      fromDate: TODAY,
      source: WEEK_OFF_SOURCE_LEAVE,
    },
  ];
  expect(matchesEmployeeSearch(rows[0], "Nitesh")).toBe(true);
  expect(matchesEmployeeSearch(rows[0], "nitesh@mydgv.com")).toBe(true);
  expect(filterHistoryWeekOffRows(rows, { search: "Nitesh" }).map((r) => r.email)).toEqual([
    "nitesh@mydgv.com",
  ]);
  expect(filterHistoryWeekOffRows(rows, { search: "priya@" }).map((r) => r.email)).toEqual([
    "priya@mydgv.com",
  ]);
});

test("history date filters use company date keys not UTC submittedAt", () => {
  const merged = mergeHistoryWeekOffRows(
    [],
    [
      {
        email: "nitesh@mydgv.com",
        date: "2026-09-25",
        status: "WeeklyOff",
        submittedAt: "2026-09-25T18:31:00.000Z",
      },
      {
        email: "priya@mydgv.com",
        date: TODAY,
        status: "WeeklyOff",
        submittedAt: "2026-09-25T18:29:00.000Z",
      },
    ],
    TODAY,
    TODAY
  );
  expect(merged.map((r) => r.email)).toEqual(["priya@mydgv.com"]);
});




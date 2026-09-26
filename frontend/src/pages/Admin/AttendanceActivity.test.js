jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../../services/api", () => ({
  fetchAttendanceActivity: jest.fn(),
  fetchAttendance: jest.fn(),
  fetchUsers: jest.fn(),
  fetchTasks: jest.fn(),
  fetchAllLeave: jest.fn(),
  fetchUserProfile: jest.fn(),
  fetchEmployeeShift: jest.fn(),
}));

import {
  filterAttendanceSheetRoster,
  buildDayRows,
  isAttendanceExemptRole,
} from "./AttendanceActivity";

test("SUPER_ADMIN is exempt from the attendance sheet roster", () => {
  expect(isAttendanceExemptRole("SUPER_ADMIN")).toBe(true);
  expect(isAttendanceExemptRole("ADMIN")).toBe(false);
  expect(isAttendanceExemptRole("MANAGER")).toBe(false);
  expect(isAttendanceExemptRole("EMPLOYEE")).toBe(false);
});

test("SUPER_ADMIN does not appear in the Admin Attendance Sheet roster", () => {
  const users = [
    { email: "boss@mydgv.com", role: "SUPER_ADMIN", status: "ACTIVE", name: "Boss" },
    { email: "admin@mydgv.com", role: "ADMIN", status: "ACTIVE", name: "Admin" },
    { email: "lead@mydgv.com", role: "MANAGER", status: "ACTIVE", name: "Lead" },
    { email: "doer@mydgv.com", role: "EMPLOYEE", status: "ACTIVE", name: "Doer" },
  ];
  const roster = filterAttendanceSheetRoster(users);
  expect(roster.map((u) => u.email)).toEqual([
    "admin@mydgv.com",
    "lead@mydgv.com",
    "doer@mydgv.com",
  ]);
  expect(roster.some((u) => u.role === "SUPER_ADMIN")).toBe(false);

  const records = [
    {
      email: "boss@mydgv.com",
      date: "2026-09-14",
      status: "Working",
    },
    {
      email: "doer@mydgv.com",
      date: "2026-09-14",
      status: "Working",
      checkInTime: "2026-09-14T05:30:00.000Z",
    },
  ];
  const rows = buildDayRows(roster, records, [], "2026-09-14");
  expect(rows.some((row) => row.email === "boss@mydgv.com")).toBe(false);
  expect(
    rows.some((row) => row.dayStatus === "Absent" && row.email === "boss@mydgv.com")
  ).toBe(false);
  expect(rows.find((row) => row.email === "admin@mydgv.com")?.dayStatus).toBe("Absent");
  expect(rows.find((row) => row.email === "lead@mydgv.com")?.dayStatus).toBe("Absent");
  expect(rows.find((row) => row.email === "doer@mydgv.com")?.dayStatus).toBe("Present");
});

test("BLOCKED users do not appear in the Admin Attendance Sheet roster", () => {
  const users = [
    { email: "blocked@mydgv.com", role: "EMPLOYEE", status: "BLOCKED", name: "Blocked" },
    { email: "pending@mydgv.com", role: "EMPLOYEE", status: "PENDING", name: "Pending" },
    { email: "doer@mydgv.com", role: "EMPLOYEE", status: "ACTIVE", name: "Doer" },
  ];
  const roster = filterAttendanceSheetRoster(users);
  expect(roster.map((u) => u.email)).toEqual(["doer@mydgv.com"]);
  expect(roster.some((u) => u.status === "BLOCKED")).toBe(false);

  const records = [
    {
      email: "blocked@mydgv.com",
      date: "2026-09-14",
      status: "Working",
      checkInTime: "2026-09-14T05:30:00.000Z",
    },
  ];
  const rows = buildDayRows(roster, records, [], "2026-09-14");
  expect(rows.some((row) => row.email === "blocked@mydgv.com")).toBe(false);
  expect(rows.find((row) => row.email === "doer@mydgv.com")?.dayStatus).toBe("Absent");
});

test("ACTIVE non-SUPER_ADMIN users still appear in the Attendance Sheet", () => {
  const users = [
    { email: "admin@mydgv.com", role: "ADMIN", status: "ACTIVE", name: "Admin" },
    { email: "lead@mydgv.com", role: "MANAGER", status: "ACTIVE", name: "Lead" },
    { email: "doer@mydgv.com", role: "EMPLOYEE", status: "ACTIVE", name: "Doer" },
    { email: "boss@mydgv.com", role: "SUPER_ADMIN", status: "ACTIVE", name: "Boss" },
    { email: "blocked@mydgv.com", role: "ADMIN", status: "BLOCKED", name: "Blocked Admin" },
  ];
  const roster = filterAttendanceSheetRoster(users);
  expect(roster.map((u) => u.email)).toEqual([
    "admin@mydgv.com",
    "lead@mydgv.com",
    "doer@mydgv.com",
  ]);
});

test("Attendance Sheet filter does not mutate or delete historical attendance records", () => {
  const users = [
    { email: "blocked@mydgv.com", role: "EMPLOYEE", status: "BLOCKED", name: "Blocked" },
    { email: "doer@mydgv.com", role: "EMPLOYEE", status: "ACTIVE", name: "Doer" },
  ];
  const usersSnapshot = JSON.parse(JSON.stringify(users));
  const records = [
    {
      email: "blocked@mydgv.com",
      date: "2026-09-01",
      status: "Working",
      attendanceId: "hist-1",
    },
    {
      email: "doer@mydgv.com",
      date: "2026-09-01",
      status: "Working",
      attendanceId: "hist-2",
    },
  ];
  const recordsSnapshot = JSON.parse(JSON.stringify(records));

  const roster = filterAttendanceSheetRoster(users);
  buildDayRows(roster, records, [], "2026-09-01");

  expect(users).toEqual(usersSnapshot);
  expect(records).toEqual(recordsSnapshot);
  expect(records.find((row) => row.attendanceId === "hist-1")).toEqual(
    recordsSnapshot[0]
  );
});

test("buildDayRows derives ON TIME LATE NOT MARKED LEAVE WEEK OFF HOLIDAY and UPCOMING", () => {
  const roster = [
    { email: "priya@mydgv.com", name: "Priya" },
    { email: "rahul@mydgv.com", name: "Rahul" },
    { email: "amit@mydgv.com", name: "Amit" },
    { email: "neha@mydgv.com", name: "Neha" },
    { email: "vikas@mydgv.com", name: "Vikas" },
    { email: "sara@mydgv.com", name: "Sara" },
    { email: "future@mydgv.com", name: "Future" },
  ];
  const day = "2026-09-26";
  const records = [
    {
      email: "priya@mydgv.com",
      date: day,
      status: "Working",
      shiftName: "Morning Shift",
      expectedStartTime: "2026-09-26T11:00:00+05:30",
      expectedEndTime: "2026-09-26T20:00:00+05:30",
      graceMinutes: 5,
      attendanceSubmittedAt: "2026-09-26T10:58:00+05:30",
    },
    {
      email: "rahul@mydgv.com",
      date: day,
      status: "Working",
      shiftName: "Morning Shift",
      expectedStartTime: "2026-09-26T11:00:00+05:30",
      expectedEndTime: "2026-09-26T20:00:00+05:30",
      graceMinutes: 5,
      attendanceSubmittedAt: "2026-09-26T11:18:00+05:30",
    },
    { email: "neha@mydgv.com", date: day, status: "Leave" },
    { email: "vikas@mydgv.com", date: day, status: "WeeklyOff" },
    { email: "sara@mydgv.com", date: day, status: "Holiday" },
  ];
  const shifts = {
    "amit@mydgv.com": {
      name: "Morning Shift",
      startTime: "11:00",
      endTime: "20:00",
      graceMinutes: 5,
    },
    "future@mydgv.com": {
      name: "Morning Shift",
      startTime: "11:00",
      endTime: "20:00",
      graceMinutes: 5,
    },
  };
  const todayRows = buildDayRows(roster, records, [], day, {
    todayKey: day,
    shiftsByEmail: shifts,
  });
  expect(todayRows.find((r) => r.email === "priya@mydgv.com").compliance.status).toBe("ON TIME");
  expect(todayRows.find((r) => r.email === "rahul@mydgv.com").compliance.status).toBe("LATE");
  expect(todayRows.find((r) => r.email === "rahul@mydgv.com").compliance.lateMinutes).toBe(13);
  expect(todayRows.find((r) => r.email === "amit@mydgv.com").compliance.status).toBe("NOT MARKED");
  expect(todayRows.find((r) => r.email === "amit@mydgv.com").compliance.shiftLabel).toMatch(
    /Morning Shift/
  );
  expect(todayRows.find((r) => r.email === "priya@mydgv.com").compliance.shiftLabel).toMatch(
    /11:00/
  );
  expect(todayRows.find((r) => r.email === "neha@mydgv.com").compliance.status).toBe("LEAVE");
  expect(todayRows.find((r) => r.email === "vikas@mydgv.com").compliance.status).toBe("WEEK OFF");
  expect(todayRows.find((r) => r.email === "sara@mydgv.com").compliance.status).toBe("HOLIDAY");

  const futureRows = buildDayRows(
    [{ email: "future@mydgv.com", name: "Future" }],
    [],
    [],
    "2026-09-28",
    { todayKey: day, shiftsByEmail: shifts }
  );
  expect(futureRows[0].compliance.status).toBe("UPCOMING");
});

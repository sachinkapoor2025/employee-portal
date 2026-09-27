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
  todayStatusOf,
  timingLabelOf,
  shiftNameOf,
  shiftTimingOf,
  attendanceCheckInIso,
  attendanceCheckOutDetail,
} from "./AttendanceActivity";
import AttendanceActivity from "./AttendanceActivity";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  fetchAttendanceActivity,
  fetchAttendance,
  fetchUsers,
  fetchTasks,
  fetchAllLeave,
  fetchUserProfile,
  fetchEmployeeShift,
} from "../../services/api";

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

test("Today's Status is separate from Timing and shift name is split from timing", () => {
  const day = "2026-09-26";
  const roster = [
    { email: "priya@mydgv.com", name: "Priya" },
    { email: "rahul@mydgv.com", name: "Rahul" },
    { email: "neha@mydgv.com", name: "Neha" },
    { email: "vikas@mydgv.com", name: "Vikas" },
    { email: "amit@mydgv.com", name: "Amit" },
    { email: "none@mydgv.com", name: "None" },
  ];
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
  ];
  const rows = buildDayRows(roster, records, [], day, {
    todayKey: day,
    shiftsByEmail: {
      "amit@mydgv.com": {
        name: "Morning Shift",
        startTime: "11:00",
        endTime: "20:00",
      },
    },
  });
  const priya = rows.find((r) => r.email === "priya@mydgv.com");
  const rahul = rows.find((r) => r.email === "rahul@mydgv.com");
  const neha = rows.find((r) => r.email === "neha@mydgv.com");
  const vikas = rows.find((r) => r.email === "vikas@mydgv.com");
  const amit = rows.find((r) => r.email === "amit@mydgv.com");
  const none = rows.find((r) => r.email === "none@mydgv.com");

  expect(todayStatusOf(priya)).toBe("Present");
  expect(timingLabelOf(priya)).toBe("ON TIME");
  expect(todayStatusOf(rahul)).toBe("Present");
  expect(timingLabelOf(rahul)).toBe("LATE");
  expect(todayStatusOf(neha)).toBe("Leave");
  expect(timingLabelOf(neha)).toBe("—");
  expect(todayStatusOf(vikas)).toBe("Week Off");
  expect(timingLabelOf(vikas)).toBe("—");
  expect(todayStatusOf(amit)).toBe("Not Marked");
  expect(timingLabelOf(amit)).toBe("—");
  expect(todayStatusOf(none)).toBe("Not Marked");

  expect(shiftNameOf(priya)).toBe("Morning Shift");
  expect(shiftTimingOf(priya)).toMatch(/11:00/);
  expect(shiftTimingOf(priya)).toMatch(/8:00/);
  expect(shiftNameOf(priya)).not.toMatch(/11:00/);
  expect(shiftNameOf(none)).toBe("—");
  expect(shiftTimingOf(none)).toBe("—");
});

test("check-in uses submit/actual time and checkout falls back to expectedEndTime", () => {
  const working = {
    status: "Working",
    checkInTime: "2026-09-26T05:30:00.000Z",
    checkOutTime: "2026-09-26T14:30:00.000Z",
    expectedStartTime: "2026-09-26T05:30:00.000Z",
    expectedEndTime: "2026-09-26T14:30:00.000Z",
    actualCheckInTime: "2026-09-26T05:50:00.000Z",
    attendanceSubmittedAt: "2026-09-26T05:50:00.000Z",
    submittedAt: "2026-09-26T05:50:00.000Z",
  };
  expect(attendanceCheckInIso(working)).toBe(working.actualCheckInTime);
  expect(attendanceCheckInIso(working)).not.toBe(working.checkInTime);

  const noPunch = { ...working, actualCheckInTime: null };
  expect(attendanceCheckInIso(noPunch)).toBe(working.attendanceSubmittedAt);

  expect(attendanceCheckOutDetail(working)).toEqual({
    iso: working.expectedEndTime,
    fallback: true,
  });
  expect(attendanceCheckOutDetail({
    ...working,
    actualCheckOutTime: "2026-09-26T15:00:00.000Z",
  })).toEqual({
    iso: "2026-09-26T15:00:00.000Z",
    fallback: false,
  });

  for (const status of ["Leave", "WeeklyOff", "Holiday"]) {
    expect(attendanceCheckInIso({ status, actualCheckInTime: "x" })).toBe(null);
    expect(attendanceCheckOutDetail({
      status,
      actualCheckOutTime: "y",
      expectedEndTime: "z",
    })).toEqual({ iso: null, fallback: false });
  }
  expect(attendanceCheckInIso({ status: null })).toBe(null);
  expect(attendanceCheckOutDetail({})).toEqual({ iso: null, fallback: false });
});

test("Admin table shows split columns and View Details for the selected day", async () => {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const record = {
    email: "priya@mydgv.com",
    date: day,
    status: "Working",
    workPeriod: "FULL_DAY",
    shiftName: "Morning Shift",
    expectedStartTime: `${day}T11:00:00+05:30`,
    expectedEndTime: `${day}T20:00:00+05:30`,
    graceMinutes: 5,
    attendanceSubmittedAt: `${day}T11:20:00+05:30`,
    submittedAt: `${day}T11:20:00+05:30`,
    actualCheckInTime: `${day}T11:20:00+05:30`,
    checkInTime: `${day}T11:00:00+05:30`,
    checkOutTime: `${day}T20:00:00+05:30`,
  };
  fetchUsers.mockResolvedValue([
    {
      email: "priya@mydgv.com",
      role: "EMPLOYEE",
      status: "ACTIVE",
      name: "Priya",
      empId: "P1",
    },
  ]);
  fetchAllLeave.mockResolvedValue([]);
  fetchEmployeeShift.mockResolvedValue({
    shift: {
      name: "Morning Shift",
      startTime: "11:00",
      endTime: "20:00",
      graceMinutes: 5,
    },
  });
  fetchAttendanceActivity.mockResolvedValue({ items: [record] });
  fetchAttendance.mockResolvedValue([record]);
  fetchTasks.mockResolvedValue([]);
  fetchUserProfile.mockResolvedValue({ name: "Priya", empId: "P1" });

  render(<AttendanceActivity />);

  expect(await screen.findByRole("columnheader", { name: "Employee Name" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Shift" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Shift Timing" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Today's Status" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Timing" })).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Marked At" })).not.toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Expected By" })).not.toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Late By" })).not.toBeInTheDocument();
  expect(screen.getByText("Present")).toBeInTheDocument();
  expect(screen.getAllByText("LATE").length).toBeGreaterThan(0);
  expect(screen.queryByRole("columnheader", { name: "Marked At" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "View Details" }));

  const details = await screen.findByLabelText("Attendance details");
  expect(within(details).getByText("Status")).toBeInTheDocument();
  expect(within(details).getByText("Working Type")).toBeInTheDocument();
  expect(within(details).getByText("Shift")).toBeInTheDocument();
  expect(within(details).getByText("Shift Timing")).toBeInTheDocument();
  expect(within(details).getByText("Expected By")).toBeInTheDocument();
  expect(within(details).getByText("Attendance Marked At")).toBeInTheDocument();
  expect(within(details).getByText("Timing")).toBeInTheDocument();
  expect(within(details).getByText("Late By / Difference")).toBeInTheDocument();
  expect(within(details).getByText("Check In")).toBeInTheDocument();
  expect(within(details).getByText("Check Out")).toBeInTheDocument();
  expect(within(details).getByText("Full Day")).toBeInTheDocument();
  expect(within(details).getByText(/shift end/i)).toBeInTheDocument();
});


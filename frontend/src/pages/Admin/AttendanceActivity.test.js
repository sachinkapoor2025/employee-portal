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

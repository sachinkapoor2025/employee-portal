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
    { email: "boss@mydgv.com", role: "SUPER_ADMIN", name: "Boss" },
    { email: "admin@mydgv.com", role: "ADMIN", name: "Admin" },
    { email: "lead@mydgv.com", role: "MANAGER", name: "Lead" },
    { email: "doer@mydgv.com", role: "EMPLOYEE", name: "Doer" },
  ];
  const roster = filterAttendanceSheetRoster(users);
  expect(roster.map((u) => u.email)).toEqual([
    "admin@mydgv.com",
    "lead@mydgv.com",
    "doer@mydgv.com",
  ]);

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

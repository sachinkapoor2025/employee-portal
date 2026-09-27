import { render, screen } from "@testing-library/react";
import WeeklyAttendanceHistory, {
  attendancePunchDisplay,
  getWeeklyDisplayStatus,
} from "./WeeklyAttendanceHistory";

const EXPECTED_IN = "2026-09-23T05:30:00.000Z"; // 11:00 IST
const EXPECTED_OUT = "2026-09-23T14:30:00.000Z"; // 20:00 IST
const ACTUAL_IN = "2026-09-23T05:50:00.000Z";
const ACTUAL_OUT = "2026-09-23T15:00:00.000Z";

test("new row with actual in/out uses punch times, not compatibility window", () => {
  const times = attendancePunchDisplay({
    status: "Working",
    checkInTime: EXPECTED_IN,
    checkOutTime: EXPECTED_OUT,
    expectedStartTime: EXPECTED_IN,
    expectedEndTime: EXPECTED_OUT,
    actualCheckInTime: ACTUAL_IN,
    actualCheckOutTime: ACTUAL_OUT,
  });
  expect(times.inLabel).not.toBe("11:00 AM");
  expect(times.inLabel).toMatch(/11:20/);
  expect(times.outLabel).toMatch(/8:30/);
  expect(times.windowLabel).toMatch(/11:00/);
  expect(times.windowLabel).toMatch(/8:00/);
  expect(times.historical).toBe(false);
  expect(times.beyond).toBe(false);
});

test("checked in but not checked out shows Not checked out", () => {
  const times = attendancePunchDisplay({
    status: "Working",
    checkInTime: EXPECTED_IN,
    checkOutTime: EXPECTED_OUT,
    expectedStartTime: EXPECTED_IN,
    expectedEndTime: EXPECTED_OUT,
    actualCheckInTime: ACTUAL_IN,
  });
  expect(times.inLabel).toMatch(/11:20/);
  expect(times.outLabel).toBe("Not checked out");
  expect(times.windowLabel).toMatch(/8:00/);
});

test("worked beyond shift surfaces flag and reason", () => {
  const times = attendancePunchDisplay({
    status: "Working",
    expectedStartTime: EXPECTED_IN,
    expectedEndTime: EXPECTED_OUT,
    actualCheckInTime: ACTUAL_IN,
    actualCheckOutTime: ACTUAL_OUT,
    workedBeyondShift: true,
    workedBeyondReason: "Finished a client call",
  });
  expect(times.beyond).toBe(true);
  expect(times.beyondReason).toBe("Finished a client call");
});

test("old row without actual punches is not labeled as a punch", () => {
  const times = attendancePunchDisplay({
    status: "Working",
    checkInTime: EXPECTED_IN,
    checkOutTime: EXPECTED_OUT,
  });
  expect(times.inLabel).toBe("—");
  expect(times.outLabel).toBe("—");
  expect(times.historical).toBe(true);
  expect(times.windowLabel).toMatch(/11:00/);
  expect(times.windowLabel).toMatch(/8:00/);
});

test("Leave Holiday and Weekly Off do not show punch times", () => {
  for (const status of ["Leave", "Holiday", "WeeklyOff"]) {
    const times = attendancePunchDisplay({
      status,
      checkInTime: EXPECTED_IN,
      checkOutTime: EXPECTED_OUT,
    });
    expect(times.inLabel).toBe("—");
    expect(times.outLabel).toBe("—");
    expect(times.windowLabel).toBe(null);
    expect(getWeeklyDisplayStatus({ status })).not.toBe("Present");
  }
});

test("employee week view shows Present Leave Week Off Absent and Shift, not timing", () => {
  render(
    <WeeklyAttendanceHistory
      weekStart="2026-09-21"
      todayKey="2026-09-26"
      assignedShift={{
        name: "Morning Shift",
        startTime: "11:00",
        endTime: "20:00",
        graceMinutes: 5,
      }}
      attendanceData={{
        "2026-09-21": { status: "Leave" },
        "2026-09-22": { status: "WeeklyOff" },
        "2026-09-23": { status: "Holiday" },
        "2026-09-24": {
          status: "Working",
          workPeriod: "FULL_DAY",
          dayType: "Full Day",
          shiftName: "Morning Shift",
          expectedStartTime: "2026-09-24T11:00:00+05:30",
          graceMinutes: 5,
          attendanceSubmittedAt: "2026-09-24T10:58:00+05:30",
          submittedAt: "2026-09-24T10:58:00+05:30",
        },
        "2026-09-25": {
          status: "Working",
          workPeriod: "FULL_DAY",
          dayType: "Full Day",
          shiftName: "Morning Shift",
          expectedStartTime: "2026-09-25T11:00:00+05:30",
          graceMinutes: 5,
          attendanceSubmittedAt: "2026-09-25T11:18:00+05:30",
          submittedAt: "2026-09-25T11:18:00+05:30",
        },
      }}
      onPreviousWeek={() => {}}
      onCurrentWeek={() => {}}
      onNextWeek={() => {}}
    />
  );
  expect(screen.getByRole("columnheader", { name: "Day" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Date" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Working Type" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Shift" })).toBeInTheDocument();
  expect(screen.getAllByText("Full Day").length).toBeGreaterThan(0);
  expect(screen.queryByRole("columnheader", { name: "Marked At" })).not.toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Expected By" })).not.toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Late By" })).not.toBeInTheDocument();
  expect(screen.getAllByText("Present").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Leave").length).toBeGreaterThan(0);
  expect(screen.getByText("Week Off")).toBeInTheDocument();
  expect(screen.getAllByText("Absent").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Not Marked").length).toBeGreaterThan(0);
  expect(screen.queryByText("ON TIME")).not.toBeInTheDocument();
  expect(screen.queryByText("LATE")).not.toBeInTheDocument();
  expect(screen.queryByText("13 min")).not.toBeInTheDocument();
  expect(screen.queryByText("Expected By")).not.toBeInTheDocument();
  expect(screen.queryByText(/Expected by/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Late by/i)).not.toBeInTheDocument();
  expect(screen.getAllByText("Morning Shift").length).toBeGreaterThan(0);
});

jest.mock("../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../components/WeeklyAttendanceHistory", () => {
  return function WeeklyAttendanceHistory() {
    return <div>Weekly history</div>;
  };
});

jest.mock("../components/WorkingTimeWidget", () => {
  return function WorkingTimeWidget() {
    return <div>Working time</div>;
  };
});

jest.mock("../services/auth", () => ({
  getLoggedInEmail: jest.fn(() => "doer@mydgv.com"),
}));

jest.mock("../services/api", () => ({
  fetchAttendance: jest.fn(),
  fetchEmployeeShift: jest.fn(),
  saveAttendance: jest.fn(),
}));

import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Attendance from "./Attendance";
import {
  fetchAttendance,
  fetchEmployeeShift,
  saveAttendance,
} from "../services/api";
import { getLoggedInEmail } from "../services/auth";

const ASSIGNED = {
  shift: {
    shiftId: "morning",
    name: "Morning Shift",
    startTime: "11:00",
    endTime: "20:00",
    graceMinutes: 15,
    crossesMidnight: false,
  },
};

const ASSIGNED_HALF_DAY = {
  shift: {
    ...ASSIGNED.shift,
    halfDayEnabled: true,
    firstHalf: { startTime: "11:00", endTime: "15:30", graceMinutes: 10 },
    secondHalf: { startTime: "15:30", endTime: "20:00", graceMinutes: 20 },
  },
};

beforeEach(() => {
  window.alert = jest.fn();
  getLoggedInEmail.mockReturnValue("doer@mydgv.com");
  fetchAttendance.mockResolvedValue([]);
  fetchEmployeeShift.mockResolvedValue(ASSIGNED);
  saveAttendance.mockReset();
});

test("shows assigned shift read-only and Working Full Day submits workPeriod", async () => {
  saveAttendance.mockResolvedValue({
    attendance: {
      date: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
      status: "Working",
      workPeriod: "FULL_DAY",
      dayType: "Full Day",
      shiftName: "Morning Shift",
      shift: "Morning Shift",
      submittedAt: "2026-09-23T05:50:00.000Z",
      timingStatus: "LATE",
      lateMinutes: 20,
      expectedStartTime: "2026-09-23T05:30:00.000Z",
      expectedEndTime: "2026-09-23T14:30:00.000Z",
    },
  });
  render(<Attendance />);
  await waitFor(() => expect(fetchEmployeeShift).toHaveBeenCalled());
  expect(await screen.findByText("Morning Shift")).toBeInTheDocument();
  expect(screen.getByText(/11:00 AM/)).toBeInTheDocument();
  expect(screen.getByText(/8:00 PM/)).toBeInTheDocument();
  expect(screen.getByText("15 min")).toBeInTheDocument();
  expect(screen.getByText("Expected By")).toBeInTheDocument();
  expect(screen.getByText(/11:15 AM/)).toBeInTheDocument();
  expect(screen.queryByLabelText("Shift")).not.toBeInTheDocument();
  expect(screen.queryByText("Afternoon Shift")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Working" }));
  expect(screen.getByRole("button", { name: "Full Day" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Full Day" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(screen.queryByRole("button", { name: "First Half" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Second Half" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Submit Attendance" }));

  await waitFor(() => expect(saveAttendance).toHaveBeenCalledTimes(1));
  const payload = saveAttendance.mock.calls[0][0][0];
  expect(payload.status).toBe("Working");
  expect(payload.workPeriod).toBe("FULL_DAY");
  expect(payload.shift).toBeUndefined();
  expect(await screen.findByText(/LATE/)).toBeInTheDocument();
  expect(screen.getByText(/5 min late/)).toBeInTheDocument();
});

test("half-day enabled shows Full Day First Half and Second Half", async () => {
  fetchEmployeeShift.mockResolvedValue(ASSIGNED_HALF_DAY);
  render(<Attendance />);
  await screen.findByText("Morning Shift");
  await userEvent.click(screen.getByRole("button", { name: "Working" }));
  expect(screen.getByRole("button", { name: "Full Day" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(screen.getByRole("button", { name: "First Half" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Second Half" })).toBeInTheDocument();
});

test("First Half and Second Half submit the Stage 2A workPeriod values", async () => {
  fetchEmployeeShift.mockResolvedValue(ASSIGNED_HALF_DAY);
  saveAttendance.mockResolvedValue({
    attendance: {
      date: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
      status: "Working",
      workPeriod: "FIRST_HALF",
      submittedAt: "2026-09-23T05:30:00.000Z",
      timingStatus: "WITHIN_GRACE",
      shiftName: "Morning Shift",
    },
  });
  const { unmount } = render(<Attendance />);
  await screen.findByText("Morning Shift");
  await userEvent.click(screen.getByRole("button", { name: "Working" }));
  await userEvent.click(screen.getByRole("button", { name: "First Half" }));
  await userEvent.click(screen.getByRole("button", { name: "Submit Attendance" }));
  await waitFor(() => expect(saveAttendance).toHaveBeenCalled());
  expect(saveAttendance.mock.calls[0][0][0].workPeriod).toBe("FIRST_HALF");
  expect(await screen.findByText("ON TIME")).toBeInTheDocument();
  unmount();

  saveAttendance.mockReset();
  fetchAttendance.mockResolvedValue([]);
  saveAttendance.mockResolvedValue({
    attendance: {
      date: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
      status: "Working",
      workPeriod: "SECOND_HALF",
      submittedAt: "2026-09-23T10:00:00.000Z",
      timingStatus: "BEFORE_SHIFT",
      shiftName: "Morning Shift",
    },
  });
  render(<Attendance />);
  await screen.findByText("Morning Shift");
  await userEvent.click(screen.getByRole("button", { name: "Working" }));
  await userEvent.click(screen.getByRole("button", { name: "Second Half" }));
  await userEvent.click(screen.getByRole("button", { name: "Submit Attendance" }));
  await waitFor(() => expect(saveAttendance).toHaveBeenCalled());
  expect(saveAttendance.mock.calls[0][0][0].workPeriod).toBe("SECOND_HALF");
  expect(await screen.findByText("ON TIME")).toBeInTheDocument();
});

test("hides halves and resets to Full Day when assignment disables half-day", async () => {
  fetchEmployeeShift.mockResolvedValue(ASSIGNED_HALF_DAY);
  render(<Attendance />);
  await screen.findByText("Morning Shift");
  await userEvent.click(screen.getByRole("button", { name: "Working" }));
  await userEvent.click(screen.getByRole("button", { name: "First Half" }));
  expect(screen.getByRole("button", { name: "First Half" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  fetchEmployeeShift.mockResolvedValue({
    shift: { ...ASSIGNED.shift, halfDayEnabled: false },
  });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "First Half" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Full Day" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
  expect(screen.queryByRole("button", { name: "Second Half" })).not.toBeInTheDocument();
});

test("Leave Holiday and Weekly Off still render", async () => {
  render(<Attendance />);
  await screen.findByText("Morning Shift");
  await userEvent.click(screen.getByRole("button", { name: "Leave" }));
  expect(screen.getByText("Result: Absent — Leave")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Holiday" }));
  expect(screen.getByText("Result: Absent — Holiday")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Weekly Off" }));
  expect(screen.getByText("Result: Weekly Off")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Full Day" })).not.toBeInTheDocument();
});

test("Working with no assigned shift shows a clear validation message", async () => {
  fetchEmployeeShift.mockResolvedValue({ shift: null });
  render(<Attendance />);
  expect(await screen.findByText("Not assigned")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Working" }));
  expect(
    screen.getByText(
      "Working attendance cannot be submitted until an administrator assigns your shift."
    )
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit Attendance" })).toBeDisabled();
  expect(saveAttendance).not.toHaveBeenCalled();
});

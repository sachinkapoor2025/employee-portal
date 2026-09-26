jest.mock("../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../services/api", () => ({
  fetchMyDayActivity: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MyActivity from "./MyActivity";
import { fetchMyDayActivity } from "../services/api";
import { todayKeyIST } from "../utils/meetings";

const TODAY = todayKeyIST();
const YESTERDAY = "2026-09-24";

const EMPTY = {
  date: TODAY,
  employee: {
    email: "priya@mydgv.com",
    name: "Priya",
    empId: "DGV-101",
    department: "Engineering",
  },
  shift: {
    shiftId: null,
    name: null,
    startTime: null,
    endTime: null,
    crossesMidnight: false,
    graceMinutes: 0,
    source: "none",
  },
  attendance: { marked: false, status: null },
  tasks: [],
  presence: {
    kind: "portal_presence",
    notWorkingHours: true,
    lastSeen: null,
    eventCount: 0,
    events: [],
  },
};

const FULL = {
  date: TODAY,
  employee: {
    email: "priya@mydgv.com",
    name: "Priya",
    empId: "DGV-101",
    department: "Engineering",
  },
  shift: {
    shiftId: "morning",
    name: "Morning Shift",
    startTime: "11:00",
    endTime: "20:00",
    crossesMidnight: true,
    graceMinutes: 15,
    source: "current",
  },
  attendance: {
    marked: true,
    status: "Working",
    workPeriod: "FULL_DAY",
    expectedStartTime: "2026-09-25T11:00:00+05:30",
    expectedEndTime: "2026-09-25T20:00:00+05:30",
    actualCheckInTime: "2026-09-25T11:20:00+05:30",
    actualCheckOutTime: "2026-09-25T20:10:00+05:30",
    timingStatus: "LATE",
    lateMinutes: 20,
    workedBeyondShift: true,
    workedBeyondReason: "Finished a client call",
  },
  tasks: [
    {
      taskId: "task-1",
      title: "Shared banner",
      projectId: "proj-1",
      taskStatus: "IN_PROGRESS",
      assignmentStatus: "IN_PROGRESS",
      assignedAt: "2026-09-25T10:00:00+05:30",
      completedAt: null,
      startDate: "2026-09-25T11:00:00+05:30",
      dueDate: "2026-09-25T20:00:00+05:30",
      zone: "GREEN",
      overdue: false,
      timing: "On track",
      activity: [
        {
          timestamp: "2026-09-25T10:05:00+05:30",
          action: "assigned",
          detail: "Assigned to Priya",
          actorEmail: "admin@mydgv.com",
        },
      ],
    },
  ],
  presence: {
    kind: "portal_presence",
    notWorkingHours: true,
    lastSeen: "2026-09-25T12:00:00+05:30",
    eventCount: 1,
    events: [
      {
        timestamp: "2026-09-25T12:00:00+05:30",
        type: "login",
        page: "/attendance",
        device: "desktop",
      },
    ],
  },
};

beforeEach(() => {
  fetchMyDayActivity.mockReset();
  fetchMyDayActivity.mockResolvedValue(FULL);
});

test("page renders and loads company today", async () => {
  render(<MyActivity />);
  expect(screen.getByRole("heading", { name: "My Activity" })).toBeInTheDocument();
  await waitFor(() => expect(fetchMyDayActivity).toHaveBeenCalledWith(TODAY));
  expect(fetchMyDayActivity.mock.calls[0][0]).toBe(TODAY);
  expect(JSON.stringify(fetchMyDayActivity.mock.calls[0])).not.toMatch(/email=/);
});

test("date selector triggers reload", async () => {
  render(<MyActivity />);
  await screen.findByText("Morning Shift");
  const input = screen.getByLabelText("Date");
  await userEvent.clear(input);
  await userEvent.type(input, YESTERDAY);
  await waitFor(() =>
    expect(fetchMyDayActivity).toHaveBeenCalledWith(YESTERDAY)
  );
});

test("shift displays", async () => {
  render(<MyActivity />);
  expect(await screen.findByText("Morning Shift")).toBeInTheDocument();
  expect(screen.getAllByText(/11:00 AM/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/8:00 PM/).length).toBeGreaterThan(0);
  expect(screen.getByText("Overnight")).toBeInTheDocument();
});

test("attendance displays", async () => {
  render(<MyActivity />);
  expect(await screen.findByText("Working")).toBeInTheDocument();
  expect(screen.getByText("Full Day")).toBeInTheDocument();
  expect(screen.getByText(/LATE/)).toBeInTheDocument();
  expect(screen.getByText(/20 min late/)).toBeInTheDocument();
  expect(screen.getByText(/Finished a client call/)).toBeInTheDocument();
});

test("missing attendance renders empty state, not Absent", async () => {
  fetchMyDayActivity.mockResolvedValue(EMPTY);
  render(<MyActivity />);
  expect(
    await screen.findByText("No attendance recorded for this day.")
  ).toBeInTheDocument();
  expect(screen.queryByText("Absent")).not.toBeInTheDocument();
});

test("Holiday displays Holiday, not Absent", async () => {
  fetchMyDayActivity.mockResolvedValue({
    ...EMPTY,
    attendance: { marked: true, status: "Holiday", workPeriod: null },
  });
  render(<MyActivity />);
  expect(await screen.findByText("Holiday")).toBeInTheDocument();
  expect(screen.queryByText("Absent")).not.toBeInTheDocument();
});

test("tasks and task activity render", async () => {
  render(<MyActivity />);
  expect(await screen.findByText("Shared banner")).toBeInTheDocument();
  expect(screen.getByText("proj-1")).toBeInTheDocument();
  expect(screen.getByText(/Assigned to Priya/)).toBeInTheDocument();
  expect(screen.getByText(/admin@mydgv.com/)).toBeInTheDocument();
});

test("portal presence renders with not working hours", async () => {
  render(<MyActivity />);
  expect(
    await screen.findByText("Portal presence, not working hours")
  ).toBeInTheDocument();
  expect(screen.getByText(/login/)).toBeInTheDocument();
  expect(screen.queryByText(/sessionMinutes/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/totalMinutes/i)).not.toBeInTheDocument();
});

test("no tasks or presence still renders", async () => {
  fetchMyDayActivity.mockResolvedValue(EMPTY);
  render(<MyActivity />);
  expect(await screen.findByText("No shift assigned")).toBeInTheDocument();
  expect(screen.getByText("No tasks for this day.")).toBeInTheDocument();
  expect(
    screen.getByText("No portal presence events for this day.")
  ).toBeInTheDocument();
  expect(screen.getByText("Portal presence, not working hours")).toBeInTheDocument();
});

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
const PRIYA = "priya@mydgv.com";
const LEAD = "rahul@mydgv.com";

const EMPTY = {
  date: TODAY,
  employee: {
    email: PRIYA,
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
    email: PRIYA,
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
          timestamp: "2026-09-25T09:00:00+05:30",
          action: "task_created",
          detail: "Task created by admin",
          actorEmail: "admin@mydgv.com",
        },
        {
          timestamp: "2026-09-25T10:05:00+05:30",
          action: "status_changed",
          detail: `${PRIYA}: To Do → In Progress`,
          actorEmail: PRIYA,
          assignmentEmail: PRIYA,
        },
        {
          timestamp: "2026-09-25T10:10:00+05:30",
          action: "BLOCKER_REPORTED",
          detail: "Employee reported a blocker",
          actorEmail: LEAD,
          assignmentEmail: LEAD,
        },
        {
          timestamp: "2026-09-25T10:15:00+05:30",
          action: "deadline_changed",
          detail: "Deadline changed from none → 2026-09-25",
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
  await screen.findByText("Shared banner");
  const input = screen.getByLabelText("Date");
  await userEvent.clear(input);
  await userEvent.type(input, YESTERDAY);
  await waitFor(() =>
    expect(fetchMyDayActivity).toHaveBeenCalledWith(YESTERDAY)
  );
});

test("does not render Shift as work activity", async () => {
  render(<MyActivity />);
  expect(await screen.findByText("Shared banner")).toBeInTheDocument();
  expect(screen.queryByText("Morning Shift")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Shift" })).not.toBeInTheDocument();
  expect(screen.queryByText("No shift assigned")).not.toBeInTheDocument();
});

test("does not render Attendance, check-in, or LATE as work activity", async () => {
  render(<MyActivity />);
  expect(await screen.findByText("Shared banner")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Attendance" })).not.toBeInTheDocument();
  expect(screen.queryByText("Working")).not.toBeInTheDocument();
  expect(screen.queryByText("Full Day")).not.toBeInTheDocument();
  expect(screen.queryByText(/LATE/)).not.toBeInTheDocument();
  expect(screen.queryByText(/20 min late/)).not.toBeInTheDocument();
  expect(screen.queryByText("Actual check-in")).not.toBeInTheDocument();
  expect(screen.queryByText("Actual check-out")).not.toBeInTheDocument();
  expect(screen.queryByText(/Finished a client call/)).not.toBeInTheDocument();
});

test("does not render portal presence as work activity", async () => {
  render(<MyActivity />);
  expect(await screen.findByText("Shared banner")).toBeInTheDocument();
  expect(screen.queryByText("Portal presence")).not.toBeInTheDocument();
  expect(screen.queryByText(/not working hours/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/login/)).not.toBeInTheDocument();
  expect(screen.queryByText("/attendance")).not.toBeInTheDocument();
  expect(screen.queryByText("desktop")).not.toBeInTheDocument();
});

test("employee task cards and status/progress still appear", async () => {
  render(<MyActivity />);
  expect(await screen.findByText("Shared banner")).toBeInTheDocument();
  expect(screen.getByText("proj-1")).toBeInTheDocument();
  expect(screen.getAllByText("IN_PROGRESS").length).toBeGreaterThan(0);
  expect(screen.getByText("On track")).toBeInTheDocument();
});

test("own assignment activity appears and other assignment activity does not", async () => {
  render(<MyActivity />);
  expect(await screen.findByText(/To Do → In Progress/)).toBeInTheDocument();
  expect(screen.queryByText("Employee reported a blocker")).not.toBeInTheDocument();
});

test("task-wide activity without assignmentEmail still appears", async () => {
  render(<MyActivity />);
  expect(await screen.findByText(/Task created by admin/)).toBeInTheDocument();
  expect(screen.getByText(/Deadline changed from none/)).toBeInTheDocument();
});

test("empty tasks still renders without attendance or presence", async () => {
  fetchMyDayActivity.mockResolvedValue(EMPTY);
  render(<MyActivity />);
  expect(await screen.findByText("No tasks for this day.")).toBeInTheDocument();
  expect(screen.queryByText("No shift assigned")).not.toBeInTheDocument();
  expect(screen.queryByText("No attendance recorded for this day.")).not.toBeInTheDocument();
  expect(screen.queryByText("Portal presence")).not.toBeInTheDocument();
});

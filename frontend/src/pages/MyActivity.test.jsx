jest.mock("../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../services/api", () => ({
  fetchAttendance: jest.fn(),
  fetchTaskList: jest.fn(),
  fetchWeekOffState: jest.fn(),
}));

jest.mock("../services/auth", () => ({
  getLoggedInDisplayName: jest.fn(() => "Priya"),
  getLoggedInEmail: jest.fn(() => "priya@mydgv.com"),
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MyActivity from "./MyActivity";
import { fetchAttendance, fetchTaskList, fetchWeekOffState } from "../services/api";
import {
  addDaysToKey,
  currentWeekStartKey,
  formatWeekRange,
  startOfWeekKey,
  summarizeAttendanceWeek,
  summarizeTaskWeek,
  weekDateKeys,
} from "../utils/myActivityReport";

const WEEK_START = "2026-09-21";
const WEEK_END = "2026-09-27";
const TODAY = "2026-09-27";
const PRIYA = "priya@mydgv.com";
const LEAD = "rahul@mydgv.com";

function cardValue(label) {
  const labelEl = screen.getByText(label);
  const card = labelEl.closest(".dgv-stat-card");
  return within(card).getByText((_, node) =>
    node?.classList?.contains("dgv-stat-card__value")
  ).textContent;
}

async function renderLoaded() {
  render(<MyActivity />);
  await waitFor(() =>
    expect(screen.queryByText("Loading activity...")).not.toBeInTheDocument()
  );
}

function workingOnTime(date) {
  return {
    date,
    status: "Working",
    sessionStatus: "Checked Out",
    attendanceSubmittedAt: `${date}T11:05:00+05:30`,
    submittedAt: `${date}T11:05:00+05:30`,
    expectedStartTime: `${date}T11:00:00+05:30`,
    graceMinutes: 15,
  };
}

function workingLate(date) {
  return {
    date,
    status: "Working",
    sessionStatus: "Checked Out",
    attendanceSubmittedAt: `${date}T12:00:00+05:30`,
    submittedAt: `${date}T12:00:00+05:30`,
    expectedStartTime: `${date}T11:00:00+05:30`,
    graceMinutes: 15,
    timingStatus: "LATE",
  };
}

beforeEach(() => {
  fetchAttendance.mockReset();
  fetchTaskList.mockReset();
  fetchWeekOffState.mockReset();
  fetchAttendance.mockResolvedValue([]);
  fetchTaskList.mockResolvedValue({ tasks: [] });
  fetchWeekOffState.mockResolvedValue({
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    weekOffEntitlement: 1,
    weekOffUsed: 0,
    weekOffAvailable: 1,
    leaveUsed: 0,
    balance: 1,
  });
});

test("Monday-Sunday selected week is generated correctly", () => {
  expect(startOfWeekKey("2026-09-27")).toBe(WEEK_START);
  expect(startOfWeekKey("2026-09-23")).toBe(WEEK_START);
  expect(startOfWeekKey(WEEK_START)).toBe(WEEK_START);
  expect(weekDateKeys("2026-09-24")).toEqual([
    "2026-09-21",
    "2026-09-22",
    "2026-09-23",
    "2026-09-24",
    "2026-09-25",
    "2026-09-26",
    "2026-09-27",
  ]);
  expect(formatWeekRange(WEEK_START)).toBe("21 Sept 2026 – 27 Sept 2026");
});

test("Previous Week changes the week", async () => {
  const currentStart = currentWeekStartKey();
  await renderLoaded();
  expect(screen.getByLabelText("Selected week")).toHaveTextContent(
    formatWeekRange(currentStart)
  );
  await userEvent.click(screen.getByRole("button", { name: /Previous Week/ }));
  expect(screen.getByLabelText("Selected week")).toHaveTextContent(
    formatWeekRange(addDaysToKey(currentStart, -7))
  );
  await waitFor(() =>
    expect(fetchAttendance).toHaveBeenCalledWith(
      addDaysToKey(currentStart, -7),
      addDaysToKey(currentStart, -1)
    )
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading activity...")).not.toBeInTheDocument()
  );
});

test("Next Week changes the week", async () => {
  const currentStart = currentWeekStartKey();
  await renderLoaded();
  await userEvent.click(screen.getByRole("button", { name: /Next Week/ }));
  expect(screen.getByLabelText("Selected week")).toHaveTextContent(
    formatWeekRange(addDaysToKey(currentStart, 7))
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading activity...")).not.toBeInTheDocument()
  );
});

test("Current Week returns to current week", async () => {
  const currentStart = currentWeekStartKey();
  await renderLoaded();
  await userEvent.click(screen.getByRole("button", { name: /Previous Week/ }));
  await waitFor(() =>
    expect(screen.queryByText("Loading activity...")).not.toBeInTheDocument()
  );
  await userEvent.click(screen.getByRole("button", { name: /Current Week/ }));
  expect(screen.getByLabelText("Selected week")).toHaveTextContent(
    formatWeekRange(currentStart)
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading activity...")).not.toBeInTheDocument()
  );
});

test("seven days are evaluated and missing attendance becomes Not Marked", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: {},
    todayKey: TODAY,
  });
  expect(summary.daysEvaluated).toBe(7);
  expect(summary.notMarked).toBe(7);
  expect(summary.present).toBe(0);
  expect(summary.onTime).toBe(0);
  expect(summary.late).toBe(0);
});

test("Working becomes Present", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: {
      "2026-09-21": { date: "2026-09-21", status: "Working" },
    },
    todayKey: TODAY,
  });
  expect(summary.present).toBe(1);
  expect(summary.notMarked).toBe(6);
});

test("Present + ON TIME increments Present and On Time", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: { "2026-09-21": workingOnTime("2026-09-21") },
    todayKey: TODAY,
  });
  expect(summary.present).toBe(1);
  expect(summary.onTime).toBe(1);
  expect(summary.late).toBe(0);
});

test("Present + LATE increments Present and Late", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: { "2026-09-22": workingLate("2026-09-22") },
    todayKey: TODAY,
  });
  expect(summary.present).toBe(1);
  expect(summary.late).toBe(1);
  expect(summary.onTime).toBe(0);
});

test("Leave increments Leave but not Present or Late", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: {
      "2026-09-23": { date: "2026-09-23", status: "Leave" },
    },
    todayKey: TODAY,
  });
  expect(summary.leave).toBe(1);
  expect(summary.present).toBe(0);
  expect(summary.late).toBe(0);
  expect(summary.onTime).toBe(0);
});

test("Week Off increments Week Off but not Present or Late", () => {
  const weekly = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: {
      "2026-09-24": { date: "2026-09-24", status: "WeeklyOff" },
    },
    todayKey: TODAY,
  });
  expect(weekly.weekOff).toBe(1);
  expect(weekly.present).toBe(0);
  expect(weekly.late).toBe(0);

  const planned = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: {
      "2026-09-24": { date: "2026-09-24", status: "PlannedOff" },
    },
    todayKey: TODAY,
  });
  expect(planned.weekOff).toBe(1);
  expect(planned.present).toBe(0);
});

test("Holiday does not create an extra metric and is counted as Not Marked", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: {
      "2026-09-25": { date: "2026-09-25", status: "Holiday" },
    },
    todayKey: TODAY,
  });
  expect(summary.notMarked).toBe(7);
  expect(summary.present).toBe(0);
  expect(summary).not.toHaveProperty("holiday");
  expect(summary).not.toHaveProperty("absent");
});

test("page fetches attendance range and mine tasks without a zone filter", async () => {
  const currentStart = currentWeekStartKey();
  await renderLoaded();
  expect(fetchAttendance).toHaveBeenCalledWith(
    currentStart,
    addDaysToKey(currentStart, 6)
  );
  expect(fetchTaskList).toHaveBeenCalledWith({ mine: "true" });
  expect(fetchTaskList.mock.calls[0][0]).not.toHaveProperty("zone");
  expect(JSON.stringify(fetchAttendance.mock.calls[0])).not.toMatch(/email=/);
});

test("uses myAssignment rather than parent assignees or status", () => {
  const metrics = summarizeTaskWeek({
    weekStart: WEEK_START,
    tasks: [
      {
        taskId: "shared",
        status: "DONE",
        assignees: [PRIYA, LEAD],
        startDate: "2026-09-21",
        dueDate: "2026-09-27",
        zone: "GREEN",
        myAssignment: {
          email: PRIYA,
          status: "REVIEW",
          zone: "ORANGE",
          assignedAt: "2026-09-21T10:00:00+05:30",
        },
      },
    ],
  });
  expect(metrics.assigned).toBe(1);
  expect(metrics.underReview).toBe(1);
  expect(metrics.completed).toBe(0);
  expect(metrics.redZone).toBe(0);
});

test("removed assignments are excluded", () => {
  const metrics = summarizeTaskWeek({
    weekStart: WEEK_START,
    tasks: [
      {
        taskId: "removed",
        status: "IN_PROGRESS",
        startDate: "2026-09-21",
        dueDate: "2026-09-27",
        myAssignment: {
          email: PRIYA,
          status: "IN_PROGRESS",
          removed: true,
          zone: "RED",
        },
      },
    ],
  });
  expect(metrics).toEqual({
    assigned: 0,
    completed: 0,
    underReview: 0,
    redZone: 0,
  });
});

test("Assigned count uses work-window overlap", () => {
  const metrics = summarizeTaskWeek({
    weekStart: WEEK_START,
    tasks: [
      {
        taskId: "overlap",
        myAssignment: { email: PRIYA, status: "TODO" },
        startDate: "2026-09-20",
        dueDate: "2026-09-22",
      },
      {
        taskId: "outside",
        myAssignment: { email: PRIYA, status: "TODO" },
        startDate: "2026-09-10",
        dueDate: "2026-09-12",
      },
      {
        taskId: "fallback-assigned-at",
        myAssignment: {
          email: PRIYA,
          status: "TODO",
          assignedAt: "2026-09-24T09:00:00+05:30",
        },
      },
      {
        taskId: "fallback-outside",
        myAssignment: {
          email: PRIYA,
          status: "TODO",
          assignedAt: "2026-08-01T09:00:00+05:30",
        },
      },
    ],
  });
  expect(metrics.assigned).toBe(2);
});

test("Completed uses employee assignment completedAt or completedDate", () => {
  const metrics = summarizeTaskWeek({
    weekStart: WEEK_START,
    tasks: [
      {
        taskId: "mine-done",
        status: "IN_PROGRESS",
        startDate: "2026-09-10",
        dueDate: "2026-09-12",
        completedAt: "2026-08-01T10:00:00+05:30",
        myAssignment: {
          email: PRIYA,
          status: "DONE",
          completedAt: "2026-09-24T18:00:00+05:30",
          completedDate: "2026-09-24",
        },
      },
      {
        taskId: "other-done",
        status: "DONE",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        completedAt: "2026-09-24T18:00:00+05:30",
        myAssignment: {
          email: PRIYA,
          status: "IN_PROGRESS",
          completedAt: null,
        },
      },
    ],
  });
  expect(metrics.completed).toBe(1);
});

test("REVIEW uses employee assignment status", () => {
  const metrics = summarizeTaskWeek({
    weekStart: WEEK_START,
    tasks: [
      {
        taskId: "review",
        status: "IN_PROGRESS",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        myAssignment: { email: PRIYA, status: "REVIEW", zone: "GREEN" },
      },
    ],
  });
  expect(metrics.underReview).toBe(1);
});

test("RED uses employee assignment zone", () => {
  const metrics = summarizeTaskWeek({
    weekStart: WEEK_START,
    tasks: [
      {
        taskId: "red",
        status: "IN_PROGRESS",
        zone: "GREEN",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        myAssignment: { email: PRIYA, status: "IN_PROGRESS", zone: "RED" },
      },
    ],
  });
  expect(metrics.redZone).toBe(1);
});

test("multi-assignee task is counted only once for the logged-in employee", () => {
  const metrics = summarizeTaskWeek({
    weekStart: WEEK_START,
    tasks: [
      {
        taskId: "shared",
        status: "IN_PROGRESS",
        assignees: [PRIYA, LEAD],
        assignments: [
          { email: PRIYA, status: "IN_PROGRESS", zone: "GREEN" },
          { email: LEAD, status: "REVIEW", zone: "RED" },
        ],
        startDate: WEEK_START,
        dueDate: WEEK_END,
        myAssignment: { email: PRIYA, status: "IN_PROGRESS", zone: "GREEN" },
      },
    ],
  });
  expect(metrics.assigned).toBe(1);
  expect(metrics.underReview).toBe(0);
  expect(metrics.redZone).toBe(0);
});

test("zero-task week displays zero metrics instead of old empty task message", async () => {
  await renderLoaded();
  expect(cardValue("Assigned")).toBe("0");
  expect(cardValue("Completed")).toBe("0");
  expect(cardValue("Under Review")).toBe("0");
  expect(cardValue("Red Zone")).toBe("0");
  expect(cardValue("Present")).toBe("0");
  expect(cardValue("Not Marked")).toBe("7");
  expect(screen.queryByText("No tasks for this day.")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Date")).not.toBeInTheDocument();
  expect(screen.queryByText("Shared banner")).not.toBeInTheDocument();
});

test("page shows weekly attendance numbers without a task list", async () => {
  const currentStart = currentWeekStartKey();
  const keys = weekDateKeys(currentStart);
  fetchAttendance.mockResolvedValue([
    workingOnTime(keys[0]),
    workingLate(keys[1]),
    { date: keys[2], status: "Leave" },
    { date: keys[3], status: "WeeklyOff" },
    { date: keys[4], status: "Holiday" },
  ]);
  fetchTaskList.mockResolvedValue({
    tasks: [
      {
        taskId: "task-1",
        title: "Shared banner",
        startDate: keys[0],
        dueDate: keys[6],
        myAssignment: {
          email: PRIYA,
          status: "REVIEW",
          zone: "RED",
          completedAt: `${keys[5]}T18:00:00+05:30`,
        },
      },
    ],
  });

  await renderLoaded();
  expect(cardValue("Present")).toBe("2");
  expect(cardValue("On Time")).toBe("1");
  expect(cardValue("Late")).toBe("1");
  expect(cardValue("Leave")).toBe("1");
  expect(cardValue("Week Off")).toBe("1");
  expect(cardValue("Not Marked")).toBe("3");
  expect(cardValue("Assigned")).toBe("1");
  expect(cardValue("Completed")).toBe("1");
  expect(cardValue("Under Review")).toBe("1");
  expect(cardValue("Red Zone")).toBe("1");
  expect(screen.queryByText("Shared banner")).not.toBeInTheDocument();
  expect(screen.queryByText("Holiday")).not.toBeInTheDocument();
  expect(screen.queryByText("Absent")).not.toBeInTheDocument();
});

test("My Activity TIME OFF shows entitlement used leave and balance", async () => {
  fetchWeekOffState.mockResolvedValue({
    weekStart: currentWeekStartKey(),
    weekEnd: addDaysToKey(currentWeekStartKey(), 6),
    weekOffEntitlement: 1,
    weekOffUsed: 1,
    weekOffAvailable: 0,
    leaveUsed: 2,
    balance: -2,
  });
  await renderLoaded();
  expect(screen.getByRole("heading", { name: "TIME OFF" })).toBeInTheDocument();
  expect(cardValue("Week Off Entitlement")).toBe("1");
  expect(cardValue("Week Off Used")).toBe("1/1");
  expect(cardValue("Leave Used")).toBe("2");
  expect(cardValue("Balance")).toBe("-2");
});

test("Pending and rejected leave from the API do not reduce TIME OFF leave used", async () => {
  fetchWeekOffState.mockResolvedValue({
    weekStart: currentWeekStartKey(),
    weekEnd: addDaysToKey(currentWeekStartKey(), 6),
    weekOffEntitlement: 1,
    weekOffUsed: 0,
    weekOffAvailable: 1,
    leaveUsed: 0,
    balance: 1,
  });
  await renderLoaded();
  expect(cardValue("Leave Used")).toBe("0");
  expect(cardValue("Balance")).toBe("1");
});

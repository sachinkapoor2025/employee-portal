jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

const trackingRoute = { tab: "Tasks", from: "" };

jest.mock(
  "react-router-dom",
  () => ({
    useParams: () => ({ email: "priya@mydgv.com" }),
    useSearchParams: () => {
      const params = new URLSearchParams();
      if (trackingRoute.tab) params.set("tab", trackingRoute.tab);
      if (trackingRoute.from) params.set("from", trackingRoute.from);
      return [
        params,
        (next) => {
          const resolved =
            typeof next === "function" ? next(new URLSearchParams(params)) : next;
          const qs =
            resolved instanceof URLSearchParams
              ? resolved
              : new URLSearchParams(resolved);
          trackingRoute.tab = qs.get("tab") || "Overview";
          trackingRoute.from = qs.get("from") || "";
        },
      ];
    },
    Link: ({ to, children, ...rest }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchUserProfile: jest.fn(),
  fetchUsers: jest.fn(),
  fetchAttendance: jest.fn(),
  fetchTasks: jest.fn(),
  fetchAllLeave: jest.fn(),
  fetchAdminActivity: jest.fn(),
  fetchEmployeeShift: jest.fn(),
  fetchTaskActivity: jest.fn(),
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmployeeTracking, { assignmentForEmployee } from "./EmployeeTracking";
import {
  fetchUserProfile,
  fetchUsers,
  fetchAttendance,
  fetchTasks,
  fetchAllLeave,
  fetchAdminActivity,
  fetchEmployeeShift,
  fetchTaskActivity,
} from "../../services/api";
import {
  addDaysToKey,
  currentWeekStartKey,
  formatWeekRange,
  summarizeAttendanceWeek,
  weekDateKeys,
} from "../../utils/myActivityReport";
import {
  buildEmployeeActivityTrend,
  previousCompletedWeekStarts,
  priorityBucket,
  summarizeEmployeeWorkloadWeek,
  summarizeEmployeeWorkWeek,
  trendPercentHint,
} from "../../utils/adminEmployeeActivity";

const PRIYA = "priya@mydgv.com";
const CURRENT_SHIFT = {
  shiftId: "morning",
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 15,
  crossesMidnight: false,
};
const NIGHT_SHIFT = {
  shiftId: "night",
  name: "Night Shift",
  startTime: "22:00",
  endTime: "07:00",
  graceMinutes: 10,
  crossesMidnight: true,
};
const LEAD = "rahul@mydgv.com";
const OTHER = "outsider@mydgv.com";

const SOLO = {
  taskId: "task-solo",
  title: "Solo banner",
  projectId: "proj-1",
  status: "TODO",
  assignee: PRIYA,
  assignees: [PRIYA],
  startDate: "2026-09-25T11:00:00+05:30",
  dueDate: "2026-09-25T20:00:00+05:30",
  zone: "RED",
  timing: "Admin viewer timing",
  myAssignment: {
    email: "admin@mydgv.com",
    zone: "RED",
    timing: "Admin viewer timing",
  },
  assignments: [
    {
      email: PRIYA,
      status: "TODO",
      assignedAt: "2026-09-20T10:00:00+05:30",
      completedAt: null,
      zone: "GREEN",
      timing: "Priya on track",
      removed: false,
    },
  ],
};

const MULTI = {
  taskId: "task-multi",
  title: "Shared banner",
  projectId: "proj-2",
  status: "IN_PROGRESS",
  assignee: LEAD,
  assignees: [LEAD, PRIYA],
  startDate: "2026-09-25T11:00:00+05:30",
  dueDate: "2026-09-25T20:00:00+05:30",
  zone: "RED",
  timing: "Admin viewer timing",
  myAssignment: {
    email: "admin@mydgv.com",
    zone: "RED",
    timing: "Admin viewer timing",
  },
  assignments: [
    {
      email: LEAD,
      status: "TODO",
      assignedAt: "2026-09-21T09:00:00+05:30",
      zone: "RED",
      timing: "Lead overdue",
      removed: false,
    },
    {
      email: PRIYA,
      status: "IN_PROGRESS",
      assignedAt: "2026-09-22T09:15:00+05:30",
      completedAt: "2026-09-25T18:00:00+05:30",
      zone: "GREEN",
      timing: "Priya on track",
      removed: false,
    },
  ],
};

const UNRELATED = {
  taskId: "task-other",
  title: "Other person only",
  projectId: "proj-3",
  status: "TODO",
  assignee: OTHER,
  assignees: [OTHER],
  assignments: [
    {
      email: OTHER,
      status: "TODO",
      assignedAt: "2026-09-23T10:00:00+05:30",
      zone: "ORANGE",
      timing: "Other timing",
      removed: false,
    },
  ],
};

const SHIFT_CONFLICT_TASK = {
  taskId: "task-conflict",
  title: "Night banner",
  projectId: "proj-1",
  status: "TODO",
  archived: false,
  assignmentMode: "SCHEDULED",
  assignmentState: "PENDING",
  pendingAssignees: [PRIYA],
  lastShiftFitByEmail: { [PRIYA]: "SHIFT_CONFLICT" },
  startDate: "2026-09-25T22:00:00+05:30",
  dueDate: "2026-09-26T07:00:00+05:30",
  assignments: [],
};

const NO_SHIFT_TASK = {
  taskId: "task-noshift",
  title: "Uncovered evening job",
  projectId: "proj-2",
  status: "TODO",
  archived: false,
  assignmentMode: "SCHEDULED",
  assignmentState: "PENDING",
  pendingAssignees: [PRIYA],
  lastShiftFitByEmail: { [PRIYA]: "NO_SHIFT" },
  startDate: "2026-09-25T18:00:00+05:30",
  dueDate: "2026-09-25T22:00:00+05:30",
  assignments: [],
};

const LEAD_CONFLICT_TASK = {
  taskId: "task-lead-conflict",
  title: "Lead only conflict",
  projectId: "proj-1",
  status: "TODO",
  archived: false,
  assignmentMode: "SCHEDULED",
  assignmentState: "PENDING",
  pendingAssignees: [LEAD],
  lastShiftFitByEmail: { [LEAD]: "SHIFT_CONFLICT" },
  startDate: "2026-09-25T22:00:00+05:30",
  dueDate: "2026-09-26T07:00:00+05:30",
  assignments: [],
};

const ARCHIVED_CONFLICT_TASK = {
  ...SHIFT_CONFLICT_TASK,
  taskId: "task-archived-conflict",
  title: "Archived conflict",
  archived: true,
};

const ASSIGNED_AND_PENDING = {
  ...SOLO,
  pendingAssignees: [PRIYA],
  lastShiftFitByEmail: { [PRIYA]: "SHIFT_CONFLICT" },
  assignmentMode: "SCHEDULED",
  assignmentState: "PENDING",
};

function renderTracking() {
  return render(<EmployeeTracking />);
}

function localKey(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function attendanceRows() {
  const working = localKey(0);
  const first = localKey(1);
  const second = localKey(2);
  const leave = localKey(3);
  const planned = localKey(4);
  const holiday = localKey(5);
  const weekly = localKey(6);
  return [
    {
      date: working,
      status: "Working",
      workPeriod: "FULL_DAY",
      shiftName: "Morning Shift",
      expectedStartTime: `${working}T11:00:00+05:30`,
      expectedEndTime: `${working}T20:00:00+05:30`,
      checkInTime: `${working}T01:00:00+05:30`,
      checkOutTime: `${working}T02:00:00+05:30`,
      actualCheckInTime: `${working}T11:20:00+05:30`,
      actualCheckOutTime: `${working}T20:10:00+05:30`,
      attendanceSubmittedAt: `${working}T11:18:00+05:30`,
      graceMinutes: 5,
      timingStatus: "LATE",
      lateMinutes: 18,
      workedBeyondShift: true,
      workedBeyondReason: "Finished a client call",
    },
    {
      date: first,
      status: "Working",
      workPeriod: "FIRST_HALF",
      shiftName: "Morning Shift",
    },
    {
      date: second,
      status: "Working",
      workPeriod: "SECOND_HALF",
      shiftName: "Morning Shift",
    },
    { date: leave, status: "Leave" },
    { date: planned, status: "PlannedOff" },
    { date: holiday, status: "Holiday" },
    { date: weekly, status: "WeeklyOff" },
  ];
}

beforeEach(() => {
  trackingRoute.tab = "Tasks";
  trackingRoute.from = "";
  fetchUserProfile.mockResolvedValue({
    name: "Priya",
    empId: "DGV-101",
    department: "Engineering",
  });
  fetchUsers.mockResolvedValue([
    { email: PRIYA, role: "EMPLOYEE", status: "ACTIVE" },
  ]);
  fetchAttendance.mockResolvedValue([]);
  fetchAllLeave.mockResolvedValue([]);
  fetchAdminActivity.mockResolvedValue({ events: [] });
  fetchTasks.mockResolvedValue([SOLO, MULTI, UNRELATED]);
  fetchEmployeeShift.mockResolvedValue({ shift: CURRENT_SHIFT });
  fetchTaskActivity.mockResolvedValue([]);
});

test("tracked employee first assignee task is displayed", async () => {
  renderTracking();
  expect(await screen.findByText("Solo banner")).toBeInTheDocument();
  await waitFor(() =>
    expect(fetchTasks).toHaveBeenCalledWith({
      assignee: PRIYA,
      includePendingShiftConflicts: true,
    })
  );
  expect(
    screen.getByRole("link", { name: "Solo banner" })
  ).toHaveAttribute("href", "/admin/tasks/task-solo");
});

test("tracked employee is shown when they are not assignee[0]", async () => {
  renderTracking();
  expect(await screen.findByText("Shared banner")).toBeInTheDocument();
  expect(MULTI.assignee).toBe(LEAD);
  expect(
    screen.getByRole("link", { name: "Shared banner" })
  ).toHaveAttribute("href", "/admin/tasks/task-multi");
});

test("unrelated employee task is not displayed", async () => {
  renderTracking();
  await screen.findByText("Solo banner");
  expect(screen.queryByText("Other person only")).not.toBeInTheDocument();
});

test("assignment-level status assignedAt and completedAt are displayed", async () => {
  renderTracking();
  expect(await screen.findByText("Shared banner")).toBeInTheDocument();
  expect(screen.getAllByText("IN PROGRESS").length).toBeGreaterThan(0);
  expect(screen.getByText(/Assigned 22 Sept 2026/)).toBeInTheDocument();
  expect(screen.getByText(/Completed 25 Sept 2026/)).toBeInTheDocument();
});

test("uses tracked employee assignment zone and timing, not Admin viewer values", async () => {
  renderTracking();
  expect(await screen.findByText("Shared banner")).toBeInTheDocument();
  expect(screen.getAllByText("Green").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Priya on track").length).toBeGreaterThan(0);
  expect(screen.queryByText("Admin viewer timing")).not.toBeInTheDocument();
  expect(screen.queryByText("Lead overdue")).not.toBeInTheDocument();
});

async function renderAttendance(rows = attendanceRows()) {
  trackingRoute.tab = "Attendance";
  fetchAttendance.mockResolvedValue(rows);
  renderTracking();
  expect(await screen.findByRole("heading", { name: "Attendance" })).toBeInTheDocument();
}

test("Working Full Day shows expected by, marked at, and late minutes", async () => {
  await renderAttendance();
  expect(screen.getAllByText("LATE").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Morning Shift").length).toBeGreaterThan(0);
  expect(screen.getByText(/11:05 AM/)).toBeInTheDocument();
  expect(screen.getByText(/11:18 AM/)).toBeInTheDocument();
  expect(screen.getByText("13 min")).toBeInTheDocument();
  expect(screen.queryByText(/worked/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/sessionMinutes/i)).not.toBeInTheDocument();
});

test("First Half and Second Half working rows still render", async () => {
  await renderAttendance();
  expect(screen.getAllByText("ON TIME").length).toBeGreaterThan(0);
});

test("Leave PlannedOff Holiday and Weekly Off display as rule statuses", async () => {
  await renderAttendance();
  expect(screen.getAllByText("LEAVE").length).toBeGreaterThan(0);
  expect(screen.getAllByText("WEEK OFF").length).toBeGreaterThan(0);
  expect(screen.getByText("HOLIDAY")).toBeInTheDocument();
  expect(screen.queryByText("Absent")).not.toBeInTheDocument();
});

test("missing attendance row is NOT MARKED, not Absent", async () => {
  trackingRoute.tab = "Attendance";
  fetchAttendance.mockResolvedValue([]);
  renderTracking();
  const unmarked = await screen.findAllByText("NOT MARKED");
  expect(unmarked.length).toBeGreaterThan(0);
  expect(screen.queryByText("Absent")).not.toBeInTheDocument();
});

test("current assigned shift is displayed from GET employee shift", async () => {
  renderTracking();
  expect(await screen.findByText("Current assigned shift")).toBeInTheDocument();
  expect(screen.getByText("Morning Shift")).toBeInTheDocument();
  expect(fetchEmployeeShift).toHaveBeenCalledWith(PRIYA);
  expect(screen.queryByRole("button", { name: /assign/i })).not.toBeInTheDocument();
});

test("shift name start and end are displayed", async () => {
  renderTracking();
  expect(await screen.findByText("Morning Shift")).toBeInTheDocument();
  expect(screen.getAllByText(/11:00 AM/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/8:00 PM/).length).toBeGreaterThan(0);
});

test("grace minutes are displayed when available", async () => {
  renderTracking();
  expect(await screen.findByText("15 min")).toBeInTheDocument();
  expect(screen.getByText("Grace")).toBeInTheDocument();
});

test("overnight shift is displayed with indicator and window", async () => {
  fetchEmployeeShift.mockResolvedValue({ shift: NIGHT_SHIFT });
  renderTracking();
  expect(await screen.findByText("Night Shift")).toBeInTheDocument();
  expect(screen.getAllByText(/10:00 PM/).length).toBeGreaterThan(0);
  expect(screen.getByText(/7:00 AM \(next day\)/)).toBeInTheDocument();
  expect(screen.getByText("Overnight")).toBeInTheDocument();
  expect(screen.getByText("Yes")).toBeInTheDocument();
});

test("no shift assigned state is shown when employee has no current shift", async () => {
  fetchEmployeeShift.mockResolvedValue({ shift: null });
  renderTracking();
  expect(await screen.findByText("No shift assigned")).toBeInTheDocument();
  expect(screen.getByText("Current assigned shift")).toBeInTheDocument();
  expect(screen.queryByText("Morning Shift")).not.toBeInTheDocument();
});

test("attendance shift snapshot remains independent from current assigned shift", async () => {
  fetchEmployeeShift.mockResolvedValue({ shift: NIGHT_SHIFT });
  await renderAttendance();
  expect(await screen.findByText("Night Shift")).toBeInTheDocument();
  const table = screen.getByRole("table");
  expect(table).toHaveTextContent("Morning Shift");
  expect(table).not.toHaveTextContent("Night Shift");
});

function cardValue(label) {
  const labelEl = screen.getAllByText(label).find((el) =>
    el.classList.contains("dgv-stat-card__label")
  );
  const card = labelEl.closest(".dgv-stat-card");
  return within(card).getByText((_, node) =>
    node?.classList?.contains("dgv-stat-card__value")
  ).textContent;
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

function getAssignment(task) {
  return assignmentForEmployee(task, PRIYA);
}

async function renderActivityLoaded() {
  trackingRoute.tab = "Activity";
  renderTracking();
  expect(
    await screen.findByRole("heading", { name: "Employee Activity" })
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByText("Loading activity...")).not.toBeInTheDocument()
  );
}

async function renderActivity(activity = { events: [] }) {
  trackingRoute.tab = "Activity";
  fetchAdminActivity.mockResolvedValue(activity);
  await renderActivityLoaded();
}

const PORTAL_EVENTS = {
  summary: { totalMinutes: 240, eventCount: 2 },
  events: [
    {
      timestamp: "2026-09-25T10:05:00+05:30",
      type: "login",
      page: "/dashboard",
      device: "desktop",
      location: "Bengaluru",
    },
    {
      timestamp: "2026-09-25T10:20:00+05:30",
      type: "heartbeat",
      page: "/work",
      device: "desktop",
      location: "Bengaluru",
    },
  ],
};

test("Activity tab Monday-Sunday week is displayed", async () => {
  await renderActivityLoaded();
  expect(screen.getByRole("heading", { name: "Employee Activity" })).toBeInTheDocument();
  expect(screen.getByLabelText("Selected week")).toHaveTextContent(
    formatWeekRange(currentWeekStartKey())
  );
});

test("Activity Previous Week works", async () => {
  const currentStart = currentWeekStartKey();
  await renderActivityLoaded();
  await userEvent.click(screen.getByRole("button", { name: /Previous Week/ }));
  expect(screen.getByLabelText("Selected week")).toHaveTextContent(
    formatWeekRange(addDaysToKey(currentStart, -7))
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading activity...")).not.toBeInTheDocument()
  );
});

test("Activity Current Week works", async () => {
  const currentStart = currentWeekStartKey();
  await renderActivityLoaded();
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

test("Activity Next Week works", async () => {
  const currentStart = currentWeekStartKey();
  await renderActivityLoaded();
  await userEvent.click(screen.getByRole("button", { name: /Next Week/ }));
  expect(screen.getByLabelText("Selected week")).toHaveTextContent(
    formatWeekRange(addDaysToKey(currentStart, 7))
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading activity...")).not.toBeInTheDocument()
  );
});

test("Activity fetches attendance range and assignee tasks without a zone filter", async () => {
  await renderActivityLoaded();
  expect(fetchTasks).toHaveBeenCalledWith({ assignee: PRIYA });
  expect(fetchTasks.mock.calls[0][0]).not.toHaveProperty("zone");
  expect(fetchAttendance).toHaveBeenCalled();
  expect(fetchAttendance.mock.calls[0][2]).toBe(PRIYA);
  expect(fetchAdminActivity).not.toHaveBeenCalled();
  expect(fetchTaskActivity).not.toHaveBeenCalled();
});

test("Activity tab does not present portal presence as work activity", async () => {
  await renderActivity(PORTAL_EVENTS);
  expect(screen.getByRole("heading", { name: "Employee Activity" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Task activity" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Portal presence" })).not.toBeInTheDocument();
  expect(screen.queryByText("Portal presence is not working hours.")).not.toBeInTheDocument();
  expect(screen.queryByText("login")).not.toBeInTheDocument();
  expect(screen.queryByText("heartbeat")).not.toBeInTheDocument();
  expect(screen.queryByText("Last seen")).not.toBeInTheDocument();
  expect(screen.queryByText("Bengaluru")).not.toBeInTheDocument();
  expect(screen.queryByText("desktop")).not.toBeInTheDocument();
  expect(screen.queryByText("/dashboard")).not.toBeInTheDocument();
});

test("portal totalMinutes are not presented as working hours", async () => {
  await renderActivity(PORTAL_EVENTS);
  expect(screen.queryByText(/totalMinutes/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/session minutes/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/attendance hours/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/time worked/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/240 min/)).not.toBeInTheDocument();
});

test("Activity week attendance metrics render without a task list", async () => {
  const currentStart = currentWeekStartKey();
  const keys = weekDateKeys(currentStart);
  fetchAttendance.mockResolvedValue([
    workingOnTime(keys[0]),
    workingLate(keys[1]),
    { date: keys[2], status: "Leave" },
    { date: keys[3], status: "WeeklyOff" },
    { date: keys[4], status: "Holiday" },
  ]);
  fetchTasks.mockResolvedValue([]);
  await renderActivityLoaded();
  expect(cardValue("Present")).toBe("2");
  expect(cardValue("On Time")).toBe("1");
  expect(cardValue("Late")).toBe("1");
  expect(cardValue("Leave")).toBe("1");
  expect(cardValue("Week Off")).toBe("1");
  expect(cardValue("Not Marked")).toBe("3");
  expect(cardValue("Assigned")).toBe("0");
  expect(cardValue("Completed")).toBe("0");
  expect(screen.queryByText("Solo banner")).not.toBeInTheDocument();
  expect(screen.queryByText("No activity.")).not.toBeInTheDocument();
  expect(screen.queryByText("No tasks assigned to this employee.")).not.toBeInTheDocument();
});

test("SHIFT_CONFLICT appears for the tracked employee", async () => {
  fetchTasks.mockResolvedValue([SOLO, SHIFT_CONFLICT_TASK]);
  renderTracking();
  const card = await screen.findByRole("article", { name: "Night banner" });
  expect(within(card).getByText("Shift Conflict")).toBeInTheDocument();
  expect(within(card).getByText("proj-1")).toBeInTheDocument();
  expect(within(card).getByText(PRIYA)).toBeInTheDocument();
  expect(
    within(card).getByRole("link", { name: "Edit / Reassign" })
  ).toHaveAttribute("href", "/admin/tasks/task-conflict");
  expect(screen.getByText("Unresolved shift conflicts")).toBeInTheDocument();
  expect(screen.getByText(/Current assigned shift: Morning Shift/)).toBeInTheDocument();
  expect(screen.getByText("Solo banner")).toBeInTheDocument();
});

test("NO_SHIFT appears for the tracked employee", async () => {
  fetchTasks.mockResolvedValue([NO_SHIFT_TASK]);
  renderTracking();
  const card = await screen.findByRole("article", { name: "Uncovered evening job" });
  expect(within(card).getByText("No Shift Assigned")).toBeInTheDocument();
  expect(
    within(card).getByText(
      "This employee has no applicable assigned shift for this task."
    )
  ).toBeInTheDocument();
});

test("pendingAssignees membership is respected for conflicts", async () => {
  fetchTasks.mockResolvedValue([SHIFT_CONFLICT_TASK, LEAD_CONFLICT_TASK]);
  renderTracking();
  expect(await screen.findByText("Night banner")).toBeInTheDocument();
  expect(screen.queryByText("Lead only conflict")).not.toBeInTheDocument();
});

test("unrelated employee conflict is excluded", async () => {
  fetchTasks.mockResolvedValue([
    {
      ...LEAD_CONFLICT_TASK,
      taskId: "task-unrelated-conflict",
      title: "Someone else conflict",
      pendingAssignees: [OTHER],
      lastShiftFitByEmail: { [OTHER]: "SHIFT_CONFLICT" },
    },
  ]);
  renderTracking();
  expect(await screen.findByText("No tasks assigned to this employee.")).toBeInTheDocument();
  expect(screen.queryByText("Someone else conflict")).not.toBeInTheDocument();
  expect(screen.queryByText("Unresolved shift conflicts")).not.toBeInTheDocument();
});

test("archived or removed conflict is excluded", async () => {
  fetchTasks.mockResolvedValue([
    ARCHIVED_CONFLICT_TASK,
    {
      ...SHIFT_CONFLICT_TASK,
      taskId: "task-removed-pending",
      title: "Removed pending conflict",
      pendingAssignees: [],
    },
  ]);
  renderTracking();
  expect(await screen.findByText("No tasks assigned to this employee.")).toBeInTheDocument();
  expect(screen.queryByText("Archived conflict")).not.toBeInTheDocument();
  expect(screen.queryByText("Removed pending conflict")).not.toBeInTheDocument();
});

test("already assigned task is not duplicated as a conflict", async () => {
  fetchTasks.mockResolvedValue([ASSIGNED_AND_PENDING]);
  renderTracking();
  expect(await screen.findByText("Solo banner")).toBeInTheDocument();
  expect(screen.queryByText("Unresolved shift conflicts")).not.toBeInTheDocument();
  expect(screen.queryByText("Shift Conflict")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Solo banner" })).toBeInTheDocument();
});

const WEEK_START = "2026-09-21";
const WEEK_END = "2026-09-27";
const TODAY = "2026-09-27";

test("Activity attendance evaluates seven days and missing becomes Not Marked", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: {},
    todayKey: TODAY,
  });
  expect(summary.daysEvaluated).toBe(7);
  expect(summary.notMarked).toBe(7);
});

test("Activity Working becomes Present", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: { "2026-09-21": { status: "Working" } },
    todayKey: TODAY,
  });
  expect(summary.present).toBe(1);
});

test("Activity Present + On Time counts both", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: { "2026-09-21": workingOnTime("2026-09-21") },
    todayKey: TODAY,
  });
  expect(summary.present).toBe(1);
  expect(summary.onTime).toBe(1);
  expect(summary.late).toBe(0);
});

test("Activity Present + Late counts both", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: { "2026-09-22": workingLate("2026-09-22") },
    todayKey: TODAY,
  });
  expect(summary.present).toBe(1);
  expect(summary.late).toBe(1);
});

test("Activity Leave counts Leave not Present or Late", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: { "2026-09-23": { status: "Leave" } },
    todayKey: TODAY,
  });
  expect(summary.leave).toBe(1);
  expect(summary.present).toBe(0);
  expect(summary.late).toBe(0);
});

test("Activity Week Off counts Week Off not Present or Late", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: { "2026-09-24": { status: "WeeklyOff" } },
    todayKey: TODAY,
  });
  expect(summary.weekOff).toBe(1);
  expect(summary.present).toBe(0);
  expect(summary.late).toBe(0);
});

test("Activity Holiday counts Not Marked and does not add a Holiday metric", () => {
  const summary = summarizeAttendanceWeek({
    weekStart: WEEK_START,
    recordsByDate: { "2026-09-25": { status: "Holiday" } },
    todayKey: TODAY,
  });
  expect(summary.notMarked).toBe(7);
  expect(summary).not.toHaveProperty("holiday");
});

test("Activity uses assignmentForEmployee not Admin viewer myAssignment", () => {
  const task = {
    taskId: "shared",
    status: "IN_PROGRESS",
    priority: "HIGH",
    assignees: [PRIYA, LEAD],
    startDate: WEEK_START,
    dueDate: WEEK_END,
    zone: "RED",
    myAssignment: { email: "admin@mydgv.com", status: "REVIEW", zone: "RED" },
    assignments: [
      { email: PRIYA, status: "TODO", zone: "GREEN", removed: false },
      { email: LEAD, status: "REVIEW", zone: "RED", removed: false },
    ],
  };
  expect(assignmentForEmployee(task, PRIYA).email).toBe(PRIYA);
  expect(assignmentForEmployee(task, PRIYA).status).toBe("TODO");
  const workload = summarizeEmployeeWorkloadWeek({
    tasks: [task],
    weekStart: WEEK_START,
    getAssignment,
  });
  const work = summarizeEmployeeWorkWeek({
    tasks: [task],
    weekStart: WEEK_START,
    getAssignment,
  });
  expect(workload.assigned).toBe(1);
  expect(workload.high).toBe(1);
  expect(work.underReview).toBe(0);
  expect(work.redZone).toBe(0);
});

test("Activity multi-assignee task is counted only for the selected employee", () => {
  const work = summarizeEmployeeWorkWeek({
    tasks: [
      {
        taskId: "shared",
        priority: "HIGH",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        myAssignment: { email: LEAD, status: "REVIEW", zone: "RED" },
        assignments: [
          { email: LEAD, status: "REVIEW", zone: "RED" },
          { email: PRIYA, status: "IN_PROGRESS", zone: "GREEN" },
        ],
      },
    ],
    weekStart: WEEK_START,
    getAssignment,
  });
  expect(work.underReview).toBe(0);
  expect(work.redZone).toBe(0);
  expect(work.highPriorityRed).toBe(0);
});

test("Activity removed and cancelled assignments are excluded", () => {
  const workload = summarizeEmployeeWorkloadWeek({
    tasks: [
      {
        taskId: "removed",
        priority: "HIGH",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "TODO", removed: true, zone: "RED" }],
      },
      {
        taskId: "cancelled-assignment",
        priority: "HIGH",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "CANCELLED", zone: "RED" }],
      },
      {
        taskId: "cancelled-parent",
        status: "CANCELLED",
        priority: "HIGH",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "TODO", zone: "GREEN" }],
      },
    ],
    weekStart: WEEK_START,
    getAssignment,
  });
  expect(workload.assigned).toBe(0);
  expect(workload.high).toBe(0);
});

test("Activity assigned count uses work-window overlap and assignedAt fallback", () => {
  const workload = summarizeEmployeeWorkloadWeek({
    tasks: [
      {
        taskId: "overlap",
        assignments: [{ email: PRIYA, status: "TODO" }],
        startDate: "2026-09-20",
        dueDate: "2026-09-22",
      },
      {
        taskId: "outside",
        assignments: [{ email: PRIYA, status: "TODO" }],
        startDate: "2026-09-10",
        dueDate: "2026-09-12",
      },
      {
        taskId: "fallback",
        assignments: [
          { email: PRIYA, status: "TODO", assignedAt: "2026-09-24T09:00:00+05:30" },
        ],
      },
    ],
    weekStart: WEEK_START,
    getAssignment,
  });
  expect(workload.assigned).toBe(2);
});

test("Activity priority buckets count High Critical Medium Low separately", () => {
  expect(priorityBucket("HIGH")).toBe("high");
  expect(priorityBucket("CRITICAL")).toBe("critical");
  expect(priorityBucket("URGENT")).toBe("critical");
  expect(priorityBucket("MEDIUM")).toBe("medium");
  expect(priorityBucket("LOW")).toBe("low");
  const workload = summarizeEmployeeWorkloadWeek({
    tasks: [
      {
        taskId: "h",
        priority: "HIGH",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "TODO" }],
      },
      {
        taskId: "c",
        priority: "CRITICAL",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "TODO" }],
      },
      {
        taskId: "u",
        priority: "URGENT",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "TODO" }],
      },
      {
        taskId: "m",
        priority: "MEDIUM",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "TODO" }],
      },
      {
        taskId: "l",
        priority: "LOW",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "TODO" }],
      },
    ],
    weekStart: WEEK_START,
    getAssignment,
  });
  expect(workload.assigned).toBe(5);
  expect(workload.high).toBe(1);
  expect(workload.critical).toBe(2);
  expect(workload.medium).toBe(1);
  expect(workload.low).toBe(1);
  expect(workload.highCritical).toBe(3);
});

test("Activity URGENT is not silently treated as HIGH", () => {
  const workload = summarizeEmployeeWorkloadWeek({
    tasks: [
      {
        taskId: "urgent",
        priority: "URGENT",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "TODO", zone: "RED" }],
      },
    ],
    weekStart: WEEK_START,
    getAssignment,
  });
  expect(workload.high).toBe(0);
  expect(workload.critical).toBe(1);
  const work = summarizeEmployeeWorkWeek({
    tasks: [
      {
        taskId: "urgent",
        priority: "URGENT",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "TODO", zone: "RED" }],
      },
    ],
    weekStart: WEEK_START,
    getAssignment,
  });
  expect(work.redZone).toBe(1);
  expect(work.highPriorityRed).toBe(0);
});

test("Activity Completed uses employee assignment completedAt or completedDate", () => {
  const work = summarizeEmployeeWorkWeek({
    tasks: [
      {
        taskId: "mine-done",
        status: "IN_PROGRESS",
        startDate: "2026-09-10",
        dueDate: "2026-09-12",
        completedAt: "2026-08-01T10:00:00+05:30",
        assignments: [
          {
            email: PRIYA,
            status: "DONE",
            completedAt: "2026-09-24T18:00:00+05:30",
            completedDate: "2026-09-24",
          },
        ],
      },
      {
        taskId: "other-done",
        status: "DONE",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        completedAt: "2026-09-24T18:00:00+05:30",
        assignments: [{ email: PRIYA, status: "IN_PROGRESS", completedAt: null }],
      },
    ],
    weekStart: WEEK_START,
    getAssignment,
  });
  expect(work.completed).toBe(1);
});

test("Activity Review Red and High Priority Red use employee assignment", () => {
  const work = summarizeEmployeeWorkWeek({
    tasks: [
      {
        taskId: "review-green",
        status: "DONE",
        priority: "HIGH",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        zone: "RED",
        assignments: [{ email: PRIYA, status: "REVIEW", zone: "GREEN" }],
      },
      {
        taskId: "high-red",
        status: "IN_PROGRESS",
        priority: "HIGH",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        zone: "GREEN",
        assignments: [{ email: PRIYA, status: "IN_PROGRESS", zone: "RED" }],
      },
      {
        taskId: "critical-red",
        priority: "CRITICAL",
        startDate: WEEK_START,
        dueDate: WEEK_END,
        assignments: [{ email: PRIYA, status: "TODO", zone: "RED" }],
      },
    ],
    weekStart: WEEK_START,
    getAssignment,
  });
  expect(work.underReview).toBe(1);
  expect(work.redZone).toBe(2);
  expect(work.highPriorityRed).toBe(1);
});

test("Activity trend compares current week with previous four completed weeks", () => {
  const selected = WEEK_START;
  const previous = previousCompletedWeekStarts(selected, TODAY, 4);
  expect(previous).toHaveLength(4);
  const recordsByDate = {
    "2026-09-21": workingOnTime("2026-09-21"),
    "2026-09-22": workingOnTime("2026-09-22"),
  };
  previous.forEach((weekStart) => {
    recordsByDate[weekStart] = workingOnTime(weekStart);
  });
  const tasks = [
    {
      taskId: "now",
      priority: "HIGH",
      startDate: WEEK_START,
      dueDate: WEEK_END,
      assignments: [
        {
          email: PRIYA,
          status: "DONE",
          completedDate: "2026-09-24",
          completedAt: "2026-09-24T12:00:00+05:30",
        },
      ],
    },
    {
      taskId: "old",
      priority: "HIGH",
      startDate: previous[0],
      dueDate: addDaysToKey(previous[0], 6),
      assignments: [
        {
          email: PRIYA,
          status: "DONE",
          completedDate: previous[0],
          completedAt: `${previous[0]}T12:00:00+05:30`,
        },
      ],
    },
  ];
  const trend = buildEmployeeActivityTrend({
    selectedWeekStart: selected,
    recordsByDate,
    tasks,
    getAssignment,
    todayKey: TODAY,
  });
  expect(trend.ready).toBe(true);
  expect(trend.averages.present).toBe(1);
  expect(trendPercentHint(2, 1)).toBe("↑ 100% vs 4-week average");
  expect(trendPercentHint(1, 1)).toBe("vs 4-week average");
});

test("Activity trend does not present historical Red or Review or a performance score", async () => {
  await renderActivityLoaded();
  const trend = screen.getByRole("heading", { name: "Trend" }).closest("section");
  expect(within(trend).queryByText("Red Zone")).not.toBeInTheDocument();
  expect(within(trend).queryByText("Under Review")).not.toBeInTheDocument();
  expect(within(trend).queryByText("High Priority Red")).not.toBeInTheDocument();
  expect(screen.queryByText(/performance score/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/overwhelmed/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/underperforming/i)).not.toBeInTheDocument();
  expect(screen.getByText("Current week vs previous 4 completed weeks")).toBeInTheDocument();
});

function overviewSection(title) {
  return screen.getByRole("heading", { name: title }).closest("section");
}

function overviewCardValue(section, label) {
  const row = within(section).getByRole("group", { name: label });
  return row.querySelector("strong").textContent;
}

async function renderOverviewLoaded() {
  trackingRoute.tab = "Overview";
  renderTracking();
  expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
  );
}

test("tab query Overview activates Overview", async () => {
  trackingRoute.tab = "Overview";
  renderTracking();
  expect(await screen.findByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(screen.getByRole("heading", { name: "Overview" })).toBeInTheDocument();
});

test("tab query Activity activates Activity", async () => {
  trackingRoute.tab = "Activity";
  renderTracking();
  expect(await screen.findByRole("tab", { name: "Activity" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(
    await screen.findByRole("heading", { name: "Employee Activity" })
  ).toBeInTheDocument();
});

test("clicking Overview updates the selected tab and URL", async () => {
  trackingRoute.tab = "Activity";
  trackingRoute.from = "activity";
  renderTracking();
  expect(await screen.findByRole("tab", { name: "Activity" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
  expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(trackingRoute.tab).toBe("Overview");
  expect(trackingRoute.from).toBe("activity");
  expect(screen.getByRole("heading", { name: "Overview" })).toBeInTheDocument();
});

test("clicking Activity updates the selected tab and URL", async () => {
  trackingRoute.tab = "Overview";
  trackingRoute.from = "activity";
  renderTracking();
  expect(await screen.findByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
  expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(trackingRoute.tab).toBe("Activity");
  expect(trackingRoute.from).toBe("activity");
  expect(
    await screen.findByRole("heading", { name: "Employee Activity" })
  ).toBeInTheDocument();
});

test("Overview employee snapshot renders", async () => {
  await renderOverviewLoaded();
  expect(screen.getByRole("heading", { name: "Priya" })).toBeInTheDocument();
  expect(screen.getByText("DGV-101")).toBeInTheDocument();
  expect(screen.getByText(PRIYA)).toBeInTheDocument();
  expect(screen.getByText("Engineering")).toBeInTheDocument();
  expect(screen.getByText("Current assigned shift")).toBeInTheDocument();
  expect(screen.getByText("Morning Shift")).toBeInTheDocument();
});

test("Overview Attendance Tasks Documents Leave Training Performance and Activity summaries render", async () => {
  fetchUserProfile.mockResolvedValue({
    name: "Priya",
    empId: "DGV-101",
    department: "Engineering",
    designation: "Engineer",
    skill: "React",
  });
  await renderOverviewLoaded();
  expect(overviewSection("Attendance")).toBeInTheDocument();
  expect(overviewSection("Tasks")).toBeInTheDocument();
  expect(overviewSection("Documents")).toBeInTheDocument();
  expect(overviewSection("Leave")).toBeInTheDocument();
  expect(overviewSection("Training")).toBeInTheDocument();
  expect(overviewSection("Performance")).toBeInTheDocument();
  expect(overviewSection("Activity")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "View Attendance →" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "View Tasks →" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "View Documents →" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "View Leave →" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "View Training →" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "View Performance →" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "View Activity →" })).toBeInTheDocument();
  expect(within(overviewSection("Training")).getByText("Assigned Skill")).toBeInTheDocument();
  expect(within(overviewSection("Training")).getByText("React")).toBeInTheDocument();
  expect(overviewCardValue(overviewSection("Performance"), "Designation")).toBe("Engineer");
  expect(overviewCardValue(overviewSection("Performance"), "Skill")).toBe("React");
  expect(within(overviewSection("Documents")).getByText("Personal documents")).toBeInTheDocument();
  expect(
    within(overviewSection("Documents")).getByText("Available in Documents → Personal.")
  ).toBeInTheDocument();
  expect(within(overviewSection("Documents")).getByText("Required Documents")).toBeInTheDocument();
  expect(within(overviewSection("Documents")).getByText(/No verify\/reject workflow/)).toBeInTheDocument();
  expect(fetchAdminActivity).not.toHaveBeenCalled();
  expect(screen.queryByText("No activity.")).not.toBeInTheDocument();
});

test("Overview zero values render as 0", async () => {
  fetchTasks.mockResolvedValue([]);
  fetchAttendance.mockResolvedValue([]);
  fetchAllLeave.mockResolvedValue([]);
  await renderOverviewLoaded();
  expect(overviewCardValue(overviewSection("Attendance"), "Present")).toBe("0");
  expect(overviewCardValue(overviewSection("Attendance"), "On Time")).toBe("0");
  expect(overviewCardValue(overviewSection("Attendance"), "Late")).toBe("0");
  expect(overviewCardValue(overviewSection("Attendance"), "Leave")).toBe("0");
  expect(overviewCardValue(overviewSection("Attendance"), "Week Off")).toBe("0");
  expect(overviewCardValue(overviewSection("Tasks"), "Assigned")).toBe("0");
  expect(overviewCardValue(overviewSection("Tasks"), "Completed")).toBe("0");
  expect(overviewCardValue(overviewSection("Leave"), "Pending")).toBe("0");
  expect(overviewCardValue(overviewSection("Leave"), "Approved")).toBe("0");
  expect(overviewCardValue(overviewSection("Leave"), "Upcoming")).toBe("0");
  expect(overviewCardValue(overviewSection("Activity"), "Assigned")).toBe("0");
  expect(overviewCardValue(overviewSection("Activity"), "Red Zone")).toBe("0");
});

test("Overview View actions open the existing tracking tabs", async () => {
  await renderOverviewLoaded();
  await userEvent.click(screen.getByRole("button", { name: "View Attendance →" }));
  expect(screen.getByRole("heading", { name: "Attendance" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Attendance" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "View Tasks →" })).toBeInTheDocument()
  );
  await userEvent.click(screen.getByRole("button", { name: "View Tasks →" }));
  expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "View Documents →" })).toBeInTheDocument()
  );
  await userEvent.click(screen.getByRole("button", { name: "View Documents →" }));
  expect(screen.getByRole("heading", { name: "Documents" })).toBeInTheDocument();
  expect(screen.getByText(/Open personal folder/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
  await userEvent.click(await screen.findByRole("button", { name: "View Leave →" }));
  expect(screen.getByRole("heading", { name: "Leave" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
  await userEvent.click(await screen.findByRole("button", { name: "View Training →" }));
  expect(screen.getByRole("heading", { name: "Training" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
  await userEvent.click(await screen.findByRole("button", { name: "View Performance →" }));
  expect(screen.getByRole("heading", { name: "Performance" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
  await userEvent.click(await screen.findByRole("button", { name: "View Activity →" }));
  expect(
    await screen.findByRole("heading", { name: "Employee Activity" })
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByText("Loading activity...")).not.toBeInTheDocument()
  );
});



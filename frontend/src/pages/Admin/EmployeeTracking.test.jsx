jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

const trackingRoute = { tab: "Tasks" };

jest.mock(
  "react-router-dom",
  () => ({
    useParams: () => ({ email: "priya@mydgv.com" }),
    useSearchParams: () => [new URLSearchParams(`tab=${trackingRoute.tab}`)],
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
import EmployeeTracking from "./EmployeeTracking";
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

async function renderActivity(activity = { events: [] }) {
  trackingRoute.tab = "Activity";
  fetchAdminActivity.mockResolvedValue(activity);
  renderTracking();
  expect(await screen.findByRole("heading", { name: "Task activity" })).toBeInTheDocument();
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

test("Activity tab does not present portal presence as work activity", async () => {
  await renderActivity(PORTAL_EVENTS);
  expect(screen.getByRole("heading", { name: "Task activity" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Portal presence" })).not.toBeInTheDocument();
  expect(screen.queryByText("Portal presence is not working hours.")).not.toBeInTheDocument();
  expect(screen.queryByText("login")).not.toBeInTheDocument();
  expect(screen.queryByText("heartbeat")).not.toBeInTheDocument();
  expect(screen.queryByText("Last seen")).not.toBeInTheDocument();
});

test("portal totalMinutes are not presented as working hours", async () => {
  await renderActivity(PORTAL_EVENTS);
  expect(screen.queryByText(/totalMinutes/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/session minutes/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/attendance hours/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/time worked/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/240 min/)).not.toBeInTheDocument();
});

test("task activity is displayed for the tracked employee's tasks", async () => {
  fetchTaskActivity.mockImplementation((taskId) => {
    if (taskId === "task-solo") {
      return Promise.resolve([
        {
          timestamp: "2026-09-20T10:00:00+05:30",
          action: "task_created",
          detail: "Task created by admin",
          actorEmail: "admin@mydgv.com",
        },
        {
          timestamp: "2026-09-20T10:01:00+05:30",
          action: "task_assigned",
          detail: `Assigned to ${PRIYA}`,
          actorEmail: "admin@mydgv.com",
          assignmentEmail: PRIYA,
        },
      ]);
    }
    if (taskId === "task-multi") {
      return Promise.resolve([
        {
          timestamp: "2026-09-25T18:00:00+05:30",
          action: "task_completed",
          detail: `Completed by ${PRIYA} (zone GREEN)`,
          actorEmail: PRIYA,
          assignmentEmail: PRIYA,
        },
      ]);
    }
    return Promise.resolve([]);
  });
  await renderActivity();
  expect(await screen.findByText(/Task created/)).toBeInTheDocument();
  expect(screen.getByText(/Task assigned to/)).toBeInTheDocument();
  expect(screen.getByText(/Completed by priya@mydgv.com/)).toBeInTheDocument();
  await waitFor(() =>
    expect(fetchTaskActivity).toHaveBeenCalledWith("task-solo")
  );
  expect(fetchTaskActivity).toHaveBeenCalledWith("task-multi");
  expect(fetchTaskActivity).not.toHaveBeenCalledWith("task-other");
});

test("task activity remains associated with the correct task", async () => {
  fetchTaskActivity.mockImplementation((taskId) => {
    if (taskId === "task-solo") {
      return Promise.resolve([
        {
          timestamp: "2026-09-20T10:00:00+05:30",
          action: "task_created",
          detail: "Task created by admin",
          actorEmail: "admin@mydgv.com",
        },
      ]);
    }
    if (taskId === "task-multi") {
      return Promise.resolve([
        {
          timestamp: "2026-09-25T18:00:00+05:30",
          action: "task_completed",
          detail: `Completed by ${PRIYA} (zone GREEN)`,
          actorEmail: PRIYA,
          assignmentEmail: PRIYA,
        },
        {
          timestamp: "2026-09-24T09:00:00+05:30",
          action: "status_changed",
          detail: `${LEAD}: To Do → Done`,
          actorEmail: LEAD,
          assignmentEmail: LEAD,
        },
      ]);
    }
    return Promise.resolve([]);
  });
  await renderActivity();
  const solo = await screen.findByRole("article", { name: "Solo banner" });
  const shared = await screen.findByRole("article", { name: "Shared banner" });
  expect(within(solo).getByText(/Task created/)).toBeInTheDocument();
  expect(within(solo).queryByText(/Completed by priya@mydgv.com/)).not.toBeInTheDocument();
  expect(within(shared).getByText(/Completed by priya@mydgv.com/)).toBeInTheDocument();
  expect(within(shared).queryByText(/Task created/)).not.toBeInTheDocument();
  expect(screen.queryByText(/rahul@mydgv.com: To Do/)).not.toBeInTheDocument();
  expect(screen.queryByText("Other person only")).not.toBeInTheDocument();
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

jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../../utils/attendanceCompliance", () => {
  const actual = jest.requireActual("../../utils/attendanceCompliance");
  return {
    ...actual,
    companyTodayKey: () => "2026-09-26",
  };
});

jest.mock("../../services/api", () => ({
  fetchAllLeave: jest.fn(),
  reviewLeave: jest.fn(),
  fetchAttendanceActivity: jest.fn(),
}));

import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LeaveManagement from "./LeaveManagement";
import { fetchAllLeave, fetchAttendanceActivity, reviewLeave } from "../../services/api";

const ROWS = [
  {
    leaveId: "pending-today",
    email: "today@mydgv.com",
    type: "CASUAL",
    category: "LEAVE",
    fromDate: "2026-09-26",
    toDate: "2026-09-26",
    days: 1,
    status: "PENDING_APPROVAL",
    submittedAt: "2026-09-26T02:00:00.000Z",
    approvalDeadline: "2026-09-26T07:00:00.000Z",
    remainingMs: 5 * 60 * 60 * 1000,
  },
  {
    leaveId: "pending-tomorrow",
    email: "later@mydgv.com",
    type: "SICK",
    category: "LEAVE",
    fromDate: "2026-09-27",
    toDate: "2026-09-27",
    days: 1,
    status: "PENDING_APPROVAL",
    submittedAt: "2026-09-26T02:00:00.000Z",
    approvalDeadline: "2026-09-26T07:00:00.000Z",
    remainingMs: 5 * 60 * 60 * 1000,
  },
  {
    leaveId: "rejected-today",
    email: "rejected@mydgv.com",
    type: "CASUAL",
    category: "LEAVE",
    fromDate: "2026-09-26",
    toDate: "2026-09-26",
    days: 1,
    status: "REJECTED",
  },
];

function weekOffTodaySection() {
  return screen.getByRole("heading", { name: "Week Off Today" }).closest("section");
}

function leaveRequestsTodaySection() {
  return screen
    .getByRole("heading", { name: "Leave Requests Today" })
    .closest("section");
}

function weekOffTable() {
  return within(weekOffTodaySection()).queryByRole("table");
}

function leaveRequestsTable() {
  return within(leaveRequestsTodaySection()).queryByRole("table");
}

function summaryCardValue(label) {
  const labelEl = screen.getByText(label, { selector: ".dgv-stat-card__label" });
  return labelEl.closest(".dgv-stat-card").querySelector(".dgv-stat-card__value")
    .textContent;
}

function weekOffHistorySection() {
  return screen.getByRole("heading", { name: "WEEK OFF HISTORY" }).closest("section");
}

function leaveHistorySection() {
  return screen.getByRole("heading", { name: "LEAVE HISTORY" }).closest("section");
}

async function openHistoryView() {
  await userEvent.click(screen.getByRole("button", { name: "History" }));
  expect(
    await screen.findByRole("heading", { name: "Leave & Time Off History" })
  ).toBeInTheDocument();
}

beforeEach(() => {
  fetchAttendanceActivity.mockReset();
  fetchAllLeave.mockReset();
  reviewLeave.mockReset();
  fetchAttendanceActivity.mockResolvedValue({ items: [] });
});

test("page title is Leave & Time Off and History remains available", async () => {
  fetchAllLeave.mockResolvedValue([]);
  render(<LeaveManagement />);
  expect(
    await screen.findByRole("heading", { name: "Leave & Time Off" })
  ).toBeInTheDocument();
  expect(
    screen.getByText("Manage today's leave requests and employee week offs.")
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "History" })).toBeInTheDocument();
  expect(screen.getByText(/TODAY · 26 Sept 2026/)).toBeInTheDocument();
});

test("Today summary cards count unique Week Off, On Leave, and Pending", async () => {
  fetchAllLeave.mockResolvedValue([
    {
      leaveId: "wo-1",
      email: "rahul@mydgv.com",
      fromDate: "2026-09-26",
      toDate: "2026-09-26",
      status: "PLANNED_OFF",
      category: "PLANNED_OFF",
      type: "PLANNED_OFF",
    },
    {
      leaveId: "approved-1",
      email: "leave@mydgv.com",
      type: "SICK",
      category: "LEAVE",
      fromDate: "2026-09-26",
      toDate: "2026-09-26",
      status: "APPROVED",
    },
    {
      leaveId: "approved-dup",
      email: "leave@mydgv.com",
      type: "CASUAL",
      category: "LEAVE",
      fromDate: "2026-09-26",
      toDate: "2026-09-26",
      status: "APPROVED",
    },
    ...ROWS,
  ]);
  fetchAttendanceActivity.mockResolvedValue({
    items: [
      { email: "nitesh@mydgv.com", date: "2026-09-26", status: "WeeklyOff" },
      { email: "rahul@mydgv.com", date: "2026-09-26", status: "WeeklyOff" },
    ],
  });
  render(<LeaveManagement />);
  expect(await screen.findByText("nitesh@mydgv.com")).toBeInTheDocument();
  expect(summaryCardValue("Week Off")).toBe("2");
  expect(summaryCardValue("On Leave")).toBe("1");
  expect(summaryCardValue("Pending")).toBe("1");
});

test("History opens with last 30 days to today and keeps Approve/Reject", async () => {
  fetchAllLeave.mockResolvedValue(ROWS);
  render(<LeaveManagement />);

  expect(await screen.findByText("today@mydgv.com")).toBeInTheDocument();
  expect(screen.queryByText("later@mydgv.com")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /act/i }));
  expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();

  await openHistoryView();
  expect(screen.getByLabelText("From Date")).toHaveValue("2026-08-28");
  expect(screen.getByLabelText("To Date")).toHaveValue("2026-09-26");
  expect(screen.getByLabelText("Type")).toHaveValue("ALL");
  expect(screen.getByLabelText("Status")).toHaveValue("ALL");
  expect(screen.getByPlaceholderText("Search employee...")).toHaveValue("");
  expect(
    screen.getByRole("heading", { name: "WEEK OFF HISTORY" })
  ).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "LEAVE HISTORY" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "← Back to Today" })).toBeInTheDocument();
  expect(within(leaveHistorySection()).getByText("today@mydgv.com")).toBeInTheDocument();
  expect(within(leaveHistorySection()).getByText("rejected@mydgv.com")).toBeInTheDocument();
  expect(screen.queryByText("later@mydgv.com")).not.toBeInTheDocument();

  await userEvent.click(within(leaveHistorySection()).getByRole("button", { name: /act/i }));
  expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
});

test("direct Attendance WeeklyOff appears in Admin Leave Week Off", async () => {
  fetchAllLeave.mockResolvedValue([]);
  fetchAttendanceActivity.mockResolvedValue({
    items: [
      {
        email: "nitesh@mydgv.com",
        date: "2026-09-26",
        status: "WeeklyOff",
        submittedAt: "2026-09-26T03:30:00.000Z",
      },
    ],
  });
  render(<LeaveManagement />);
  const table = await waitFor(() => {
    expect(screen.getByText("nitesh@mydgv.com")).toBeInTheDocument();
    return weekOffTable();
  });
  expect(within(table).getByText("nitesh@mydgv.com")).toBeInTheDocument();
  expect(within(table).getByText("Attendance")).toBeInTheDocument();
  expect(within(table).getByText("Week Off")).toBeInTheDocument();
  expect(within(weekOffTodaySection()).queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  expect(within(weekOffTodaySection()).queryByRole("button", { name: /reject/i })).not.toBeInTheDocument();
  expect(fetchAttendanceActivity).toHaveBeenCalledWith(
    expect.objectContaining({ date: "2026-09-26" })
  );
});

test("existing PLANNED_OFF Week Off still appears", async () => {
  fetchAllLeave.mockResolvedValue([
    {
      leaveId: "wo-1",
      email: "rahul@mydgv.com",
      fromDate: "2026-09-26",
      toDate: "2026-09-26",
      days: 1,
      status: "PLANNED_OFF",
      category: "PLANNED_OFF",
      type: "PLANNED_OFF",
    },
  ]);
  render(<LeaveManagement />);
  const table = await waitFor(() => {
    expect(screen.getByText("rahul@mydgv.com")).toBeInTheDocument();
    return weekOffTable();
  });
  expect(within(table).getByText("rahul@mydgv.com")).toBeInTheDocument();
  expect(within(table).getAllByText("Week Off").length).toBeGreaterThanOrEqual(1);
  expect(leaveRequestsTable()).toBeNull();
  expect(
    within(leaveRequestsTodaySection()).queryByText("rahul@mydgv.com")
  ).not.toBeInTheDocument();
});

test("Leave records do not appear in the Week Off section", async () => {
  fetchAllLeave.mockResolvedValue([
    ...ROWS,
    {
      leaveId: "approved-leave",
      email: "leave@mydgv.com",
      type: "SICK",
      category: "LEAVE",
      fromDate: "2026-09-26",
      toDate: "2026-09-26",
      days: 1,
      status: "APPROVED",
    },
  ]);
  fetchAttendanceActivity.mockResolvedValue({
    items: [{ email: "leave@mydgv.com", date: "2026-09-26", status: "Leave" }],
  });
  render(<LeaveManagement />);
  expect(await screen.findByText("today@mydgv.com")).toBeInTheDocument();
  expect(screen.getByText("leave@mydgv.com")).toBeInTheDocument();
  expect(weekOffTable()).toBeNull();
  expect(
    within(weekOffTodaySection()).queryByText("today@mydgv.com")
  ).not.toBeInTheDocument();
  expect(
    within(weekOffTodaySection()).queryByText("leave@mydgv.com")
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("No employees are taking a Week Off today.")
  ).toBeInTheDocument();
});

test("multiple employees with WeeklyOff are all shown", async () => {
  fetchAllLeave.mockResolvedValue([]);
  fetchAttendanceActivity.mockResolvedValue({
    items: [
      { email: "nitesh@mydgv.com", date: "2026-09-26", status: "WeeklyOff" },
      { email: "priya@mydgv.com", date: "2026-09-26", status: "WeeklyOff" },
    ],
  });
  render(<LeaveManagement />);
  expect(await screen.findByText("nitesh@mydgv.com")).toBeInTheDocument();
  expect(within(weekOffTable()).getByText("priya@mydgv.com")).toBeInTheDocument();
});

test("same employee and date from both sources is displayed once", async () => {
  fetchAllLeave.mockResolvedValue([
    {
      leaveId: "wo-nitesh",
      email: "nitesh@mydgv.com",
      fromDate: "2026-09-26",
      toDate: "2026-09-26",
      days: 1,
      status: "PLANNED_OFF",
      category: "PLANNED_OFF",
      type: "PLANNED_OFF",
    },
  ]);
  fetchAttendanceActivity.mockResolvedValue({
    items: [{ email: "nitesh@mydgv.com", date: "2026-09-26", status: "WeeklyOff" }],
  });
  render(<LeaveManagement />);
  expect(await screen.findByText("nitesh@mydgv.com")).toBeInTheDocument();
  expect(within(weekOffTable()).getAllByText("nitesh@mydgv.com")).toHaveLength(1);
});

test("WeeklyOff from another date is not shown in Today", async () => {
  fetchAllLeave.mockResolvedValue([]);
  fetchAttendanceActivity.mockResolvedValue({
    items: [
      { email: "yesterday@mydgv.com", date: "2026-09-25", status: "WeeklyOff" },
      { email: "todayoff@mydgv.com", date: "2026-09-26", status: "WeeklyOff" },
    ],
  });
  render(<LeaveManagement />);
  expect(await screen.findByText("todayoff@mydgv.com")).toBeInTheDocument();
  expect(screen.queryByText("yesterday@mydgv.com")).not.toBeInTheDocument();
});

test("Approve still calls the existing reviewLeave API", async () => {
  fetchAllLeave.mockResolvedValue(ROWS);
  reviewLeave.mockResolvedValue({});
  render(<LeaveManagement />);
  await userEvent.click(await screen.findByRole("button", { name: /act/i }));
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(reviewLeave).toHaveBeenCalledWith("pending-today", "APPROVED", "")
  );
});

test("Reject still calls the existing reviewLeave API", async () => {
  fetchAllLeave.mockResolvedValue(ROWS);
  reviewLeave.mockResolvedValue({});
  window.prompt = jest.fn(() => "Need coverage");
  render(<LeaveManagement />);
  await userEvent.click(await screen.findByRole("button", { name: /act/i }));
  await userEvent.click(screen.getByRole("button", { name: "Reject" }));
  await waitFor(() =>
    expect(reviewLeave).toHaveBeenCalledWith(
      "pending-today",
      "REJECTED",
      "Need coverage"
    )
  );
});

test("empty Week Off Today hides the table header", async () => {
  fetchAllLeave.mockResolvedValue([]);
  render(<LeaveManagement />);
  expect(
    await screen.findByText("No employees are taking a Week Off today.")
  ).toBeInTheDocument();
  expect(weekOffTable()).toBeNull();
  expect(screen.queryByRole("columnheader", { name: "Source" })).not.toBeInTheDocument();
});

test("empty Leave Requests Today shows the empty state", async () => {
  fetchAllLeave.mockResolvedValue([]);
  fetchAttendanceActivity.mockResolvedValue({
    items: [{ email: "nitesh@mydgv.com", date: "2026-09-26", status: "WeeklyOff" }],
  });
  render(<LeaveManagement />);
  expect(await screen.findByText("nitesh@mydgv.com")).toBeInTheDocument();
  expect(screen.getByText("No leave requests covering today.")).toBeInTheDocument();
  expect(leaveRequestsTable()).toBeNull();
});

test("Pending Leave still has Approve and Reject on Today", async () => {
  fetchAllLeave.mockResolvedValue(ROWS);
  render(<LeaveManagement />);
  await userEvent.click(await screen.findByRole("button", { name: /act/i }));
  expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  expect(within(weekOffTodaySection()).queryByRole("button", { name: /act/i })).not.toBeInTheDocument();
});

const HISTORY_ROWS = [
  ...ROWS,
  {
    leaveId: "approved-past",
    email: "approved@mydgv.com",
    type: "CASUAL",
    category: "LEAVE",
    fromDate: "2026-09-10",
    toDate: "2026-09-10",
    days: 1,
    status: "APPROVED",
  },
  {
    leaveId: "cancelled-past",
    email: "cancelled@mydgv.com",
    type: "SICK",
    category: "LEAVE",
    fromDate: "2026-09-12",
    toDate: "2026-09-12",
    days: 1,
    status: "CANCELLED",
  },
  {
    leaveId: "wo-past",
    email: "rahul@mydgv.com",
    fromDate: "2026-09-20",
    toDate: "2026-09-20",
    days: 1,
    status: "PLANNED_OFF",
    category: "PLANNED_OFF",
    type: "PLANNED_OFF",
  },
  {
    leaveId: "wo-nitesh",
    email: "nitesh@mydgv.com",
    employeeName: "Nitesh Shukla",
    fromDate: "2026-09-22",
    toDate: "2026-09-22",
    days: 1,
    status: "PLANNED_OFF",
    category: "PLANNED_OFF",
    type: "PLANNED_OFF",
  },
];

function mockAttendanceByView({ today = [], history = [] } = {}) {
  fetchAttendanceActivity.mockImplementation(async (params = {}) => {
    if (params.date) return { items: today };
    return { items: history };
  });
}

test("Type All shows both history sections", async () => {
  fetchAllLeave.mockResolvedValue(HISTORY_ROWS);
  mockAttendanceByView({
    history: [
      {
        email: "priya@mydgv.com",
        employeeName: "Priya",
        date: "2026-09-18",
        status: "WeeklyOff",
      },
    ],
  });
  render(<LeaveManagement />);
  await screen.findByRole("heading", { name: "Leave & Time Off" });
  await openHistoryView();
  expect(await screen.findByText("Priya")).toBeInTheDocument();
  expect(within(weekOffHistorySection()).getByText("Priya")).toBeInTheDocument();
  expect(within(weekOffHistorySection()).getByText("Attendance")).toBeInTheDocument();
  expect(within(leaveHistorySection()).getByText("approved@mydgv.com")).toBeInTheDocument();
});

test("Type Leave hides Week Off history section", async () => {
  fetchAllLeave.mockResolvedValue(HISTORY_ROWS);
  mockAttendanceByView({
    history: [{ email: "priya@mydgv.com", date: "2026-09-18", status: "WeeklyOff" }],
  });
  render(<LeaveManagement />);
  await screen.findByRole("heading", { name: "Leave & Time Off" });
  await openHistoryView();
  await userEvent.selectOptions(screen.getByLabelText("Type"), "Leave");
  expect(
    screen.queryByRole("heading", { name: "WEEK OFF HISTORY" })
  ).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "LEAVE HISTORY" })).toBeInTheDocument();
  expect(screen.queryByText("priya@mydgv.com")).not.toBeInTheDocument();
});

test("Type Week Off hides Leave history section", async () => {
  fetchAllLeave.mockResolvedValue(HISTORY_ROWS);
  mockAttendanceByView({
    history: [{ email: "priya@mydgv.com", date: "2026-09-18", status: "WeeklyOff" }],
  });
  render(<LeaveManagement />);
  await screen.findByRole("heading", { name: "Leave & Time Off" });
  await openHistoryView();
  await userEvent.selectOptions(screen.getByLabelText("Type"), "Week Off");
  expect(
    screen.queryByRole("heading", { name: "LEAVE HISTORY" })
  ).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "WEEK OFF HISTORY" })).toBeInTheDocument();
  expect(screen.queryByText("approved@mydgv.com")).not.toBeInTheDocument();
});

test("employee search filters history by name and email", async () => {
  fetchAllLeave.mockResolvedValue(HISTORY_ROWS);
  mockAttendanceByView({
    history: [
      {
        email: "nitesh@mydgv.com",
        employeeName: "Nitesh Shukla",
        date: "2026-09-15",
        status: "WeeklyOff",
      },
    ],
  });
  render(<LeaveManagement />);
  await screen.findByRole("heading", { name: "Leave & Time Off" });
  await openHistoryView();
  await userEvent.type(screen.getByPlaceholderText("Search employee..."), "Nitesh");
  expect(within(weekOffHistorySection()).getAllByText("Nitesh Shukla").length).toBeGreaterThan(0);
  expect(screen.queryByText("approved@mydgv.com")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
  await userEvent.type(screen.getByPlaceholderText("Search employee..."), "approved@");
  expect(within(leaveHistorySection()).getByText("approved@mydgv.com")).toBeInTheDocument();
  expect(screen.queryByText("Nitesh Shukla")).not.toBeInTheDocument();
});

test("From and To date filters hide records outside the company date range", async () => {
  fetchAllLeave.mockResolvedValue(HISTORY_ROWS);
  mockAttendanceByView({
    history: [
      { email: "oldoff@mydgv.com", date: "2026-09-05", status: "WeeklyOff" },
      { email: "newoff@mydgv.com", date: "2026-09-22", status: "WeeklyOff" },
    ],
  });
  render(<LeaveManagement />);
  await screen.findByRole("heading", { name: "Leave & Time Off" });
  await openHistoryView();
  fireEvent.change(screen.getByLabelText("From Date"), { target: { value: "2026-09-20" } });
  fireEvent.change(screen.getByLabelText("To Date"), { target: { value: "2026-09-26" } });
  expect(within(weekOffHistorySection()).getByText("newoff@mydgv.com")).toBeInTheDocument();
  expect(screen.queryByText("oldoff@mydgv.com")).not.toBeInTheDocument();
  expect(screen.queryByText("approved@mydgv.com")).not.toBeInTheDocument();
});

test("Approved Rejected and Cancelled status filters Leave only", async () => {
  fetchAllLeave.mockResolvedValue(HISTORY_ROWS);
  mockAttendanceByView({
    history: [{ email: "priya@mydgv.com", date: "2026-09-18", status: "WeeklyOff" }],
  });
  render(<LeaveManagement />);
  await screen.findByRole("heading", { name: "Leave & Time Off" });
  await openHistoryView();
  await userEvent.selectOptions(screen.getByLabelText("Status"), "Approved");
  expect(within(leaveHistorySection()).getByText("approved@mydgv.com")).toBeInTheDocument();
  expect(within(leaveHistorySection()).queryByText("rejected@mydgv.com")).not.toBeInTheDocument();
  expect(within(weekOffHistorySection()).getByText("priya@mydgv.com")).toBeInTheDocument();

  await userEvent.selectOptions(screen.getByLabelText("Status"), "Rejected");
  expect(within(leaveHistorySection()).getByText("rejected@mydgv.com")).toBeInTheDocument();
  expect(within(leaveHistorySection()).queryByText("approved@mydgv.com")).not.toBeInTheDocument();
  expect(within(weekOffHistorySection()).getByText("priya@mydgv.com")).toBeInTheDocument();

  await userEvent.selectOptions(screen.getByLabelText("Status"), "Cancelled");
  expect(within(leaveHistorySection()).getByText("cancelled@mydgv.com")).toBeInTheDocument();
  expect(within(weekOffHistorySection()).getByText("priya@mydgv.com")).toBeInTheDocument();
});

test("Week Off type with Approved status still shows Week Off records", async () => {
  fetchAllLeave.mockResolvedValue(HISTORY_ROWS);
  mockAttendanceByView({
    history: [{ email: "priya@mydgv.com", date: "2026-09-18", status: "WeeklyOff" }],
  });
  render(<LeaveManagement />);
  await screen.findByRole("heading", { name: "Leave & Time Off" });
  await openHistoryView();
  await userEvent.selectOptions(screen.getByLabelText("Type"), "Week Off");
  await userEvent.selectOptions(screen.getByLabelText("Status"), "Approved");
  expect(within(weekOffHistorySection()).getByText("priya@mydgv.com")).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "LEAVE HISTORY" })
  ).not.toBeInTheDocument();
});

test("same employee and date Week Off remains deduplicated in History", async () => {
  fetchAllLeave.mockResolvedValue(HISTORY_ROWS);
  mockAttendanceByView({
    history: [
      { email: "nitesh@mydgv.com", date: "2026-09-22", status: "WeeklyOff" },
    ],
  });
  render(<LeaveManagement />);
  await screen.findByRole("heading", { name: "Leave & Time Off" });
  await openHistoryView();
  expect(within(weekOffHistorySection()).getAllByText("Nitesh Shukla")).toHaveLength(1);
});

test("Clear Filters restores History defaults", async () => {
  fetchAllLeave.mockResolvedValue(HISTORY_ROWS);
  render(<LeaveManagement />);
  await screen.findByRole("heading", { name: "Leave & Time Off" });
  await openHistoryView();
  await userEvent.type(screen.getByPlaceholderText("Search employee..."), "Nitesh");
  await userEvent.selectOptions(screen.getByLabelText("Type"), "Leave");
  await userEvent.selectOptions(screen.getByLabelText("Status"), "Approved");
  fireEvent.change(screen.getByLabelText("From Date"), { target: { value: "2026-09-01" } });
  await userEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
  expect(screen.getByPlaceholderText("Search employee...")).toHaveValue("");
  expect(screen.getByLabelText("Type")).toHaveValue("ALL");
  expect(screen.getByLabelText("Status")).toHaveValue("ALL");
  expect(screen.getByLabelText("From Date")).toHaveValue("2026-08-28");
  expect(screen.getByLabelText("To Date")).toHaveValue("2026-09-26");
  expect(screen.getByRole("heading", { name: "WEEK OFF HISTORY" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "LEAVE HISTORY" })).toBeInTheDocument();
});




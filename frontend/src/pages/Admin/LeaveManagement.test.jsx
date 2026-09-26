jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../../utils/attendanceCompliance", () => ({
  companyTodayKey: () => "2026-09-26",
}));

jest.mock("../../services/api", () => ({
  fetchAllLeave: jest.fn(),
  reviewLeave: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LeaveManagement from "./LeaveManagement";
import { fetchAllLeave } from "../../services/api";

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

test("History control shows non-today pending leave and keeps Approve/Reject", async () => {
  fetchAllLeave.mockResolvedValue(ROWS);
  render(<LeaveManagement />);

  expect(await screen.findByText("today@mydgv.com")).toBeInTheDocument();
  expect(screen.queryByText("later@mydgv.com")).not.toBeInTheDocument();
  expect(screen.queryByText("rejected@mydgv.com")).not.toBeInTheDocument();

  const todayAct = screen.getByRole("button", { name: /act/i });
  await userEvent.click(todayAct);
  expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "History" }));
  await waitFor(() => {
    expect(screen.getByText("later@mydgv.com")).toBeInTheDocument();
  });
  expect(screen.queryByText("today@mydgv.com")).not.toBeInTheDocument();
  expect(screen.getByText("rejected@mydgv.com")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /act/i }));
  expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
});

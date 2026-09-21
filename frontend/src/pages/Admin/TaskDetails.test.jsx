jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../../components/ZoneBadge", () => {
  return function ZoneBadge() {
    return <span>zone</span>;
  };
});

const mockNavigate = jest.fn();
const mockLocation = { pathname: "/work/t1", state: {} };

jest.mock(
  "react-router-dom",
  () => ({
    useNavigate: () => mockNavigate,
    useParams: () => ({ taskId: "t1" }),
    useLocation: () => mockLocation,
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchTaskById: jest.fn(),
  fetchTaskActivity: jest.fn(),
  updateTask: jest.fn(),
  fetchUsers: jest.fn(),
  fetchUserProfile: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import TaskDetails from "./TaskDetails";
import {
  fetchTaskById,
  fetchTaskActivity,
  fetchUsers,
  fetchUserProfile,
} from "../../services/api";

const ASSIGNED_TASK = {
  taskId: "t1",
  title: "Backlinks Created",
  status: "TODO",
  priority: "MEDIUM",
  assignee: "rahul@mydgv.com",
  assignees: ["rahul@mydgv.com"],
  createdBy: "admin@mydgv.com",
  createdByName: "Admin User",
  assigneeProfile: { email: "rahul@mydgv.com", name: "Rahul" },
  assigneeProfiles: [{ email: "rahul@mydgv.com", name: "Rahul" }],
};

beforeEach(() => {
  mockNavigate.mockReset();
  mockLocation.pathname = "/work/t1";
  mockLocation.state = {};
  fetchTaskById.mockReset();
  fetchTaskActivity.mockReset();
  fetchUsers.mockReset();
  fetchUserProfile.mockReset();
  fetchTaskActivity.mockResolvedValue([]);
  fetchUsers.mockResolvedValue([{ email: "admin@mydgv.com", name: "Admin User" }]);
  localStorage.clear();
  localStorage.setItem("token", "employee-token");
  localStorage.setItem("role", "USER");
});

test("employee task details do not request /admin/users", async () => {
  fetchTaskById.mockResolvedValue(ASSIGNED_TASK);
  render(<TaskDetails />);
  expect(await screen.findByText("Backlinks Created")).toBeInTheDocument();
  expect(fetchUsers).not.toHaveBeenCalled();
  expect(fetchUserProfile).not.toHaveBeenCalled();
  expect(localStorage.getItem("token")).toBe("employee-token");
});

test("employee 403 shows access denied without logging out", async () => {
  const err = new Error("Forbidden");
  err.status = 403;
  fetchTaskById.mockRejectedValue(err);
  render(<TaskDetails />);
  expect(
    await screen.findByText("You do not have permission to view this task.")
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Back to My Tasks" })).toBeInTheDocument();
  expect(fetchUsers).not.toHaveBeenCalled();
  expect(localStorage.getItem("token")).toBe("employee-token");
  expect(localStorage.getItem("role")).toBe("USER");
});

test("admin task details still load the user directory", async () => {
  mockLocation.pathname = "/admin/tasks/t1";
  fetchTaskById.mockResolvedValue(ASSIGNED_TASK);
  render(<TaskDetails />);
  await waitFor(() => expect(fetchUsers).toHaveBeenCalledTimes(1));
  expect(await screen.findByText("Backlinks Created")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit Task" })).toBeInTheDocument();
});

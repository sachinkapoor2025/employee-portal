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

jest.mock("../../services/auth", () => ({
  getLoggedInEmail: jest.fn(() => "rahul@mydgv.com"),
}));

jest.mock("../../services/api", () => ({
  fetchTaskById: jest.fn(),
  fetchTaskActivity: jest.fn(),
  fetchTaskAttachments: jest.fn(),
  getTaskAttachmentUploadUrl: jest.fn(),
  registerTaskAttachment: jest.fn(),
  getTaskAttachmentDownloadUrl: jest.fn(),
  updateTask: jest.fn(),
  createTask: jest.fn(),
  fetchUsers: jest.fn(),
  fetchUserProfile: jest.fn(),
  reportTaskBlocker: jest.fn(),
}));

import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskDetails from "./TaskDetails";
import {
  fetchTaskById,
  fetchTaskActivity,
  fetchTaskAttachments,
  getTaskAttachmentUploadUrl,
  registerTaskAttachment,
  getTaskAttachmentDownloadUrl,
  fetchUsers,
  fetchUserProfile,
  updateTask,
  createTask,
  reportTaskBlocker,
} from "../../services/api";
import { getLoggedInEmail } from "../../services/auth";

const ASSIGNED_TASK = {
  taskId: "t1",
  projectId: "p1",
  projectName: "Portal",
  title: "Backlinks Created",
  description: "Build the outreach list.",
  status: "TODO",
  priority: "MEDIUM",
  category: "SEO",
  assignee: "rahul@mydgv.com",
  assignees: ["rahul@mydgv.com"],
  createdBy: "admin@mydgv.com",
  createdByName: "Admin User",
  assigneeProfile: { email: "rahul@mydgv.com", name: "Rahul" },
  assigneeProfiles: [{ email: "rahul@mydgv.com", name: "Rahul" }],
  myAssignment: {
    email: "rahul@mydgv.com",
    status: "TODO",
    zone: "GREEN",
    timing: "Due in 10 days",
  },
};

function employeeTask({ status = "TODO", zone = "GREEN", extra = {}, mine = {} } = {}) {
  return {
    ...ASSIGNED_TASK,
    status: extra.status || "REVIEW",
    myAssignment: {
      email: "rahul@mydgv.com",
      status,
      zone,
      timing: "Due in 10 days",
      ...mine,
    },
    assignments: [
      {
        email: "rahul@mydgv.com",
        status,
        zone,
        timing: "Due in 10 days",
        ...mine,
      },
    ],
    ...extra,
  };
}

const MULTI_TASK = {
  taskId: "TASK-B3EEBA05",
  projectId: "p1",
  projectName: "Portal",
  title: "Campaign brief",
  description: "Shared campaign work.",
  status: "REVIEW",
  priority: "HIGH",
  category: "Content",
  createdBy: "admin@mydgv.com",
  createdByName: "Admin User",
  assignees: ["ankit@mydgv.com", "priya@mydgv.com", "nitin@mydgv.com"],
  assignments: [
    { email: "ankit@mydgv.com", status: "TODO", zone: "GREEN", timing: "Due in 4 days" },
    { email: "priya@mydgv.com", status: "IN_PROGRESS", zone: "GREEN", timing: "Due in 4 days" },
    { email: "nitin@mydgv.com", status: "DONE", zone: "GREEN", completedAt: "2026-09-20T10:00:00.000Z" },
  ],
  assigneeProfiles: [
    { email: "ankit@mydgv.com", name: "Ankit" },
    { email: "priya@mydgv.com", name: "Priya" },
    { email: "nitin@mydgv.com", name: "Nitin" },
  ],
  myAssignment: {
    email: "ankit@mydgv.com",
    status: "TODO",
    zone: "GREEN",
    timing: "Due in 4 days",
  },
};

beforeEach(() => {
  mockNavigate.mockReset();
  mockLocation.pathname = "/work/t1";
  mockLocation.state = {};
  fetchTaskById.mockReset();
  fetchTaskActivity.mockReset();
  fetchTaskAttachments.mockReset();
  getTaskAttachmentUploadUrl.mockReset();
  registerTaskAttachment.mockReset();
  getTaskAttachmentDownloadUrl.mockReset();
  fetchUsers.mockReset();
  fetchUserProfile.mockReset();
  updateTask.mockReset();
  createTask.mockReset();
  reportTaskBlocker.mockReset();
  getLoggedInEmail.mockReturnValue("rahul@mydgv.com");
  fetchTaskActivity.mockResolvedValue([]);
  fetchTaskAttachments.mockResolvedValue([]);
  getTaskAttachmentUploadUrl.mockResolvedValue({
    uploadUrl: "https://s3.example/put",
    s3Key: "tasks/t1/file.pdf",
    fileName: "brief.pdf",
    contentType: "application/pdf",
  });
  registerTaskAttachment.mockResolvedValue({});
  getTaskAttachmentDownloadUrl.mockResolvedValue({
    downloadUrl: "https://s3.example/get",
  });
  fetchUsers.mockResolvedValue([{ email: "admin@mydgv.com", name: "Admin User" }]);
  updateTask.mockResolvedValue({});
  createTask.mockResolvedValue({ taskId: "t2" });
  reportTaskBlocker.mockResolvedValue({});
  window.confirm = jest.fn(() => true);
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

test("employee uses myAssignment.status rather than task.status", async () => {
  fetchTaskById.mockResolvedValue(
    employeeTask({
      status: "TODO",
      extra: { status: "REVIEW" },
    })
  );
  render(<TaskDetails />);
  const select = await screen.findByLabelText("Update your assignment status");
  expect(select).toHaveValue("TODO");
  expect(screen.getAllByText("TODO").length).toBeGreaterThan(0);
});

test("employee status control is in the header STATUS area", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  const select = await screen.findByLabelText("Update your assignment status");
  expect(select).toHaveValue("TODO");
  const pageTitle = screen.getByRole("heading", { name: "Task Details" });
  const assignment = screen.getByRole("heading", { name: "YOUR ASSIGNMENT" });
  expect(
    pageTitle.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(
    select.compareDocumentPosition(assignment) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
});

test("Your Assignment does not contain an editable status select", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "IN_PROGRESS" }));
  render(<TaskDetails />);
  await screen.findByLabelText("Update your assignment status");
  const assignmentHeading = screen.getByRole("heading", { name: "YOUR ASSIGNMENT" });
  const assignmentSection = assignmentHeading.closest("section");
  expect(assignmentSection).toBeTruthy();
  expect(
    within(assignmentSection).queryByLabelText("Update your assignment status")
  ).not.toBeInTheDocument();
  expect(within(assignmentSection).queryByText("Update status")).not.toBeInTheDocument();
  expect(within(assignmentSection).queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getAllByLabelText("Update your assignment status")).toHaveLength(1);
});

test("TODO can select IN_PROGRESS", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  const select = await screen.findByLabelText("Update your assignment status");
  await userEvent.selectOptions(select, "IN_PROGRESS");
  await waitFor(() =>
    expect(updateTask).toHaveBeenCalledWith({
      taskId: "t1",
      projectId: "p1",
      status: "IN_PROGRESS",
      assignmentEmail: "rahul@mydgv.com",
    })
  );
});

test("employee status options exclude REVIEW", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "IN_PROGRESS" }));
  render(<TaskDetails />);
  const select = await screen.findByLabelText("Update your assignment status");
  const options = within(select)
    .getAllByRole("option")
    .map((option) => option.value);
  expect(options).toEqual(["TODO", "IN_PROGRESS", "DONE"]);
  expect(
    within(select).queryByRole("option", { name: /IN REVIEW/i })
  ).not.toBeInTheDocument();
  expect(updateTask).not.toHaveBeenCalled();
});

test("selecting DONE opens completion UI with required remark", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  await userEvent.selectOptions(
    await screen.findByLabelText("Update your assignment status"),
    "DONE"
  );
  expect(
    await screen.findByRole("dialog", { name: "Submit Task for Review" })
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Completion Remark")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Add a final remark describing the work you completed. The task will be sent to Admin for review."
    )
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit for Review" })).toBeInTheDocument();
  expect(updateTask).not.toHaveBeenCalled();
});

test("empty remark does not call updateTask", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  await userEvent.selectOptions(
    await screen.findByLabelText("Update your assignment status"),
    "DONE"
  );
  await userEvent.click(screen.getByRole("button", { name: "Submit for Review" }));
  expect(
    await screen.findByText("Completion Remark is required.")
  ).toBeInTheDocument();
  expect(updateTask).not.toHaveBeenCalled();
  expect(
    screen.getByRole("dialog", { name: "Submit Task for Review" })
  ).toBeInTheDocument();
});

test("whitespace-only remark does not call updateTask", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  await userEvent.selectOptions(
    await screen.findByLabelText("Update your assignment status"),
    "DONE"
  );
  await userEvent.type(screen.getByLabelText("Completion Remark"), "   ");
  await userEvent.click(screen.getByRole("button", { name: "Submit for Review" }));
  expect(
    await screen.findByText("Completion Remark is required.")
  ).toBeInTheDocument();
  expect(updateTask).not.toHaveBeenCalled();
});

test("valid remark calls updateTask with completionRemark", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  await userEvent.selectOptions(
    await screen.findByLabelText("Update your assignment status"),
    "DONE"
  );
  await userEvent.type(
    screen.getByLabelText("Completion Remark"),
    "  Completed the product upload and verified all 50 items.  "
  );
  await userEvent.click(screen.getByRole("button", { name: "Submit for Review" }));
  await waitFor(() =>
    expect(updateTask).toHaveBeenCalledWith({
      taskId: "t1",
      projectId: "p1",
      status: "DONE",
      assignmentEmail: "rahul@mydgv.com",
      completionRemark:
        "Completed the product upload and verified all 50 items.",
    })
  );
});

test("Cancel closes the completion UI without updating", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  await userEvent.selectOptions(
    await screen.findByLabelText("Update your assignment status"),
    "DONE"
  );
  await screen.findByRole("dialog", { name: "Submit Task for Review" });
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Submit Task for Review" })
    ).not.toBeInTheDocument()
  );
  expect(updateTask).not.toHaveBeenCalled();
});

test("successful submission refreshes into REVIEW", async () => {
  const initial = employeeTask({ status: "IN_PROGRESS" });
  const reviewed = employeeTask({
    status: "REVIEW",
    extra: { status: "REVIEW" },
    mine: {
      completionRemark: "Completed the product upload.",
    },
  });
  fetchTaskById.mockResolvedValueOnce(initial).mockResolvedValueOnce(reviewed);
  render(<TaskDetails />);
  await userEvent.selectOptions(
    await screen.findByLabelText("Update your assignment status"),
    "DONE"
  );
  await userEvent.type(
    screen.getByLabelText("Completion Remark"),
    "Completed the product upload."
  );
  await userEvent.click(screen.getByRole("button", { name: "Submit for Review" }));
  await waitFor(() => expect(fetchTaskById.mock.calls.length).toBeGreaterThan(1));
  expect(
    await screen.findByText("Your task has been submitted for Admin review.")
  ).toBeInTheDocument();
  expect(screen.getByText("Waiting for Admin review.")).toBeInTheDocument();
  expect(screen.getAllByText("IN REVIEW").length).toBeGreaterThan(0);
  expect(
    screen.queryByLabelText("Update your assignment status")
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Report Blocker" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Completed assignments cannot be reopened.")
  ).not.toBeInTheDocument();
  expect(screen.getByText("Completed the product upload.")).toBeInTheDocument();
  expect(screen.getByText("Review Submission Remark")).toBeInTheDocument();
});

test("CANCELLED is not an employee option", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  await screen.findByLabelText("Update your assignment status");
  expect(
    screen.queryByRole("option", { name: /CANCELLED/i })
  ).not.toBeInTheDocument();
});

test("DONE assignment is read-only", async () => {
  fetchTaskById.mockResolvedValue(
    employeeTask({
      status: "DONE",
      mine: { completedAt: "2026-09-20T10:00:00.000Z" },
    })
  );
  render(<TaskDetails />);
  expect(
    await screen.findByText("Completed assignments cannot be reopened.")
  ).toBeInTheDocument();
  expect(
    screen.queryByLabelText("Update your assignment status")
  ).not.toBeInTheDocument();
});

test("RED open assignment prevents employee status mutation UI", async () => {
  fetchTaskById.mockResolvedValue(
    employeeTask({ status: "TODO", zone: "RED" })
  );
  render(<TaskDetails />);
  const select = await screen.findByLabelText("Update your assignment status");
  expect(select).toBeDisabled();
  expect(
    screen.getByText("Red Zone tasks can only be updated by an administrator.")
  ).toBeInTheDocument();
  expect(updateTask).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("dialog", { name: "Submit Task for Review" })
  ).not.toBeInTheDocument();
});

test("status update calls existing API with assignment context", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  await userEvent.selectOptions(
    await screen.findByLabelText("Update your assignment status"),
    "IN_PROGRESS"
  );
  await waitFor(() =>
    expect(updateTask).toHaveBeenCalledWith({
      taskId: "t1",
      projectId: "p1",
      status: "IN_PROGRESS",
      assignmentEmail: "rahul@mydgv.com",
    })
  );
});

test("successful update refreshes task details and activity", async () => {
  const initial = employeeTask({ status: "TODO" });
  const refreshed = employeeTask({ status: "IN_PROGRESS" });
  fetchTaskById
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(refreshed);
  render(<TaskDetails />);
  await userEvent.selectOptions(
    await screen.findByLabelText("Update your assignment status"),
    "IN_PROGRESS"
  );
  await waitFor(() => expect(fetchTaskById.mock.calls.length).toBeGreaterThan(1));
  await waitFor(() =>
    expect(fetchTaskActivity.mock.calls.length).toBeGreaterThan(1)
  );
  expect(await screen.findByLabelText("Update your assignment status")).toHaveValue(
    "IN_PROGRESS"
  );
});

test("failed update shows error and does not fake success", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  const err = new Error("Red Zone tasks can only be updated by an administrator.");
  err.status = 403;
  updateTask.mockRejectedValue(err);
  render(<TaskDetails />);
  const select = await screen.findByLabelText("Update your assignment status");
  await userEvent.selectOptions(select, "IN_PROGRESS");
  expect(
    await screen.findByText("Red Zone tasks can only be updated by an administrator.")
  ).toBeInTheDocument();
  expect(select).toHaveValue("TODO");
  expect(fetchTaskById).toHaveBeenCalledTimes(1);
});

test("description appears before Schedule", async () => {
  fetchTaskById.mockResolvedValue(employeeTask());
  render(<TaskDetails />);
  const description = await screen.findByRole("heading", {
    name: "TASK DESCRIPTION",
  });
  const schedule = screen.getByRole("heading", { name: "SCHEDULE" });
  expect(
    description.compareDocumentPosition(schedule) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(screen.getByText("Build the outreach list.")).toBeInTheDocument();
});

test("employee Task Information shows only id project priority category", async () => {
  fetchTaskById.mockResolvedValue(employeeTask());
  render(<TaskDetails />);
  expect(
    await screen.findByRole("heading", { name: "TASK INFORMATION" })
  ).toBeInTheDocument();
  expect(screen.getByText("Task ID:")).toBeInTheDocument();
  expect(screen.getByText("TASK-T1")).toBeInTheDocument();
  expect(screen.getByText("Project:")).toBeInTheDocument();
  expect(screen.getByText("Portal")).toBeInTheDocument();
  expect(screen.getByText("Priority:")).toBeInTheDocument();
  expect(screen.getByText("Category:")).toBeInTheDocument();
  expect(screen.getByText("SEO")).toBeInTheDocument();
  expect(screen.queryByText("Assigned by:")).not.toBeInTheDocument();
  expect(screen.queryByText("Assigned to:")).not.toBeInTheDocument();
  expect(screen.queryByText("Assigned To:")).not.toBeInTheDocument();
  expect(screen.queryByText("Author:")).not.toBeInTheDocument();
  expect(screen.queryByText("Created Date:")).not.toBeInTheDocument();
  expect(screen.queryByText("Created Time:")).not.toBeInTheDocument();
});

test("employee Schedule remains a separate section", async () => {
  fetchTaskById.mockResolvedValue(employeeTask());
  render(<TaskDetails />);
  expect(await screen.findByRole("heading", { name: "SCHEDULE" })).toBeInTheDocument();
  expect(screen.getByText("Start date:")).toBeInTheDocument();
  expect(screen.getByText("Start time:")).toBeInTheDocument();
  expect(screen.getByText("Deadline date:")).toBeInTheDocument();
  expect(screen.getByText("Deadline time:")).toBeInTheDocument();
  expect(screen.getByText("Due in:")).toBeInTheDocument();
  expect(screen.getByText("Current Zone:")).toBeInTheDocument();
  expect(screen.getByText("Duration:")).toBeInTheDocument();
});

test("Task Activity remains visible", async () => {
  fetchTaskActivity.mockResolvedValue([
    {
      activityId: "a1",
      timestamp: "2026-09-20T10:00:00.000Z",
      action: "status_changed",
      message: "rahul@mydgv.com: TODO → IN PROGRESS",
    },
  ]);
  fetchTaskById.mockResolvedValue(employeeTask());
  render(<TaskDetails />);
  expect(
    await screen.findByRole("heading", { name: "Task Activity" })
  ).toBeInTheDocument();
});

test("admin view still renders its existing controls", async () => {
  mockLocation.pathname = "/admin/tasks/t1";
  fetchTaskById.mockResolvedValue(ASSIGNED_TASK);
  render(<TaskDetails />);
  expect(await screen.findByRole("button", { name: "Edit Task" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Change Status" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reassign" })).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Review Task" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Update your assignment status")
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "INDIVIDUAL EMPLOYEE PROGRESS" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "YOUR ASSIGNMENT" })
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Completion Remark")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Complete Task" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Submit Task for Review" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Report Blocker" })
  ).not.toBeInTheDocument();
  expect(screen.getByText("Author:")).toBeInTheDocument();
  expect(screen.getByText("Assigned To:")).toBeInTheDocument();
  expect(screen.getByText("Created Date:")).toBeInTheDocument();
  expect(screen.getByText("Created Time:")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Change Status" }));
  const statusDialog = await screen.findByRole("dialog", { name: "Change Status" });
  expect(
    within(statusDialog).getByRole("option", { name: /IN REVIEW/ })
  ).toBeInTheDocument();
  expect(
    within(statusDialog).getByRole("option", { name: /COMPLETED/ })
  ).toBeInTheDocument();
  expect(
    within(statusDialog).getByRole("option", { name: /^TODO/ })
  ).toBeInTheDocument();
  expect(
    within(statusDialog).getByRole("option", { name: /IN PROGRESS/ })
  ).toBeInTheDocument();
  expect(
    within(statusDialog).getByRole("option", { name: /CANCELLED/ })
  ).toBeInTheDocument();
});

test("multi-assignee employee status uses myAssignment only", async () => {
  getLoggedInEmail.mockReturnValue("ankit@mydgv.com");
  fetchTaskById.mockResolvedValue(MULTI_TASK);
  render(<TaskDetails />);
  const select = await screen.findByLabelText("Update your assignment status");
  expect(select).toHaveValue("TODO");
  await userEvent.selectOptions(select, "IN_PROGRESS");
  await waitFor(() =>
    expect(updateTask).toHaveBeenCalledWith({
      taskId: "TASK-B3EEBA05",
      projectId: "p1",
      status: "IN_PROGRESS",
      assignmentEmail: "ankit@mydgv.com",
    })
  );
});

test("employee IN_PROGRESS shows Report Blocker in the header", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "IN_PROGRESS" }));
  render(<TaskDetails />);
  const report = await screen.findByRole("button", { name: "Report Blocker" });
  expect(report).toBeInTheDocument();
  const title = screen.getByRole("heading", { name: "Backlinks Created" });
  const assignment = screen.getByRole("heading", { name: "YOUR ASSIGNMENT" });
  expect(
    title.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(
    report.compareDocumentPosition(assignment) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
});

test("employee TODO hides Report Blocker", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  await screen.findByLabelText("Update your assignment status");
  expect(
    screen.queryByRole("button", { name: "Report Blocker" })
  ).not.toBeInTheDocument();
});

test("employee REVIEW shows waiting state without status control", async () => {
  fetchTaskById.mockResolvedValue(
    employeeTask({
      status: "REVIEW",
      extra: { status: "REVIEW" },
      mine: { completionRemark: "Ready for admin review." },
    })
  );
  render(<TaskDetails />);
  expect(
    await screen.findByText("Your task has been submitted for Admin review.")
  ).toBeInTheDocument();
  expect(screen.getByText("Waiting for Admin review.")).toBeInTheDocument();
  expect(screen.getAllByText("IN REVIEW").length).toBeGreaterThan(0);
  expect(
    screen.queryByLabelText("Update your assignment status")
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Report Blocker" })
  ).not.toBeInTheDocument();
  expect(screen.getByText("Ready for admin review.")).toBeInTheDocument();
  expect(screen.getByText("Review Submission Remark")).toBeInTheDocument();
  expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Completed assignments cannot be reopened.")
  ).not.toBeInTheDocument();
});

test("employee REVIEW hides Report Blocker", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "REVIEW" }));
  render(<TaskDetails />);
  expect((await screen.findAllByText("IN REVIEW")).length).toBeGreaterThan(0);
  expect(
    screen.queryByRole("button", { name: "Report Blocker" })
  ).not.toBeInTheDocument();
});

test("employee DONE hides Report Blocker", async () => {
  fetchTaskById.mockResolvedValue(
    employeeTask({
      status: "DONE",
      mine: { completedAt: "2026-09-20T10:00:00.000Z" },
    })
  );
  render(<TaskDetails />);
  expect(
    await screen.findByText("Completed assignments cannot be reopened.")
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Report Blocker" })
  ).not.toBeInTheDocument();
});

test("employee CANCELLED hides Report Blocker", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "CANCELLED" }));
  render(<TaskDetails />);
  expect(
    await screen.findByText(
      "This assignment is cancelled and cannot be updated."
    )
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Report Blocker" })
  ).not.toBeInTheDocument();
});

test("missing myAssignment hides Report Blocker", async () => {
  fetchTaskById.mockResolvedValue({
    ...ASSIGNED_TASK,
    status: "IN_PROGRESS",
    myAssignment: null,
    assignments: [],
    assignees: [],
    assignee: "",
  });
  render(<TaskDetails />);
  expect(
    await screen.findByText("No assignment found for your account.")
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Report Blocker" })
  ).not.toBeInTheDocument();
});

test("RED IN_PROGRESS still shows Report Blocker", async () => {
  fetchTaskById.mockResolvedValue(
    employeeTask({ status: "IN_PROGRESS", zone: "RED" })
  );
  render(<TaskDetails />);
  expect(
    await screen.findByRole("button", { name: "Report Blocker" })
  ).toBeInTheDocument();
  expect(
    screen.getByText("Red Zone tasks can only be updated by an administrator.")
  ).toBeInTheDocument();
});

test("clicking Report Blocker opens modal and Cancel does not call API", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "IN_PROGRESS" }));
  render(<TaskDetails />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Report Blocker" })
  );
  const dialog = await screen.findByRole("dialog", { name: "Report Blocker" });
  expect(screen.getByLabelText("Blocker Remark")).toBeInTheDocument();
  expect(
    screen.getByText("Describe what is blocking you from completing this task.")
  ).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Report Blocker" })
    ).not.toBeInTheDocument()
  );
  expect(reportTaskBlocker).not.toHaveBeenCalled();
});

test("empty blocker remark does not call API", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "IN_PROGRESS" }));
  render(<TaskDetails />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Report Blocker" })
  );
  const dialog = await screen.findByRole("dialog", { name: "Report Blocker" });
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Report Blocker" })
  );
  expect(
    await screen.findByText("Blocker Remark is required.")
  ).toBeInTheDocument();
  expect(reportTaskBlocker).not.toHaveBeenCalled();
  expect(
    screen.getByRole("dialog", { name: "Report Blocker" })
  ).toBeInTheDocument();
});

test("whitespace-only blocker remark does not call API", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "IN_PROGRESS" }));
  render(<TaskDetails />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Report Blocker" })
  );
  const dialog = await screen.findByRole("dialog", { name: "Report Blocker" });
  await userEvent.type(screen.getByLabelText("Blocker Remark"), "   ");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Report Blocker" })
  );
  expect(
    await screen.findByText("Blocker Remark is required.")
  ).toBeInTheDocument();
  expect(reportTaskBlocker).not.toHaveBeenCalled();
});

test("successful report posts trimmed remark and shows active blocker", async () => {
  const initial = employeeTask({ status: "IN_PROGRESS" });
  const reported = employeeTask({
    status: "IN_PROGRESS",
    extra: { status: "IN_PROGRESS" },
    mine: {
      blockerStatus: "ACTIVE",
      blockerRemark: "Waiting on legal copy",
      blockerReportedAt: "2026-09-25T12:00:00.000Z",
    },
  });
  fetchTaskById.mockResolvedValueOnce(initial).mockResolvedValueOnce(reported);
  render(<TaskDetails />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Report Blocker" })
  );
  const dialog = await screen.findByRole("dialog", { name: "Report Blocker" });
  await userEvent.type(
    screen.getByLabelText("Blocker Remark"),
    "  Waiting on legal copy  "
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Report Blocker" })
  );
  await waitFor(() =>
    expect(reportTaskBlocker).toHaveBeenCalledWith("t1", "Waiting on legal copy")
  );
  expect(reportTaskBlocker.mock.calls[0]).toEqual([
    "t1",
    "Waiting on legal copy",
  ]);
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Report Blocker" })
    ).not.toBeInTheDocument()
  );
  expect(await screen.findAllByText("Blocker Reported")).not.toHaveLength(0);
  expect(screen.getAllByText("IN PROGRESS").length).toBeGreaterThan(0);
  expect(screen.getByLabelText("Update your assignment status")).toHaveValue(
    "IN_PROGRESS"
  );
  expect(screen.queryByText("BLOCKED")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Report Blocker" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Resolve Blocker" })
  ).not.toBeInTheDocument();
  expect(fetchTaskById.mock.calls.length).toBeGreaterThan(1);
});

test("API failure keeps the blocker modal and remark", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "IN_PROGRESS" }));
  const err = new Error("A blocker is already active for this assignment");
  err.status = 400;
  reportTaskBlocker.mockRejectedValue(err);
  render(<TaskDetails />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Report Blocker" })
  );
  const dialog = await screen.findByRole("dialog", { name: "Report Blocker" });
  await userEvent.type(screen.getByLabelText("Blocker Remark"), "Need asset");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Report Blocker" })
  );
  expect(
    await screen.findByText("A blocker is already active for this assignment")
  ).toBeInTheDocument();
  expect(
    screen.getByRole("dialog", { name: "Report Blocker" })
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Blocker Remark")).toHaveValue("Need asset");
});

test("ACTIVE blocker hides Report Blocker and does not submit again", async () => {
  fetchTaskById.mockResolvedValue(
    employeeTask({
      status: "IN_PROGRESS",
      extra: { status: "IN_PROGRESS" },
      mine: {
        blockerStatus: "ACTIVE",
        blockerRemark: "Waiting on copy",
        blockerReportedAt: "2026-09-25T12:00:00.000Z",
      },
    })
  );
  render(<TaskDetails />);
  expect(await screen.findAllByText("Blocker Reported")).not.toHaveLength(0);
  expect(
    screen.queryByRole("button", { name: "Report Blocker" })
  ).not.toBeInTheDocument();
  expect(reportTaskBlocker).not.toHaveBeenCalled();
});

test("RESOLVED blocker on IN_PROGRESS shows Report Blocker again", async () => {
  fetchTaskById.mockResolvedValue(
    employeeTask({
      status: "IN_PROGRESS",
      extra: { status: "IN_PROGRESS" },
      mine: {
        blockerStatus: "RESOLVED",
        blockerRemark: "Waiting on copy",
        blockerReportedAt: "2026-09-24T12:00:00.000Z",
        blockerResolvedAt: "2026-09-25T09:00:00.000Z",
      },
    })
  );
  render(<TaskDetails />);
  expect(
    await screen.findByRole("button", { name: "Report Blocker" })
  ).toBeInTheDocument();
  expect(screen.queryByText("Blocker Reported")).not.toBeInTheDocument();
});

function adminReviewTask() {
  return employeeTask({
    status: "REVIEW",
    extra: {
      status: "REVIEW",
      startDate: "2099-12-31T18:00:00+05:30",
      dueDate: "2099-12-31T19:00:00+05:30",
    },
    mine: { completionRemark: "Uploaded all 50 products." },
  });
}

test("admin REVIEW shows employee submission and review decisions", async () => {
  mockLocation.pathname = "/admin/tasks/t1";
  fetchUsers.mockResolvedValue([
    { email: "rahul@mydgv.com", name: "Rahul Sharma", status: "ACTIVE" },
    { email: "priya@mydgv.com", name: "Priya", status: "ACTIVE" },
  ]);
  fetchTaskById.mockResolvedValue(adminReviewTask());
  render(<TaskDetails />);
  expect(await screen.findByRole("heading", { name: "Review Task" })).toBeInTheDocument();
  expect(screen.getAllByText("IN REVIEW").length).toBeGreaterThan(0);
  expect(screen.getByText("Uploaded all 50 products.")).toBeInTheDocument();
  expect(
    screen.getByRole("radio", { name: "Approve & Complete" })
  ).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Reassign" })).toBeInTheDocument();
  expect(
    screen.queryByRole("radio", { name: "Changes Required" })
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Admin Remark")).not.toBeInTheDocument();
});

test("admin Reassign reveals reason remark schedule and same employee default", async () => {
  mockLocation.pathname = "/admin/tasks/t1";
  fetchUsers.mockResolvedValue([
    { email: "rahul@mydgv.com", name: "Rahul Sharma", status: "ACTIVE" },
    { email: "priya@mydgv.com", name: "Priya", status: "ACTIVE" },
  ]);
  fetchTaskById.mockResolvedValue(adminReviewTask());
  render(<TaskDetails />);
  await userEvent.click(
    await screen.findByRole("radio", { name: "Reassign" })
  );
  expect(screen.getByRole("radio", { name: "Changes Required" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Rejected" })).toBeInTheDocument();
  expect(screen.getByLabelText("Admin Remark")).toBeInTheDocument();
  expect(
    screen.getByRole("radio", { name: /Same Employee/ })
  ).toBeChecked();
  expect(screen.queryByLabelText("Select Employee")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Start Date")).toBeInTheDocument();
  expect(screen.getByLabelText("Start Time")).toBeInTheDocument();
  expect(screen.getByLabelText("End Date")).toBeInTheDocument();
  expect(screen.getByLabelText("End Time")).toBeInTheDocument();
});

test("another employee reveals the employee selector", async () => {
  mockLocation.pathname = "/admin/tasks/t1";
  fetchUsers.mockResolvedValue([
    { email: "rahul@mydgv.com", name: "Rahul Sharma", status: "ACTIVE" },
    { email: "priya@mydgv.com", name: "Priya", status: "ACTIVE" },
  ]);
  fetchTaskById.mockResolvedValue(adminReviewTask());
  render(<TaskDetails />);
  await userEvent.click(await screen.findByRole("radio", { name: "Reassign" }));
  await userEvent.click(screen.getByRole("radio", { name: "Another Employee" }));
  expect(screen.getByLabelText("Select Employee")).toBeInTheDocument();
});

test("empty admin remark is rejected", async () => {
  mockLocation.pathname = "/admin/tasks/t1";
  fetchUsers.mockResolvedValue([
    { email: "rahul@mydgv.com", name: "Rahul Sharma", status: "ACTIVE" },
  ]);
  fetchTaskById.mockResolvedValue(adminReviewTask());
  render(<TaskDetails />);
  await userEvent.click(await screen.findByRole("radio", { name: "Reassign" }));
  await userEvent.click(screen.getByRole("radio", { name: "Changes Required" }));
  await userEvent.click(screen.getByRole("button", { name: "Reassign Task" }));
  expect(await screen.findByText("Admin remark is required.")).toBeInTheDocument();
  expect(createTask).not.toHaveBeenCalled();
});

test("successful reassignment navigates to the new task", async () => {
  mockLocation.pathname = "/admin/tasks/t1";
  fetchUsers.mockResolvedValue([
    { email: "rahul@mydgv.com", name: "Rahul Sharma", status: "ACTIVE" },
  ]);
  fetchTaskById.mockResolvedValue(adminReviewTask());
  render(<TaskDetails />);
  await userEvent.click(await screen.findByRole("radio", { name: "Reassign" }));
  await userEvent.click(screen.getByRole("radio", { name: "Changes Required" }));
  await userEvent.type(screen.getByLabelText("Admin Remark"), "  Please add alt text.  ");
  await userEvent.click(screen.getByRole("button", { name: "Reassign Task" }));
  await waitFor(() =>
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: "t1",
        assignmentEmail: "rahul@mydgv.com",
        reassignmentReason: "CHANGES_REQUIRED",
        reassignmentRemark: "Please add alt text.",
        assignees: ["rahul@mydgv.com"],
        assignee: "rahul@mydgv.com",
      })
    )
  );
  await waitFor(() =>
    expect(mockNavigate).toHaveBeenCalledWith("/admin/tasks/t2")
  );
});

test("Approve & Complete uses existing DONE mutation", async () => {
  mockLocation.pathname = "/admin/tasks/t1";
  fetchTaskById.mockResolvedValue(adminReviewTask());
  render(<TaskDetails />);
  await userEvent.click(
    await screen.findByRole("radio", { name: "Approve & Complete" })
  );
  await userEvent.click(screen.getByRole("button", { name: "Approve & Complete" }));
  await waitFor(() =>
    expect(updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "t1",
        status: "DONE",
        assignmentEmail: "rahul@mydgv.com",
      })
    )
  );
  expect(createTask).not.toHaveBeenCalled();
});

const SAMPLE_ATTACHMENT = {
  attachmentId: "att-1",
  fileName: "brief.pdf",
  s3Key: "tasks/t1/1-brief.pdf",
  uploadedBy: "rahul@mydgv.com",
  uploadedAt: "2026-09-20T10:00:00.000Z",
};

function chooseAttachmentFile(file) {
  const input = screen.getByLabelText("Attach a file");
  fireEvent.change(input, { target: { files: [file] } });
}

test("employee and admin see optional attachments list", async () => {
  fetchTaskAttachments.mockResolvedValue([SAMPLE_ATTACHMENT]);
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  const { unmount } = render(<TaskDetails />);
  expect(await screen.findByRole("heading", { name: "ATTACHMENTS" })).toBeInTheDocument();
  expect(
    screen.getByText(
      "Attachments are optional. You can complete this task without attaching a file."
    )
  ).toBeInTheDocument();
  expect(screen.getByText("brief.pdf")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download brief.pdf" })).toBeInTheDocument();
  expect(screen.queryByText("No attachments yet.")).not.toBeInTheDocument();
  unmount();

  mockLocation.pathname = "/admin/tasks/t1";
  fetchTaskById.mockResolvedValue(ASSIGNED_TASK);
  render(<TaskDetails />);
  expect(await screen.findByRole("heading", { name: "ATTACHMENTS" })).toBeInTheDocument();
  expect(screen.getByText("brief.pdf")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download brief.pdf" })).toBeInTheDocument();
});

test("empty attachments show optional empty state", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  expect(await screen.findByRole("heading", { name: "ATTACHMENTS" })).toBeInTheDocument();
  expect(screen.getByText("No attachments yet.")).toBeInTheDocument();
  expect(screen.getByLabelText("Attach a file")).toBeInTheDocument();
});

test("optional upload follows presign, PUT, register, then refresh", async () => {
  fetchTaskAttachments
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([SAMPLE_ATTACHMENT]);
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  render(<TaskDetails />);
  await screen.findByText("No attachments yet.");
  const file = new File(["pdf-bytes"], "brief.pdf", { type: "application/pdf" });
  chooseAttachmentFile(file);
  await waitFor(() =>
    expect(getTaskAttachmentUploadUrl).toHaveBeenCalledWith(
      "t1",
      "brief.pdf",
      "application/pdf",
      file.size
    )
  );
  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith("https://s3.example/put", {
      method: "PUT",
      body: file,
      headers: { "Content-Type": "application/pdf" },
    })
  );
  await waitFor(() =>
    expect(registerTaskAttachment).toHaveBeenCalledWith("t1", {
      fileName: "brief.pdf",
      contentType: "application/pdf",
      s3Key: "tasks/t1/file.pdf",
    })
  );
  expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
  expect(screen.queryByText("No attachments yet.")).not.toBeInTheDocument();
  expect(fetchTaskAttachments.mock.calls.length).toBeGreaterThan(1);
});

test("download requests a controlled URL", async () => {
  fetchTaskAttachments.mockResolvedValue([SAMPLE_ATTACHMENT]);
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  const openSpy = jest.spyOn(window, "open").mockImplementation(() => null);
  render(<TaskDetails />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Download brief.pdf" })
  );
  await waitFor(() =>
    expect(getTaskAttachmentDownloadUrl).toHaveBeenCalledWith("t1", {
      attachmentId: "att-1",
      s3Key: "tasks/t1/1-brief.pdf",
    })
  );
  expect(openSpy).toHaveBeenCalledWith(
    "https://s3.example/get",
    "_blank",
    "noopener"
  );
  openSpy.mockRestore();
});

test("invalid file type is rejected before upload", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  await screen.findByLabelText("Attach a file");
  chooseAttachmentFile(new File(["x"], "notes.exe", { type: "application/x-msdownload" }));
  expect(
    await screen.findByText(
      "Invalid file type. Allowed: PDF, JPG, JPEG, PNG, DOC, DOCX, XLS, XLSX."
    )
  ).toBeInTheDocument();
  expect(getTaskAttachmentUploadUrl).not.toHaveBeenCalled();
  expect(registerTaskAttachment).not.toHaveBeenCalled();
});

test("oversized file is rejected before upload", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  await screen.findByLabelText("Attach a file");
  const file = new File(["x"], "brief.pdf", { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 });
  chooseAttachmentFile(file);
  expect(
    await screen.findByText("File must be 10 MB or smaller.")
  ).toBeInTheDocument();
  expect(getTaskAttachmentUploadUrl).not.toHaveBeenCalled();
  expect(registerTaskAttachment).not.toHaveBeenCalled();
});

test("upload failure does not register the file", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  getTaskAttachmentUploadUrl.mockResolvedValue({
    uploadUrl: "https://s3.example/put",
    s3Key: "tasks/t1/file.pdf",
    fileName: "brief.pdf",
    contentType: "application/pdf",
  });
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });
  render(<TaskDetails />);
  await screen.findByLabelText("Attach a file");
  chooseAttachmentFile(new File(["pdf-bytes"], "brief.pdf", { type: "application/pdf" }));
  expect(await screen.findByText("Unable to upload attachment.")).toBeInTheDocument();
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  expect(registerTaskAttachment).not.toHaveBeenCalled();
  expect(screen.getByText("No attachments yet.")).toBeInTheDocument();
});

test("task completion does not depend on an attachment", async () => {
  fetchTaskById.mockResolvedValue(employeeTask({ status: "TODO" }));
  render(<TaskDetails />);
  expect(await screen.findByText("No attachments yet.")).toBeInTheDocument();
  await userEvent.selectOptions(
    screen.getByLabelText("Update your assignment status"),
    "DONE"
  );
  await userEvent.type(
    screen.getByLabelText("Completion Remark"),
    "Completed without a file."
  );
  await userEvent.click(screen.getByRole("button", { name: "Submit for Review" }));
  await waitFor(() =>
    expect(updateTask).toHaveBeenCalledWith({
      taskId: "t1",
      projectId: "p1",
      status: "DONE",
      assignmentEmail: "rahul@mydgv.com",
      completionRemark: "Completed without a file.",
    })
  );
  expect(updateTask.mock.calls[0][0].attachment).toBeUndefined();
  expect(updateTask.mock.calls[0][0].attachments).toBeUndefined();
  expect(getTaskAttachmentUploadUrl).not.toHaveBeenCalled();
  expect(registerTaskAttachment).not.toHaveBeenCalled();
});

test("admin review complete does not require an attachment", async () => {
  mockLocation.pathname = "/admin/tasks/t1";
  fetchTaskById.mockResolvedValue(adminReviewTask());
  render(<TaskDetails />);
  expect(await screen.findByRole("heading", { name: "ATTACHMENTS" })).toBeInTheDocument();
  expect(screen.getByText("No attachments yet.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "Approve & Complete" }));
  await userEvent.click(screen.getByRole("button", { name: "Approve & Complete" }));
  await waitFor(() =>
    expect(updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "t1",
        status: "DONE",
        assignmentEmail: "rahul@mydgv.com",
      })
    )
  );
  expect(updateTask.mock.calls[0][0].attachment).toBeUndefined();
  expect(getTaskAttachmentUploadUrl).not.toHaveBeenCalled();
});

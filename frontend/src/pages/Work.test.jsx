jest.mock("../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

const mockNavigate = jest.fn();
jest.mock(
  "react-router-dom",
  () => ({
    Link: ({ to, children, onClick, ...rest }) => (
      <a
        href={to}
        onClick={(e) => {
          e.preventDefault();
          if (onClick) onClick(e);
          mockNavigate(to);
        }}
        {...rest}
      >
        {children}
      </a>
    ),
    useNavigate: () => mockNavigate,
  }),
  { virtual: true }
);

jest.mock("../services/api", () => ({
  fetchTaskList: jest.fn(),
  updateTask: jest.fn(),
}));

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Work from "./Work";
import { fetchTaskList, updateTask } from "../services/api";

const ZONE_KEY = "dgv.mytasks.zone";
const STATUS_KEY = "dgv.mytasks.status";
const SEARCH_KEY = "dgv.mytasks.search";

const COUNTS = {
  ALL: 2,
  GREEN: 1,
  ORANGE: 0,
  RED: 0,
  COMPLETED: 1,
};

const GREEN_TASK = {
  taskId: "TASK-GREEN-1",
  title: "Write backlinks",
  description: "Create outreach list",
  status: "TODO",
  priority: "MEDIUM",
  category: "SEO",
  createdBy: "admin@mydgv.com",
  createdByName: "Admin",
  dueDate: "2099-12-31T18:30:00.000Z",
  zone: "GREEN",
  timing: "Due in 10 days",
  assignee: "rahul@mydgv.com",
  assignees: ["rahul@mydgv.com"],
  assignments: [
    {
      email: "rahul@mydgv.com",
      status: "TODO",
      zone: "GREEN",
      timing: "Due in 10 days",
    },
  ],
  myAssignment: {
    email: "rahul@mydgv.com",
    status: "TODO",
    zone: "GREEN",
    timing: "Due in 10 days",
  },
};

const COMPLETED_TASK = {
  taskId: "TASK-DONE-1",
  title: "Finished report",
  status: "DONE",
  priority: "LOW",
  zone: "GREEN",
  assignee: "rahul@mydgv.com",
  assignees: ["rahul@mydgv.com"],
  assignments: [
    {
      email: "rahul@mydgv.com",
      status: "DONE",
      zone: "GREEN",
      completedAt: "2026-09-01T10:00:00.000Z",
      completedZone: "GREEN",
    },
  ],
  myAssignment: {
    email: "rahul@mydgv.com",
    status: "DONE",
    zone: "GREEN",
    completedAt: "2026-09-01T10:00:00.000Z",
    completedZone: "GREEN",
  },
};

function renderWork() {
  return render(<Work />);
}

function emptyList() {
  return {
    tasks: [],
    zoneCounts: { ALL: 0, GREEN: 0, ORANGE: 0, RED: 0, COMPLETED: 0 },
  };
}

beforeEach(() => {
  sessionStorage.clear();
  mockNavigate.mockReset();
  fetchTaskList.mockReset();
  updateTask.mockReset();
  fetchTaskList.mockResolvedValue({
    tasks: [GREEN_TASK],
    zoneCounts: COUNTS,
  });
});

afterEach(() => {
  sessionStorage.removeItem(ZONE_KEY);
  sessionStorage.removeItem(STATUS_KEY);
  sessionStorage.removeItem(SEARCH_KEY);
});

async function rowFor(name) {
  const link = await screen.findByRole("link", { name });
  return link.closest("tr");
}

test("tabs cover all tasks, open work, and completed work", async () => {
  renderWork();
  expect(await screen.findByRole("tab", { name: /All Tasks/ })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /My Open Tasks/ })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /^Completed/ })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Deadline" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Deadline: Overdue" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Deadline: No deadline" })).toBeInTheDocument();
});

test("default list is All Tasks and is not limited to one deadline zone", async () => {
  renderWork();
  const all = await screen.findByRole("tab", { name: /All Tasks/ });
  expect(all).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("combobox", { name: "Deadline" })).toHaveValue("ALL");
  await waitFor(() =>
    expect(fetchTaskList).toHaveBeenCalledWith({ mine: "true" })
  );
  expect(fetchTaskList.mock.calls[0][0]).not.toHaveProperty("zone");
});

test("stored ALL stays All", async () => {
  sessionStorage.setItem(ZONE_KEY, "ALL");
  renderWork();
  expect(await screen.findByRole("tab", { name: /All Tasks/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(screen.getByRole("combobox", { name: "Deadline" })).toHaveValue("ALL");
  await waitFor(() => expect(sessionStorage.getItem(ZONE_KEY)).toBe("ALL"));
});

test("invalid stored category is normalized to All", async () => {
  sessionStorage.setItem(ZONE_KEY, "PURPLE");
  renderWork();
  expect(await screen.findByRole("tab", { name: /All Tasks/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(screen.getByRole("combobox", { name: "Deadline" })).toHaveValue("ALL");
  await waitFor(() => expect(sessionStorage.getItem(ZONE_KEY)).toBe("ALL"));
});

test("clicking a task card navigates to /work/{taskId}", async () => {
  renderWork();
  const card = await screen.findByRole("link", {
    name: /View task Write backlinks/i,
  });
  await userEvent.click(card);
  expect(mockNavigate).toHaveBeenCalledWith("/work/TASK-GREEN-1");
});

test("task rows do not include a status-change dropdown", async () => {
  renderWork();
  await screen.findByRole("link", { name: /View task Write backlinks/i });
  expect(screen.queryByLabelText("Update task status")).not.toBeInTheDocument();
  expect(screen.getAllByRole("combobox").map((node) => node.getAttribute("aria-label"))).toEqual([
    "Assigned period",
    "Status",
    "Deadline",
    "Project",
    "Sort",
  ]);
});

test("search still requests the employee list without a zone filter", async () => {
  renderWork();
  expect(await screen.findByText("Write backlinks")).toBeInTheDocument();
  const input = screen.getByPlaceholderText("Search tasks, project, or ID...");
  await userEvent.clear(input);
  await userEvent.type(input, "backlink");
  await waitFor(() =>
    expect(fetchTaskList).toHaveBeenCalledWith({
      mine: "true",
      q: "backlink",
    })
  );
  expect(screen.getByRole("tab", { name: /All Tasks/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(await screen.findByText("Write backlinks")).toBeInTheDocument();
});

test("empty Green Orange Red and Completed states use existing messages", async () => {
  fetchTaskList.mockResolvedValue(emptyList());
  renderWork();
  expect(await screen.findByText("No tasks found.")).toBeInTheDocument();

  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Deadline" }), "GREEN");
  expect(
    await screen.findByText("No Green Zone tasks found.")
  ).toBeInTheDocument();

  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Deadline" }), "ORANGE");
  expect(
    await screen.findByText("No Orange Zone tasks found.")
  ).toBeInTheDocument();

  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Deadline" }), "RED");
  expect(
    await screen.findByText("No Red Zone tasks found.")
  ).toBeInTheDocument();

  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Deadline" }), "ALL");
  await userEvent.click(screen.getByRole("tab", { name: /^Completed/ }));
  expect(
    await screen.findByText("No completed tasks found.")
  ).toBeInTheDocument();

  expect(screen.queryByText(/No tasks assigned yet/i)).not.toBeInTheDocument();
});

test("completed task cards still navigate to Task Details", async () => {
  fetchTaskList.mockResolvedValue({
    tasks: [COMPLETED_TASK],
    zoneCounts: COUNTS,
  });
  renderWork();
  await userEvent.click(await screen.findByRole("tab", { name: /^Completed/ }));
  expect(screen.getByRole("tab", { name: /^Completed/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  const card = await screen.findByRole("link", {
    name: /View task Finished report/i,
  });
  await userEvent.click(card);
  expect(mockNavigate).toHaveBeenCalledWith("/work/TASK-DONE-1");
});

test("project name renders on the task card when available", async () => {
  fetchTaskList.mockResolvedValue({
    tasks: [{ ...GREEN_TASK, projectName: "Alpha Project" }],
    zoneCounts: COUNTS,
  });
  renderWork();
  const row = await rowFor(/View task Write backlinks/i);
  expect(row).toHaveTextContent("Alpha Project");
  expect(row).not.toHaveTextContent(GREEN_TASK.taskId);
  expect(row).not.toHaveTextContent("Create outreach list");
});

test("resolved project name is shown instead of the projectId", async () => {
  const projectId = "6e7e628c-0408-4b2f-85e4-42f4decaf46f";
  fetchTaskList.mockResolvedValue({
    tasks: [
      {
        ...GREEN_TASK,
        projectId,
        projectName: "Alpha Project",
      },
    ],
    zoneCounts: COUNTS,
  });
  renderWork();
  const row = await rowFor(/View task Write backlinks/i);
  expect(row).toHaveTextContent("Alpha Project");
  expect(row).not.toHaveTextContent(projectId);
});

test("each task card shows the project name for its own project", async () => {
  fetchTaskList.mockResolvedValue({
    tasks: [
      {
        ...GREEN_TASK,
        taskId: "TASK-A",
        title: "Task A",
        description: "First description",
        projectId: "project-a-id",
        projectName: "Alpha Project",
      },
      {
        ...GREEN_TASK,
        taskId: "TASK-B",
        title: "Task B",
        description: "Second description",
        projectId: "project-b-id",
        projectName: "Beta Project",
      },
    ],
    zoneCounts: { ALL: 2, GREEN: 2, ORANGE: 0, RED: 0, COMPLETED: 0 },
  });
  renderWork();
  const rowA = await rowFor(/View task Task A/i);
  const rowB = await rowFor(/View task Task B/i);
  expect(rowA).toHaveTextContent("Alpha Project");
  expect(rowA).not.toHaveTextContent("Beta Project");
  expect(rowA).not.toHaveTextContent("project-a-id");
  expect(rowB).toHaveTextContent("Beta Project");
  expect(rowB).not.toHaveTextContent("Alpha Project");
  expect(rowB).not.toHaveTextContent("project-b-id");
});

test("unresolved projectId is not shown as the project name", async () => {
  const projectId = "6e7e628c-0408-4b2f-85e4-42f4decaf46f";
  fetchTaskList.mockResolvedValue({
    tasks: [{ ...GREEN_TASK, projectId, projectName: "" }],
    zoneCounts: COUNTS,
  });
  renderWork();
  const row = await rowFor(/View task Write backlinks/i);
  expect(row).not.toHaveTextContent(projectId);
});

test("project row is omitted when project is unavailable", async () => {
  renderWork();
  const row = await rowFor(/View task Write backlinks/i);
  expect(row).toHaveTextContent("—");
});

test("valid stored category is preserved", async () => {
  sessionStorage.setItem(ZONE_KEY, "RED");
  fetchTaskList.mockResolvedValue(emptyList());
  renderWork();
  expect(await screen.findByRole("combobox", { name: "Deadline" })).toHaveValue(
    "RED"
  );
  await waitFor(() =>
    expect(fetchTaskList).toHaveBeenCalledWith({ mine: "true" })
  );
});

test("review is labeled as submitted for review and no-deadline tasks stay visible", async () => {
  fetchTaskList.mockResolvedValue({
    tasks: [
      {
        ...GREEN_TASK,
        taskId: "TASK-REVIEW",
        title: "Waiting approval",
        status: "REVIEW",
        zone: "ORANGE",
        dueDate: "2026-11-01",
        myAssignment: {
          email: "rahul@mydgv.com",
          status: "REVIEW",
          zone: "ORANGE",
        },
      },
      {
        ...GREEN_TASK,
        taskId: "TASK-NONE",
        title: "Undated checklist",
        status: "TODO",
        zone: "NONE",
        dueDate: "",
        myAssignment: {
          email: "rahul@mydgv.com",
          status: "TODO",
          zone: "NONE",
        },
      },
    ],
    zoneCounts: COUNTS,
  });
  renderWork();
  const review = await rowFor(/View task Waiting approval/i);
  const undated = await rowFor(/View task Undated checklist/i);
  expect(review).toHaveTextContent("In review");
  expect(review).toHaveTextContent("Awaiting admin review");
  expect(review).not.toHaveTextContent("Completed");
  expect(review).toHaveTextContent("01 Nov 2026");
  expect(review).toHaveTextContent("Due soon");
  expect(undated).toHaveTextContent("No deadline");
  expect(review.compareDocumentPosition(undated) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("In Review")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /My Open Tasks \(2\)/ })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /Completed \(0\)/ })).toBeInTheDocument();
});

test("an older search response does not replace a newer one", async () => {
  const pending = [];
  fetchTaskList.mockImplementation(
    (params) =>
      new Promise((resolve) => {
        pending.push({ params, resolve });
      })
  );
  renderWork();
  expect(await screen.findByText("Loading tasks...")).toBeInTheDocument();
  const input = screen.getByPlaceholderText("Search tasks, project, or ID...");
  await userEvent.type(input, "old");
  await waitFor(() =>
    expect(pending.some((call) => call.params.q === "old")).toBe(true)
  );
  await userEvent.clear(input);
  await userEvent.type(input, "new");
  await waitFor(() =>
    expect(pending.some((call) => call.params.q === "new")).toBe(true)
  );
  const newest = [...pending].reverse().find((call) => call.params.q === "new");
  const older = pending.find((call) => call.params.q === "old");
  newest.resolve({
    tasks: [{ ...GREEN_TASK, taskId: "NEW", title: "New match" }],
    zoneCounts: COUNTS,
  });
  expect(await screen.findByText("New match")).toBeInTheDocument();
  older.resolve({
    tasks: [{ ...GREEN_TASK, taskId: "OLD", title: "Old match" }],
    zoneCounts: COUNTS,
  });
  await waitFor(() => expect(screen.queryByText("Old match")).not.toBeInTheDocument());
  expect(screen.getByText("New match")).toBeInTheDocument();
});

test("a failed task load shows an error", async () => {
  fetchTaskList.mockRejectedValue(new Error("offline"));
  renderWork();
  expect(
    await screen.findByRole("alert")
  ).toHaveTextContent("Unable to load tasks. Please try again.");
});

test("summary counts stay on the searched list while filters narrow the table", async () => {
  fetchTaskList.mockResolvedValue({
    tasks: [
      GREEN_TASK,
      {
        ...GREEN_TASK,
        taskId: "TASK-RED",
        title: "Overdue fix",
        zone: "RED",
        dueDate: "2026-10-30",
        myAssignment: { email: "rahul@mydgv.com", status: "TODO", zone: "RED" },
      },
      {
        ...GREEN_TASK,
        taskId: "TASK-REVIEW",
        title: "Waiting approval",
        status: "REVIEW",
        zone: "ORANGE",
        myAssignment: { email: "rahul@mydgv.com", status: "REVIEW", zone: "ORANGE" },
      },
      COMPLETED_TASK,
    ],
    zoneCounts: COUNTS,
  });
  renderWork();
  expect(await screen.findByRole("tab", { name: /All Tasks \(4\)/ })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /My Open Tasks \(3\)/ })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /Completed \(1\)/ })).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "TODO");
  expect(screen.getByRole("tab", { name: /All Tasks \(4\)/ })).toBeInTheDocument();
  expect(screen.getByText("Overdue fix")).toBeInTheDocument();
  expect(screen.queryByText("Waiting approval")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Status: To do/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
  expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("ALL");
  expect(screen.getByText("Waiting approval")).toBeInTheDocument();
});

test("overdue tasks sort ahead of later deadlines and no-deadline tasks stay last", async () => {
  fetchTaskList.mockResolvedValue({
    tasks: [
      {
        ...GREEN_TASK,
        taskId: "TASK-NONE",
        title: "Undated checklist",
        zone: "NONE",
        dueDate: "",
        myAssignment: { email: "rahul@mydgv.com", status: "TODO", zone: "NONE" },
      },
      {
        ...GREEN_TASK,
        taskId: "TASK-LATER",
        title: "Later work",
        zone: "GREEN",
        dueDate: "2026-12-01",
      },
      {
        ...GREEN_TASK,
        taskId: "TASK-RED",
        title: "Overdue fix",
        zone: "RED",
        dueDate: "2026-10-01",
        myAssignment: { email: "rahul@mydgv.com", status: "TODO", zone: "RED" },
      },
    ],
    zoneCounts: COUNTS,
  });
  renderWork();
  const overdue = await rowFor(/View task Overdue fix/i);
  const later = await rowFor(/View task Later work/i);
  const undated = await rowFor(/View task Undated checklist/i);
  expect(overdue.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(later.compareDocumentPosition(undated) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(overdue).toHaveTextContent("To do");
  expect(overdue).toHaveTextContent("Overdue");
  expect(within(overdue).queryByRole("button", { name: "Start work" })).not.toBeInTheDocument();
  expect(within(later).getByRole("button", { name: "Start work" })).toBeInTheDocument();
});

test("start work updates a to-do assignment that already has planned hours", async () => {
  const ready = {
    ...GREEN_TASK,
    myAssignment: { ...GREEN_TASK.myAssignment, plannedHours: "4" },
  };
  fetchTaskList.mockResolvedValue({ tasks: [ready], zoneCounts: COUNTS });
  updateTask.mockResolvedValue({});
  renderWork();
  await userEvent.click(await screen.findByRole("button", { name: "Start work" }));
  await waitFor(() =>
    expect(updateTask).toHaveBeenCalledWith({
      taskId: GREEN_TASK.taskId,
      projectId: undefined,
      status: "IN_PROGRESS",
      assignmentEmail: "rahul@mydgv.com",
      plannedHours: 4,
    })
  );
});

test("start work opens the task when planned hours are missing", async () => {
  renderWork();
  await userEvent.click(await screen.findByRole("button", { name: "Start work" }));
  expect(updateTask).not.toHaveBeenCalled();
  expect(mockNavigate).toHaveBeenCalledWith("/work/TASK-GREEN-1");
});

test("in-progress submit opens the task and review has no employee action", async () => {
  fetchTaskList.mockResolvedValue({
    tasks: [
      {
        ...GREEN_TASK,
        taskId: "TASK-PROGRESS",
        title: "Active work",
        status: "IN_PROGRESS",
        myAssignment: { email: "rahul@mydgv.com", status: "IN_PROGRESS", zone: "GREEN" },
      },
      {
        ...GREEN_TASK,
        taskId: "TASK-REVIEW",
        title: "Waiting approval",
        status: "REVIEW",
        myAssignment: { email: "rahul@mydgv.com", status: "REVIEW", zone: "ORANGE" },
      },
    ],
    zoneCounts: COUNTS,
  });
  renderWork();
  await userEvent.click(await screen.findByRole("button", { name: "Submit for review" }));
  expect(mockNavigate).toHaveBeenCalledWith("/work/TASK-PROGRESS");
  expect(updateTask).not.toHaveBeenCalled();
  expect(await rowFor(/View task Waiting approval/i)).toHaveTextContent("Awaiting admin review");
  expect(screen.queryByRole("button", { name: "Start work" })).not.toBeInTheDocument();
});

test("a conflicting start tells the employee to refresh", async () => {
  const ready = {
    ...GREEN_TASK,
    myAssignment: { ...GREEN_TASK.myAssignment, plannedHours: "4" },
  };
  fetchTaskList.mockResolvedValue({ tasks: [ready], zoneCounts: COUNTS });
  const conflict = new Error("conflict");
  conflict.status = 409;
  updateTask.mockRejectedValue(conflict);
  renderWork();
  await userEvent.click(await screen.findByRole("button", { name: "Start work" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This assignment was not saved because it changed. Refresh the task and try again."
  );
  expect(screen.getByRole("button", { name: "Refresh task" })).toBeInTheDocument();
  expect(screen.getByText("Write backlinks")).toBeInTheDocument();
});

test("a stored completed filter opens the completed list", async () => {
  sessionStorage.setItem(ZONE_KEY, "COMPLETED");
  fetchTaskList.mockResolvedValue({ tasks: [COMPLETED_TASK, GREEN_TASK], zoneCounts: COUNTS });
  renderWork();
  expect(await screen.findByText("Finished report")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /^Completed/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(screen.queryByText("Write backlinks")).not.toBeInTheDocument();
});

function withAssignedAt(task, assignedAt, extra = {}) {
  const assignment = {
    ...task.myAssignment,
    ...(extra.myAssignment || {}),
  };
  if (assignedAt) assignment.assignedAt = assignedAt;
  return {
    ...task,
    ...extra,
    myAssignment: assignment,
  };
}

test("assigned period updates the list, tabs, and summary together", async () => {
  jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-02T12:00:00+05:30"));
  fetchTaskList.mockResolvedValue({
    tasks: [
      withAssignedAt(GREEN_TASK, "2026-10-26T18:30:00.000Z", {
        taskId: "WEEK-START",
        title: "Week start",
      }),
      withAssignedAt(GREEN_TASK, "2026-10-26T18:29:59.999Z", {
        taskId: "BEFORE-WEEK",
        title: "Before week",
      }),
      withAssignedAt(COMPLETED_TASK, "2026-10-15T10:00:00+05:30", {
        title: "October task",
      }),
      withAssignedAt(GREEN_TASK, "2026-10-31T18:30:00.000Z", {
        taskId: "MONTH-START",
        title: "Month start",
        status: "REVIEW",
        zone: "ORANGE",
        myAssignment: { status: "REVIEW", zone: "ORANGE", email: "rahul@mydgv.com" },
      }),
      withAssignedAt(GREEN_TASK, "", {
        taskId: "NO-DATE",
        title: "No assignment date",
        createdAt: "2026-11-02T00:00:00.000Z",
        dueDate: "2026-11-02",
      }),
    ],
    zoneCounts: COUNTS,
  });
  try {
    renderWork();
    expect(await screen.findByText("No assignment date")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /All Tasks \(5\)/ })).toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Assigned period" }),
      "LAST_7"
    );
    expect(screen.getByText("Oct 27–Nov 2, 2026")).toBeInTheDocument();
    expect(screen.getByText("Week start")).toBeInTheDocument();
    expect(screen.getByText("Month start")).toBeInTheDocument();
    expect(screen.queryByText("Before week")).not.toBeInTheDocument();
    expect(screen.queryByText("October task")).not.toBeInTheDocument();
    expect(screen.queryByText("No assignment date")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /All Tasks \(2\)/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /My Open Tasks \(2\)/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Completed \(0\)/ })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "REVIEW");
    expect(screen.getByRole("tab", { name: /All Tasks \(2\)/ })).toBeInTheDocument();
    expect(screen.queryByText("Week start")).not.toBeInTheDocument();
    expect(screen.getByText("Month start")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "ALL");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Assigned period" }),
      "LAST_MONTH"
    );
    expect(screen.getByText("Oct 1–31, 2026")).toBeInTheDocument();
    expect(screen.getByText("October task")).toBeInTheDocument();
    expect(screen.getByText("Week start")).toBeInTheDocument();
    expect(screen.queryByText("Month start")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /All Tasks \(3\)/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Completed \(1\)/ })).toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Assigned period" }),
      "THIS_MONTH"
    );
    expect(screen.getByText("Nov 1–30, 2026")).toBeInTheDocument();
    expect(screen.getByText("Month start")).toBeInTheDocument();
    expect(screen.queryByText("October task")).not.toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Assigned period" }),
      "CUSTOM"
    );
    fireEvent.change(screen.getByLabelText("Assigned from"), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByLabelText("Assigned to"), {
      target: { value: "2026-10-31" },
    });
    expect(screen.getByText("Oct 1–31, 2026")).toBeInTheDocument();
    expect(screen.getByText("October task")).toBeInTheDocument();
    expect(screen.queryByText("Month start")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "All time" }));
    expect(screen.getByRole("combobox", { name: "Assigned period" })).toHaveValue("ALL");
    expect(screen.getByText("No assignment date")).toBeInTheDocument();
    expect(screen.getByText("October task")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /All Tasks \(5\)/ })).toBeInTheDocument();
  } finally {
    Date.now.mockRestore();
  }
});

test("an assigned period with no matches can be reset", async () => {
  jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-02T12:00:00+05:30"));
  fetchTaskList.mockResolvedValue({
    tasks: [withAssignedAt(GREEN_TASK, "2026-11-02T08:00:00+05:30")],
    zoneCounts: COUNTS,
  });
  try {
    renderWork();
    expect(await screen.findByText("Write backlinks")).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Assigned period" }),
      "LAST_MONTH"
    );
    expect(await screen.findByText("No tasks assigned in this period.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /All Tasks \(0\)/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Completed \(0\)/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All time" }));
    expect(screen.getByText("Write backlinks")).toBeInTheDocument();
  } finally {
    Date.now.mockRestore();
  }
});

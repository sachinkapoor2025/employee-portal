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
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Work from "./Work";
import { fetchTaskList } from "../services/api";

const ZONE_KEY = "dgv.mytasks.zone";
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
  fetchTaskList.mockResolvedValue({
    tasks: [GREEN_TASK],
    zoneCounts: COUNTS,
  });
});

afterEach(() => {
  sessionStorage.removeItem(ZONE_KEY);
  sessionStorage.removeItem(SEARCH_KEY);
});

test("All tab is not rendered and Green Orange Red Completed are", async () => {
  renderWork();
  expect(await screen.findByRole("tab", { name: /Green/ })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /Orange/ })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /Red/ })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /Completed/ })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: /^All\b/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/^All\b/)).not.toBeInTheDocument();
});

test("default category is Green", async () => {
  renderWork();
  const green = await screen.findByRole("tab", { name: /Green/ });
  expect(green).toHaveAttribute("aria-selected", "true");
  await waitFor(() =>
    expect(fetchTaskList).toHaveBeenCalledWith(
      expect.objectContaining({ mine: "true", zone: "GREEN" })
    )
  );
});

test("stored ALL is normalized to Green", async () => {
  sessionStorage.setItem(ZONE_KEY, "ALL");
  renderWork();
  expect(await screen.findByRole("tab", { name: /Green/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await waitFor(() =>
    expect(fetchTaskList).toHaveBeenCalledWith(
      expect.objectContaining({ zone: "GREEN" })
    )
  );
  await waitFor(() => expect(sessionStorage.getItem(ZONE_KEY)).toBe("GREEN"));
});

test("invalid stored category is normalized to Green", async () => {
  sessionStorage.setItem(ZONE_KEY, "PURPLE");
  renderWork();
  expect(await screen.findByRole("tab", { name: /Green/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await waitFor(() =>
    expect(fetchTaskList).toHaveBeenCalledWith(
      expect.objectContaining({ zone: "GREEN" })
    )
  );
  await waitFor(() => expect(sessionStorage.getItem(ZONE_KEY)).toBe("GREEN"));
});

test("clicking a task card navigates to /work/{taskId}", async () => {
  renderWork();
  const card = await screen.findByRole("link", {
    name: /View task Write backlinks/i,
  });
  await userEvent.click(card);
  expect(mockNavigate).toHaveBeenCalledWith("/work/TASK-GREEN-1");
});

test("status dropdown is not rendered on task cards", async () => {
  renderWork();
  await screen.findByRole("link", { name: /View task Write backlinks/i });
  expect(screen.queryByLabelText("Update task status")).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});

test("search still works with the four visible categories", async () => {
  renderWork();
  expect(await screen.findByText("Write backlinks")).toBeInTheDocument();
  const input = screen.getByPlaceholderText("Search tasks...");
  await userEvent.clear(input);
  await userEvent.type(input, "backlink");
  await waitFor(() =>
    expect(fetchTaskList).toHaveBeenCalledWith(
      expect.objectContaining({
        mine: "true",
        q: "backlink",
        zone: "GREEN",
      })
    )
  );
  expect(screen.getByRole("tab", { name: /Green/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(await screen.findByText("Write backlinks")).toBeInTheDocument();
});

test("empty Green Orange Red and Completed states use existing messages", async () => {
  fetchTaskList.mockResolvedValue(emptyList());
  renderWork();
  expect(
    await screen.findByText("No Green Zone tasks found.")
  ).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: /Orange/ }));
  expect(
    await screen.findByText("No Orange Zone tasks found.")
  ).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: /Red/ }));
  expect(
    await screen.findByText("No Red Zone tasks found.")
  ).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: /Completed/ }));
  expect(
    await screen.findByText("No completed tasks found.")
  ).toBeInTheDocument();

  expect(screen.queryByText(/No tasks assigned yet/i)).not.toBeInTheDocument();
});

test("completed task cards still navigate to Task Details", async () => {
  fetchTaskList.mockImplementation(async (params = {}) => {
    if (params.zone === "COMPLETED") {
      return { tasks: [COMPLETED_TASK], zoneCounts: COUNTS };
    }
    return { tasks: [], zoneCounts: COUNTS };
  });
  renderWork();
  await screen.findByRole("tab", { name: /Completed/ });
  await userEvent.click(screen.getByRole("tab", { name: /Completed/ }));
  expect(await screen.findByRole("tab", { name: /Completed/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  const card = await screen.findByRole("link", {
    name: /View task Finished report/i,
  });
  await userEvent.click(card);
  expect(mockNavigate).toHaveBeenCalledWith("/work/TASK-DONE-1");
});

test("valid stored category is preserved", async () => {
  sessionStorage.setItem(ZONE_KEY, "RED");
  fetchTaskList.mockResolvedValue(emptyList());
  renderWork();
  expect(await screen.findByRole("tab", { name: /Red/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await waitFor(() =>
    expect(fetchTaskList).toHaveBeenCalledWith(
      expect.objectContaining({ zone: "RED" })
    )
  );
});

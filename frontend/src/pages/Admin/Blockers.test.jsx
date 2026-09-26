import fs from "fs";
import path from "path";

jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../../components/ZoneBadge", () => {
  return function ZoneBadge({ zone }) {
    return <span>{zone || "zone"}</span>;
  };
});

const mockNavigate = jest.fn();
jest.mock(
  "react-router-dom",
  () => ({
    useNavigate: () => mockNavigate,
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchTasks: jest.fn(),
  resolveTaskBlocker: jest.fn(),
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Blockers from "./Blockers";
import { fetchTasks, resolveTaskBlocker } from "../../services/api";

function assignment({ email, status = "IN_PROGRESS", blockerStatus, extra = {} }) {
  return {
    email,
    status,
    zone: "GREEN",
    blockerStatus,
    ...extra,
  };
}

const TASK_A = {
  taskId: "task-a",
  projectId: "p1",
  projectName: "Portal",
  title: "Campaign brief",
  status: "IN_PROGRESS",
  assigneeProfiles: [
    { email: "ankit@mydgv.com", name: "Ankit" },
    { email: "priya@mydgv.com", name: "Priya" },
    { email: "nitin@mydgv.com", name: "Nitin" },
  ],
  assignments: [
    assignment({
      email: "ankit@mydgv.com",
      blockerStatus: "ACTIVE",
      extra: {
        blockerRemark: "Waiting on legal copy",
        blockerReportedAt: "2026-09-25T12:00:00.000Z",
      },
    }),
    assignment({ email: "priya@mydgv.com", blockerStatus: null }),
    assignment({ email: "nitin@mydgv.com", status: "DONE", blockerStatus: null }),
  ],
};

const TASK_B = {
  taskId: "task-b",
  projectId: "p1",
  projectName: "Portal",
  title: "Banner update",
  status: "REVIEW",
  assigneeProfiles: [{ email: "rahul@mydgv.com", name: "Rahul" }],
  assignments: [
    assignment({
      email: "rahul@mydgv.com",
      status: "REVIEW",
      blockerStatus: "RESOLVED",
      extra: {
        blockerRemark: "Old blocker",
        blockerReportedAt: "2026-09-20T12:00:00.000Z",
        blockerResolvedAt: "2026-09-21T12:00:00.000Z",
      },
    }),
  ],
};

const TASK_C = {
  taskId: "task-c",
  title: "Product upload",
  status: "TODO",
  assigneeProfiles: [{ email: "priya@mydgv.com", name: "Priya" }],
  assignments: [
    assignment({ email: "priya@mydgv.com", status: "TODO" }),
  ],
};

beforeEach(() => {
  mockNavigate.mockReset();
  fetchTasks.mockReset();
  resolveTaskBlocker.mockReset();
  fetchTasks.mockResolvedValue([TASK_A, TASK_B, TASK_C]);
  resolveTaskBlocker.mockResolvedValue({});
});

test("renders the blockers page from loaded tasks", async () => {
  render(<Blockers />);
  expect(await screen.findByRole("heading", { name: "Blockers" })).toBeInTheDocument();
  expect(fetchTasks).toHaveBeenCalled();
});

test("shows loading and not the empty state while the request is in flight", async () => {
  let resolveList;
  fetchTasks.mockReturnValue(
    new Promise((resolve) => {
      resolveList = resolve;
    })
  );
  render(<Blockers />);
  expect(screen.getByText("Loading blockers...")).toBeInTheDocument();
  expect(screen.queryByText("No active blockers")).not.toBeInTheDocument();
  resolveList([]);
  expect(await screen.findByText("No active blockers")).toBeInTheDocument();
});

test("ACTIVE assignment appears and RESOLVED/no-blocker do not", async () => {
  render(<Blockers />);
  expect(await screen.findByText("Campaign brief")).toBeInTheDocument();
  expect(screen.getByText("Waiting on legal copy")).toBeInTheDocument();
  expect(screen.getByText("Ankit")).toBeInTheDocument();
  expect(screen.queryByText("Banner update")).not.toBeInTheDocument();
  expect(screen.queryByText("Old blocker")).not.toBeInTheDocument();
  expect(screen.queryByText("Product upload")).not.toBeInTheDocument();
});

test("multi-assignee task shows only the ACTIVE assignment", async () => {
  render(<Blockers />);
  await screen.findByText("Campaign brief");
  expect(screen.getByText("Ankit")).toBeInTheDocument();
  expect(screen.queryByText("Priya")).not.toBeInTheDocument();
  expect(screen.queryByText("Nitin")).not.toBeInTheDocument();
  expect(screen.getByText("1 active blocker")).toBeInTheDocument();
});

test("displays title, employee, remark, reported time, and task status", async () => {
  render(<Blockers />);
  expect(await screen.findByText("Campaign brief")).toBeInTheDocument();
  expect(screen.getByText("Ankit")).toBeInTheDocument();
  expect(screen.getByText("Waiting on legal copy")).toBeInTheDocument();
  expect(screen.getByText("IN PROGRESS")).toBeInTheDocument();
  expect(screen.queryByText("BLOCKED")).not.toBeInTheDocument();
  expect(screen.queryByText("—")).not.toBeInTheDocument();
});

test("View Task uses the admin task details route", async () => {
  render(<Blockers />);
  await userEvent.click(await screen.findByRole("button", { name: "View Task" }));
  expect(mockNavigate).toHaveBeenCalledWith("/admin/tasks/task-a");
});

test("resolve confirmation cancel does not call the API", async () => {
  render(<Blockers />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Resolve Blocker" })
  );
  const dialog = await screen.findByRole("dialog", { name: "Resolve Blocker?" });
  expect(
    screen.getByText("Resolve the blocker reported by Ankit?")
  ).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Resolve Blocker?" })
    ).not.toBeInTheDocument()
  );
  expect(resolveTaskBlocker).not.toHaveBeenCalled();
  expect(screen.getByText("Campaign brief")).toBeInTheDocument();
});

test("successful resolve posts assignmentEmail and removes the blocker", async () => {
  const remaining = {
    ...TASK_A,
    assignments: [
      assignment({
        email: "ankit@mydgv.com",
        blockerStatus: "RESOLVED",
        extra: {
          blockerRemark: "Waiting on legal copy",
          blockerReportedAt: "2026-09-25T12:00:00.000Z",
          blockerResolvedAt: "2026-09-25T13:00:00.000Z",
        },
      }),
      assignment({ email: "priya@mydgv.com", blockerStatus: null }),
      assignment({
        email: "nitin@mydgv.com",
        status: "DONE",
        blockerStatus: null,
      }),
    ],
  };
  fetchTasks
    .mockResolvedValueOnce([TASK_A, TASK_B, TASK_C])
    .mockResolvedValueOnce([remaining, TASK_B, TASK_C]);
  render(<Blockers />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Resolve Blocker" })
  );
  const dialog = await screen.findByRole("dialog", { name: "Resolve Blocker?" });
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Resolve Blocker" })
  );
  await waitFor(() =>
    expect(resolveTaskBlocker).toHaveBeenCalledWith(
      "task-a",
      "ankit@mydgv.com"
    )
  );
  await waitFor(() =>
    expect(screen.queryByText("Campaign brief")).not.toBeInTheDocument()
  );
  expect(await screen.findByText("No active blockers")).toBeInTheDocument();
  expect(fetchTasks.mock.calls.length).toBeGreaterThan(1);
});

test("resolve failure keeps the blocker and shows the error", async () => {
  const err = new Error("No active blocker to resolve");
  err.status = 400;
  resolveTaskBlocker.mockRejectedValue(err);
  render(<Blockers />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Resolve Blocker" })
  );
  const dialog = await screen.findByRole("dialog", { name: "Resolve Blocker?" });
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Resolve Blocker" })
  );
  expect(
    await screen.findByText("No active blocker to resolve")
  ).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Resolve Blocker?" })).toBeInTheDocument();
  expect(screen.getByText("Campaign brief")).toBeInTheDocument();
  expect(screen.getByText("IN PROGRESS")).toBeInTheDocument();
});

test("zero active blockers shows the empty state", async () => {
  fetchTasks.mockResolvedValue([TASK_B, TASK_C]);
  render(<Blockers />);
  expect(await screen.findByText("No active blockers")).toBeInTheDocument();
  expect(
    screen.getByText("Employees have no unresolved blockers right now.")
  ).toBeInTheDocument();
  expect(screen.queryByText("Loading blockers...")).not.toBeInTheDocument();
});

test("count is ACTIVE assignments not tasks", async () => {
  fetchTasks.mockResolvedValue([
    {
      ...TASK_A,
      assignments: [
        assignment({
          email: "ankit@mydgv.com",
          blockerStatus: "ACTIVE",
          extra: {
            blockerRemark: "Ankit blocked",
            blockerReportedAt: "2026-09-25T12:00:00.000Z",
          },
        }),
        assignment({
          email: "priya@mydgv.com",
          blockerStatus: "ACTIVE",
          extra: {
            blockerRemark: "Priya blocked",
            blockerReportedAt: "2026-09-25T12:05:00.000Z",
          },
        }),
      ],
    },
    {
      taskId: "task-d",
      title: "Second task",
      status: "IN_PROGRESS",
      assigneeProfiles: [{ email: "nitin@mydgv.com", name: "Nitin" }],
      assignments: [
        assignment({
          email: "nitin@mydgv.com",
          blockerStatus: "ACTIVE",
          extra: {
            blockerRemark: "Nitin blocked",
            blockerReportedAt: "2026-09-25T12:10:00.000Z",
          },
        }),
      ],
    },
  ]);
  render(<Blockers />);
  expect(await screen.findByText("3 active blockers")).toBeInTheDocument();
  expect(screen.getByText("Ankit blocked")).toBeInTheDocument();
  expect(screen.getByText("Priya blocked")).toBeInTheDocument();
  expect(screen.getByText("Nitin blocked")).toBeInTheDocument();
});

test("resolving a blocker does not display BLOCKED as task status", async () => {
  fetchTasks
    .mockResolvedValueOnce([TASK_A])
    .mockResolvedValueOnce([
      {
        ...TASK_A,
        status: "IN_PROGRESS",
        assignments: [
          assignment({
            email: "ankit@mydgv.com",
            status: "IN_PROGRESS",
            blockerStatus: "RESOLVED",
            extra: {
              blockerRemark: "Waiting on legal copy",
              blockerReportedAt: "2026-09-25T12:00:00.000Z",
            },
          }),
          assignment({
            email: "priya@mydgv.com",
            status: "IN_PROGRESS",
            blockerStatus: "ACTIVE",
            extra: {
              blockerRemark: "Priya still blocked",
              blockerReportedAt: "2026-09-25T12:30:00.000Z",
            },
          }),
        ],
      },
    ]);
  render(<Blockers />);
  expect(await screen.findByText("Waiting on legal copy")).toBeInTheDocument();
  expect(screen.getByText("IN PROGRESS")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Resolve Blocker" }));
  const dialog = await screen.findByRole("dialog", { name: "Resolve Blocker?" });
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Resolve Blocker" })
  );
  expect(await screen.findByText("Priya still blocked")).toBeInTheDocument();
  expect(screen.getByText("IN PROGRESS")).toBeInTheDocument();
  expect(screen.queryByText("Waiting on legal copy")).not.toBeInTheDocument();
  expect(screen.queryByText("BLOCKED")).not.toBeInTheDocument();
});

test("admin blockers route uses RequireAuth adminOnly", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
  expect(src).toMatch(
    /path="\/admin\/blockers"[\s\S]*?<RequireAuth adminOnly>[\s\S]*?<Blockers/
  );
});

test("Blockers nav item sits under Work Management near Tasks", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../components/Layout.jsx"),
    "utf8"
  );
  expect(src).toMatch(
    /title: "Work Management"[\s\S]*label: "Tasks"[\s\S]*label: "🚧 Blockers"/
  );
  expect(src).toMatch(/path: "\/admin\/blockers"/);
});

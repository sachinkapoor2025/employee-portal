jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

const route = { projectId: "p1" };

jest.mock(
  "react-router-dom",
  () => ({
    Link: ({ children, to }) => <a href={to}>{children}</a>,
    useParams: () => route,
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchProjectCosting: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectCosting from "./ProjectCosting";
import { fetchProjectCosting } from "../../services/api";
import {
  INCOMPLETE_REPORT_TITLE,
  INCOMPLETE_TOTAL_DISPLAY,
  PARTIAL_COLLECTED_AMOUNT_LABEL,
} from "../../utils/costingReports";

function assignment(n, title) {
  return {
    taskId: `t${n}`,
    email: "rahul@mydgv.com",
    employeeName: "Rahul",
    title: title || `Task ${n}`,
    assignmentStatus: "DONE",
    estimatedHours: 1,
    plannedHours: 1,
    actualHours: 1,
    costStatus: "COSTED",
    amountUsd: 1,
  };
}

function costingPayload(projectId, name, assignments) {
  return {
    project: {
      projectId,
      name,
      projectCode: projectId === "p1" ? "INT-001" : "EXT-002",
      projectType: "INTERNAL",
    },
    summary: {
      taskCount: assignments.length,
      completedTaskCount: assignments.length,
      completedActualHours: assignments.length,
      confirmedCostUsd: assignments.length,
      pendingReviewHours: 0,
      missingRateCount: 0,
      missingCostRecordCount: 0,
    },
    assignments,
  };
}

beforeEach(() => {
  route.projectId = "p1";
  fetchProjectCosting.mockResolvedValue({
    project: {
      projectId: "p1",
      name: "Portal",
      projectCode: "INT-001",
      projectType: "INTERNAL",
    },
    summary: {
      taskCount: 2,
      completedTaskCount: 1,
      completedActualHours: 3,
      confirmedCostUsd: 6.75,
      pendingReviewHours: 4,
      missingRateCount: 0,
      missingCostRecordCount: 1,
    },
    assignments: [
      {
        taskId: "t1",
        email: "rahul@mydgv.com",
        employeeName: "Rahul",
        title: "Done work",
        assignmentStatus: "DONE",
        estimatedHours: 4,
        plannedHours: 3.5,
        actualHours: 3,
        assignedAt: "2026-02-01T00:00:00.000Z",
        completedDate: "2026-02-11",
        hourlyRateUsd: 2.25,
        rateSource: "EMPLOYEE",
        amountUsd: 6.75,
        costStatus: "COSTED",
      },
    ],
    nextCursor: "abc",
  });
});

test("shows project costing totals and assignment snapshot amounts", async () => {
  render(<ProjectCosting />);
  expect(await screen.findByRole("heading", { name: "Portal" })).toBeInTheDocument();
  expect(screen.getByText("INT-001", { exact: false })).toBeInTheDocument();
  expect(screen.getAllByText("$6.75").length).toBeGreaterThan(0);
  expect(screen.getByText("Confirmed cost")).toBeInTheDocument();
  expect(screen.queryByText(INCOMPLETE_REPORT_TITLE)).not.toBeInTheDocument();
  expect(screen.queryByText(INCOMPLETE_TOTAL_DISPLAY)).not.toBeInTheDocument();
  expect(screen.getByText("Pending review hours")).toBeInTheDocument();
  expect(screen.getByText("Done work")).toBeInTheDocument();
  expect(screen.getByText("Costed")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(fetchProjectCosting).toHaveBeenLastCalledWith("p1", {
    limit: 80,
    cursor: "abc",
  });
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(fetchProjectCosting).toHaveBeenLastCalledWith("p1", {
    limit: 80,
    cursor: undefined,
  });
});

test("warns that truncated project totals are not authoritative", async () => {
  fetchProjectCosting.mockResolvedValueOnce({
    project: { projectId: "p1", name: "Portal", projectCode: "INT-001" },
    summary: {
      confirmedCostUsd: 6.75,
      pendingReviewHours: 4,
      missingRateCount: 1,
      missingCostRecordCount: 1,
    },
    assignments: [
      {
        taskId: "t1",
        email: "rahul@mydgv.com",
        title: "Done work",
        costStatus: "COSTED",
        amountUsd: 6.75,
      },
      { taskId: "t2", email: "rahul@mydgv.com", title: "Review", costStatus: "PENDING_REVIEW" },
      { taskId: "t3", email: "rahul@mydgv.com", title: "No rate", costStatus: "MISSING_RATE" },
      {
        taskId: "t4",
        email: "rahul@mydgv.com",
        title: "Legacy",
        costStatus: "MISSING_COST_RECORD",
      },
      { taskId: "t5", email: "rahul@mydgv.com", title: "Old", costStatus: "SUPERSEDED" },
    ],
    truncated: true,
    nextCursor: "abc",
  });
  render(<ProjectCosting />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    INCOMPLETE_REPORT_TITLE
  );
  expect(
    screen.getByText(/did not collect all eligible records/i)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/not a complete or authoritative cost/i)
  ).toBeInTheDocument();
  expect(screen.getByText("Confirmed cost")).toBeInTheDocument();
  expect(screen.getByText(INCOMPLETE_TOTAL_DISPLAY)).toBeInTheDocument();
  expect(
    screen.getByText(`${PARTIAL_COLLECTED_AMOUNT_LABEL}: $6.75`)
  ).toBeInTheDocument();
  const confirmedCard = screen.getByText("Confirmed cost").parentElement;
  expect(confirmedCard).toHaveTextContent(INCOMPLETE_TOTAL_DISPLAY);
  expect(confirmedCard).not.toHaveTextContent("$6.75");
  expect(screen.getByText("Costed")).toBeInTheDocument();
  expect(screen.getByText("Pending review")).toBeInTheDocument();
  expect(screen.getAllByText("Missing rate").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Missing cost records").length).toBeGreaterThan(0);
  expect(screen.getByText("Missing cost record")).toBeInTheDocument();
  expect(screen.getByText("Reassigned")).toBeInTheDocument();
});

test("keeps the truncated project warning after loading another page", async () => {
  fetchProjectCosting
    .mockResolvedValueOnce({
      project: { projectId: "p1", name: "Portal", projectCode: "INT-001" },
      summary: { confirmedCostUsd: 6.75, pendingReviewHours: 0 },
      assignments: [],
      truncated: true,
      nextCursor: "abc",
    })
    .mockResolvedValueOnce({
      project: { projectId: "p1", name: "Portal", projectCode: "INT-001" },
      summary: { confirmedCostUsd: 6.75, pendingReviewHours: 0 },
      assignments: [],
      truncated: false,
    });
  render(<ProjectCosting />);
  expect(await screen.findByText(INCOMPLETE_REPORT_TITLE)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await waitFor(() => {
    expect(fetchProjectCosting).toHaveBeenCalledTimes(2);
  });
  expect(screen.getByText(INCOMPLETE_REPORT_TITLE)).toBeInTheDocument();
  expect(screen.getByText(INCOMPLETE_TOTAL_DISPLAY)).toBeInTheDocument();
});

test("refreshing a complete project response clears truncation", async () => {
  fetchProjectCosting
    .mockResolvedValueOnce({
      project: { projectId: "p1", name: "Portal", projectCode: "INT-001" },
      summary: { confirmedCostUsd: 6.75, pendingReviewHours: 0 },
      assignments: [],
      truncated: true,
    })
    .mockResolvedValueOnce({
      project: { projectId: "p1", name: "Portal", projectCode: "INT-001" },
      summary: { confirmedCostUsd: 6.75, pendingReviewHours: 0 },
      assignments: [],
      truncated: false,
    });
  render(<ProjectCosting />);
  expect(await screen.findByText(INCOMPLETE_REPORT_TITLE)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => {
    expect(screen.queryByText(INCOMPLETE_REPORT_TITLE)).not.toBeInTheDocument();
    expect(screen.getByText("$6.75")).toBeInTheDocument();
  });
  expect(screen.queryByText(INCOMPLETE_TOTAL_DISPLAY)).not.toBeInTheDocument();
});

test("task table keeps readable dates and pagination below the rows", async () => {
  render(<ProjectCosting />);
  const title = await screen.findByText("Done work");
  const table = screen.getByRole("table");
  expect(table.closest(".dgv-costing-tasks")).not.toBeNull();
  expect(title.closest("td")).toHaveClass("dgv-costing-tasks__wrap");
  expect(screen.getByText("11 Feb 2026")).toBeInTheDocument();
  expect(screen.getByText("rahul@mydgv.com").closest("div")).toHaveClass(
    "dgv-costing-tasks__meta"
  );
  const nav = screen.getByRole("navigation", { name: "Task pagination" });
  expect(
    table.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(screen.getByText("Confirmed cost")).toBeInTheDocument();
});

test("shows 10 tasks per page and moves with next and previous", async () => {
  const assignments = Array.from({ length: 12 }, (_, index) =>
    assignment(index + 1)
  );
  fetchProjectCosting.mockResolvedValue(
    costingPayload("p1", "Portal", assignments)
  );
  render(<ProjectCosting />);
  expect(await screen.findByText("Task 1")).toBeInTheDocument();
  for (let n = 1; n <= 10; n += 1) {
    expect(screen.getByText(`Task ${n}`)).toBeInTheDocument();
  }
  expect(screen.queryByText("Task 11")).not.toBeInTheDocument();
  expect(screen.queryByText("Task 12")).not.toBeInTheDocument();
  expect(screen.getByText("12 tasks")).toBeInTheDocument();
  expect(screen.getByText("Tasks").parentElement).toHaveTextContent("12");
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute(
    "aria-current",
    "page"
  );

  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("Task 11")).toBeInTheDocument();
  expect(screen.getByText("Task 12")).toBeInTheDocument();
  expect(screen.queryByText("Task 1")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute(
    "aria-current",
    "page"
  );

  await userEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(screen.getByText("Task 1")).toBeInTheDocument();
  expect(screen.queryByText("Task 11")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

test("returns to page 1 when the project or loaded task dataset changes", async () => {
  fetchProjectCosting.mockResolvedValue(
    costingPayload(
      "p1",
      "Portal",
      Array.from({ length: 12 }, (_, index) => assignment(index + 1))
    )
  );
  const view = render(<ProjectCosting />);
  expect(await screen.findByText("Task 10")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("Task 11")).toBeInTheDocument();

  fetchProjectCosting.mockResolvedValue(
    costingPayload("p1", "Portal", [
      assignment(1, "Kept alpha"),
      assignment(2, "Kept beta"),
      assignment(3, "Kept gamma"),
    ])
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Kept alpha")).toBeInTheDocument();
  expect(screen.getByText("Kept gamma")).toBeInTheDocument();
  expect(screen.queryByText("Task 11")).not.toBeInTheDocument();
  expect(screen.getByText("3 tasks")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

  fetchProjectCosting.mockResolvedValue(
    costingPayload(
      "p1",
      "Portal",
      Array.from({ length: 12 }, (_, index) => assignment(index + 1))
    )
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Task 1")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("Task 11")).toBeInTheDocument();

  route.projectId = "p2";
  fetchProjectCosting.mockResolvedValue(
    costingPayload("p2", "Other", [assignment(1, "Other project task")])
  );
  view.rerender(<ProjectCosting />);
  expect(
    await screen.findByRole("heading", { name: "Other" })
  ).toBeInTheDocument();
  expect(screen.getByText("Other project task")).toBeInTheDocument();
  expect(screen.queryByText("Task 11")).not.toBeInTheDocument();
  expect(screen.getByText("1 task")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

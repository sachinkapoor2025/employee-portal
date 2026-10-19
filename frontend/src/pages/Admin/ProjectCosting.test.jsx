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

beforeEach(() => {
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

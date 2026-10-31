jest.mock(
  "react-router-dom",
  () => ({
    Link: ({ children, to }) => <a href={to}>{children}</a>,
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchEmployeeCosting: jest.fn(),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmployeeCostingPanel from "./EmployeeCostingPanel";
import { fetchEmployeeCosting } from "../../services/api";
import {
  INCOMPLETE_REPORT_TITLE,
  INCOMPLETE_TOTAL_DISPLAY,
  PARTIAL_COLLECTED_AMOUNT_LABEL,
} from "../../utils/costingReports";

function metricCard(label) {
  return screen.getByText(label, { selector: ".dgv-costing-metrics__label" })
    .parentElement;
}

beforeEach(() => {
  fetchEmployeeCosting.mockResolvedValue({
    employee: { email: "rahul@mydgv.com", name: "Rahul" },
    summary: {
      completedActualHours: 3,
      confirmedCostUsd: 6.75,
      pendingReviewHours: 4,
      missingRateCount: 1,
      missingCostRecordCount: 0,
    },
    projects: [
      {
        projectId: "p1",
        name: "Portal",
        completedActualHours: 3,
        confirmedCostUsd: 6.75,
        missingRateCount: 1,
        missingCostRecordCount: 0,
      },
    ],
    assignments: [
      {
        taskId: "t1",
        email: "rahul@mydgv.com",
        title: "Banner",
        projectName: "Portal",
        actualHours: 3,
        assignedAt: "2026-02-01T00:00:00.000Z",
        completedDate: "2026-02-11",
        hourlyRateUsd: 2.25,
        rateSource: "EMPLOYEE",
        amountUsd: 6.75,
        costStatus: "COSTED",
      },
    ],
    truncated: false,
    nextCursor: "emp-cursor",
  });
});

test("loads employee costing for the selected date range", async () => {
  render(<EmployeeCostingPanel email="rahul@mydgv.com" />);
  expect(await screen.findByRole("link", { name: "Portal" })).toBeInTheDocument();
  expect(screen.queryByText("Banner")).not.toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Task" })).not.toBeInTheDocument();
  expect(screen.getAllByText("$6.75").length).toBeGreaterThan(0);
  expect(metricCard("Missing rate")).toHaveTextContent("1");
  expect(fetchEmployeeCosting).toHaveBeenCalledWith(
    "rahul@mydgv.com",
    expect.objectContaining({
      from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      limit: 80,
    })
  );
  expect(
    screen.queryByText(/more assignments than the report window/i)
  ).not.toBeInTheDocument();
  expect(screen.queryByText(INCOMPLETE_REPORT_TITLE)).not.toBeInTheDocument();
  expect(metricCard("Confirmed cost")).toHaveTextContent("$6.75");
  expect(
    screen.queryByText(PARTIAL_COLLECTED_AMOUNT_LABEL, { exact: false })
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/approved task snapshots within the selected date range/i)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Pending review and missing records are not included/i)
  ).toBeInTheDocument();
});

test("does not render task rows returned with the costing summary", async () => {
  fetchEmployeeCosting.mockResolvedValueOnce({
    summary: { missingRateCount: 1, confirmedCostUsd: 6, completedActualHours: 6 },
    projects: [],
    assignments: [
      {
        taskId: "t-rate",
        email: "rahul@mydgv.com",
        title: "No rate task",
        costStatus: "MISSING_RATE",
        actualHours: 6,
        amountUsd: null,
      },
      {
        taskId: "t-legacy",
        email: "rahul@mydgv.com",
        title: "Legacy task",
        costStatus: "COSTED",
        legacyBaseline: true,
        actualHours: 6,
        amountUsd: 6,
        hourlyRateUsd: 1,
      },
    ],
    truncated: false,
  });
  render(<EmployeeCostingPanel email="rahul@mydgv.com" />);
  expect(await screen.findByText("Confirmed cost")).toBeInTheDocument();
  expect(screen.queryByText("No rate task")).not.toBeInTheDocument();
  expect(screen.queryByText("Legacy task")).not.toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Task" })).not.toBeInTheDocument();
  expect(
    screen.queryByText("No applicable rate is stored, so there is no confirmed cost.")
  ).not.toBeInTheDocument();
  expect(metricCard("Missing rate")).toHaveTextContent("1");
  expect(metricCard("Confirmed cost")).toHaveTextContent("$6.00");
});

test("resets the cursor when the date filter changes and on refresh", async () => {
  render(<EmployeeCostingPanel email="rahul@mydgv.com" />);
  expect(await screen.findByRole("link", { name: "Portal" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(fetchEmployeeCosting).toHaveBeenLastCalledWith(
    "rahul@mydgv.com",
    expect.objectContaining({ cursor: "emp-cursor" })
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(fetchEmployeeCosting).toHaveBeenLastCalledWith(
    "rahul@mydgv.com",
    expect.objectContaining({
      cursor: undefined,
      from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
  );
  fireEvent.change(screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/)[0], {
    target: { value: "2026-01-01" },
  });
  expect(fetchEmployeeCosting).toHaveBeenLastCalledWith(
    "rahul@mydgv.com",
    expect.objectContaining({ from: "2026-01-01", cursor: undefined })
  );
});

test("warns when employee costing results are truncated", async () => {
  fetchEmployeeCosting.mockResolvedValueOnce({
    employee: { email: "rahul@mydgv.com", name: "Rahul" },
    summary: {
      completedActualHours: 3,
      confirmedCostUsd: 6.75,
      pendingReviewHours: 4,
      missingRateCount: 1,
      missingCostRecordCount: 1,
    },
    projects: [
      {
        projectId: "p1",
        name: "Portal",
        completedActualHours: 3,
        confirmedCostUsd: 6.75,
        missingRateCount: 1,
        missingCostRecordCount: 1,
      },
    ],
    assignments: [
      {
        taskId: "t1",
        email: "rahul@mydgv.com",
        title: "Banner",
        projectName: "Portal",
        actualHours: 3,
        hourlyRateUsd: 2.25,
        amountUsd: 6.75,
        costStatus: "COSTED",
      },
      {
        taskId: "t2",
        email: "rahul@mydgv.com",
        title: "Review work",
        costStatus: "PENDING_REVIEW",
      },
      {
        taskId: "t3",
        email: "rahul@mydgv.com",
        title: "No rate",
        costStatus: "MISSING_RATE",
      },
      {
        taskId: "t4",
        email: "rahul@mydgv.com",
        title: "Legacy done",
        costStatus: "MISSING_COST_RECORD",
      },
      {
        taskId: "t5",
        email: "rahul@mydgv.com",
        title: "Old assignee",
        costStatus: "SUPERSEDED",
      },
    ],
    truncated: true,
    nextCursor: "emp-cursor",
  });
  render(<EmployeeCostingPanel email="rahul@mydgv.com" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    INCOMPLETE_REPORT_TITLE
  );
  expect(
    screen.getByText(/did not collect all eligible records/i)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/not a complete or authoritative cost/i)
  ).toBeInTheDocument();
  expect(metricCard("Confirmed cost")).toHaveTextContent(INCOMPLETE_TOTAL_DISPLAY);
  expect(metricCard("Confirmed cost")).not.toHaveTextContent("$6.75");
  expect(
    screen.getByText(`${PARTIAL_COLLECTED_AMOUNT_LABEL}: $6.75`)
  ).toBeInTheDocument();
  expect(screen.getAllByText(INCOMPLETE_TOTAL_DISPLAY).length).toBeGreaterThan(0);
  expect(screen.queryByText("Banner")).not.toBeInTheDocument();
  expect(screen.queryByText("Review work")).not.toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Task" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Portal" })).toBeInTheDocument();
  expect(metricCard("Missing rate")).toHaveTextContent("1");
  expect(metricCard("Missing cost records")).toHaveTextContent("1");
});

test("keeps the truncated warning after loading another page", async () => {
  fetchEmployeeCosting
    .mockResolvedValueOnce({
      employee: { email: "rahul@mydgv.com" },
      summary: { confirmedCostUsd: 6.75, pendingReviewHours: 0 },
      projects: [],
      assignments: [],
      truncated: true,
      nextCursor: "emp-cursor",
    })
    .mockResolvedValueOnce({
      employee: { email: "rahul@mydgv.com" },
      summary: { confirmedCostUsd: 6.75, pendingReviewHours: 0 },
      projects: [],
      assignments: [],
      truncated: false,
      nextCursor: undefined,
    });
  render(<EmployeeCostingPanel email="rahul@mydgv.com" />);
  expect(await screen.findByText(INCOMPLETE_REPORT_TITLE)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await waitFor(() => {
    expect(fetchEmployeeCosting).toHaveBeenCalledTimes(2);
  });
  expect(screen.getByText(INCOMPLETE_REPORT_TITLE)).toBeInTheDocument();
  expect(metricCard("Confirmed cost")).not.toHaveTextContent("$6.75");
});

test("refreshing a complete response clears a previous truncation warning", async () => {
  fetchEmployeeCosting
    .mockResolvedValueOnce({
      employee: { email: "rahul@mydgv.com" },
      summary: { confirmedCostUsd: 6.75, pendingReviewHours: 0 },
      projects: [],
      assignments: [],
      truncated: true,
    })
    .mockResolvedValueOnce({
      employee: { email: "rahul@mydgv.com" },
      summary: {
        completedActualHours: 3,
        confirmedCostUsd: 6.75,
        pendingReviewHours: 0,
        missingRateCount: 0,
        missingCostRecordCount: 0,
      },
      projects: [],
      assignments: [],
      truncated: false,
    });
  render(<EmployeeCostingPanel email="rahul@mydgv.com" />);
  expect(await screen.findByText(INCOMPLETE_REPORT_TITLE)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => {
    expect(screen.queryByText(INCOMPLETE_REPORT_TITLE)).not.toBeInTheDocument();
    expect(metricCard("Confirmed cost")).toHaveTextContent("$6.75");
  });
});

test("changing the date filter cannot leave a stale truncation warning", async () => {
  fetchEmployeeCosting
    .mockResolvedValueOnce({
      employee: { email: "rahul@mydgv.com" },
      summary: { confirmedCostUsd: 6.75, pendingReviewHours: 0 },
      projects: [],
      assignments: [],
      truncated: true,
    })
    .mockResolvedValue({
      employee: { email: "rahul@mydgv.com" },
      summary: {
        completedActualHours: 3,
        confirmedCostUsd: 6.75,
        pendingReviewHours: 0,
        missingRateCount: 0,
        missingCostRecordCount: 0,
      },
      projects: [],
      assignments: [],
      truncated: false,
    });
  render(<EmployeeCostingPanel email="rahul@mydgv.com" />);
  expect(await screen.findByText(INCOMPLETE_REPORT_TITLE)).toBeInTheDocument();
  fireEvent.change(screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/)[0], {
    target: { value: "2026-01-01" },
  });
  await waitFor(() => {
    expect(screen.queryByText(INCOMPLETE_REPORT_TITLE)).not.toBeInTheDocument();
    expect(metricCard("Confirmed cost")).toHaveTextContent("$6.75");
  });
});

test("shows summary metrics as cards and a linked project breakdown", async () => {
  fetchEmployeeCosting.mockResolvedValueOnce({
    summary: {
      completedActualHours: 3,
      confirmedCostUsd: 6.75,
      pendingReviewHours: 4,
      missingRateCount: 1,
      missingCostRecordCount: 0,
      unpricedLegacyHours: 2,
    },
    projects: [
      {
        projectId: "p1",
        name: "Portal",
        completedActualHours: 3,
        confirmedCostUsd: 6.75,
        missingRateCount: 1,
        missingCostRecordCount: 0,
      },
    ],
    assignments: [],
    truncated: false,
  });
  render(<EmployeeCostingPanel email="rahul@mydgv.com" />);
  expect(await screen.findByRole("link", { name: "Portal" })).toHaveAttribute(
    "href",
    "/admin/projects/p1/costing"
  );
  expect(metricCard("Completed hours")).toHaveTextContent("3");
  expect(metricCard("Confirmed cost")).toHaveTextContent("$6.75");
  expect(metricCard("Pending review hours")).toHaveTextContent("4");
  expect(metricCard("Missing rate")).toHaveTextContent("1");
  expect(metricCard("Missing cost records")).toHaveTextContent("0");
  expect(metricCard("Unpriced legacy hours")).toHaveTextContent("2");
  const projectLink = screen.getByRole("link", { name: "Portal" });
  const projectTable = projectLink.closest("table");
  expect(projectTable).toHaveClass("dgv-costing-tasks__grid");
  expect(projectTable).toHaveClass("dgv-costing-tasks__grid--projects");
  expect(projectLink.closest(".dgv-costing-tasks")).not.toBeNull();
  expect(projectLink.closest("td")).toHaveClass("dgv-costing-tasks__wrap");
  expect(screen.getByRole("columnheader", { name: "Confirmed cost" })).toHaveClass(
    "dgv-costing-tasks__num"
  );
  expect(screen.queryByRole("columnheader", { name: "Task" })).not.toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Hours" })).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Costing date range" })).toContainElement(
    screen.getByLabelText("Range")
  );
  expect(
    screen.getByText(/approved task snapshots within the selected date range/i)
  ).toHaveClass("dgv-costing-note");
});

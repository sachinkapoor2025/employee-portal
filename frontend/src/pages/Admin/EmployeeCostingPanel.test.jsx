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
  expect(await screen.findByText("Banner")).toBeInTheDocument();
  expect(screen.getAllByText("$6.75").length).toBeGreaterThan(0);
  expect(screen.getByText(/Missing rate 1/)).toBeInTheDocument();
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
  expect(screen.getByText(/Confirmed cost \$6\.75/)).toBeInTheDocument();
  expect(
    screen.queryByText(PARTIAL_COLLECTED_AMOUNT_LABEL, { exact: false })
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/empty range is not proof that earlier work never existed/i)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/only includes assignments that have an employee index pointer/i)
  ).toBeInTheDocument();
  expect(screen.getByText("Costed")).toBeInTheDocument();
});

test("resets the cursor when the date filter changes and on refresh", async () => {
  render(<EmployeeCostingPanel email="rahul@mydgv.com" />);
  expect(await screen.findByText("Banner")).toBeInTheDocument();
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
  expect(screen.getByText(/Confirmed cost Incomplete — not authoritative/)).toBeInTheDocument();
  expect(screen.queryByText(/Confirmed cost \$6\.75/)).not.toBeInTheDocument();
  expect(
    screen.getByText(`${PARTIAL_COLLECTED_AMOUNT_LABEL}: $6.75`)
  ).toBeInTheDocument();
  expect(screen.getByText(INCOMPLETE_TOTAL_DISPLAY)).toBeInTheDocument();
  expect(
    screen.getByText(/empty range is not proof that earlier work never existed/i)
  ).toBeInTheDocument();
  expect(screen.getByText("Costed")).toBeInTheDocument();
  expect(screen.getByText("Pending review")).toBeInTheDocument();
  expect(screen.getByText("Missing rate")).toBeInTheDocument();
  expect(screen.getByText("Missing cost record")).toBeInTheDocument();
  expect(screen.getByText("Reassigned")).toBeInTheDocument();
  expect(screen.getByText(/Missing rate 1/)).toBeInTheDocument();
  expect(screen.getByText(/Missing cost records 1/)).toBeInTheDocument();
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
  expect(screen.queryByText(/Confirmed cost \$6\.75/)).not.toBeInTheDocument();
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
    expect(screen.getByText(/Confirmed cost \$6\.75/)).toBeInTheDocument();
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
    expect(screen.getByText(/Confirmed cost \$6\.75/)).toBeInTheDocument();
  });
});

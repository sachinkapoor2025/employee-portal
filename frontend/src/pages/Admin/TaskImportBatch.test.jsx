jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

const mockNavigate = jest.fn();
jest.mock(
  "react-router-dom",
  () => ({
    useNavigate: () => mockNavigate,
    useParams: () => ({ batchId: "batch-abc" }),
    Link: ({ to, children }) => <a href={to}>{children}</a>,
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchTaskImport: jest.fn(),
  getTaskImportDownloadUrl: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskImportBatch from "./TaskImportBatch";
import { fetchTaskImport, getTaskImportDownloadUrl } from "../../services/api";

const DETAIL = {
  summary: {
    batchId: "batch-abc",
    fileName: "tasks.xlsx",
    uploadedBy: "ada@mydgv.com",
    uploadedByName: "Ada Admin",
    uploadedAt: "2026-09-15T10:00:00.000Z",
    status: "PARTIAL",
    totalRows: 3,
    successCount: 2,
    failureCount: 1,
    confirmedAt: "2026-09-15T10:05:00.000Z",
    completedAt: "2026-09-15T10:06:00.000Z",
    auditEligibility: "INELIGIBLE",
    fileAvailable: false,
  },
  rows: [
    {
      rowNumber: 2,
      taskTitle: "Build portal",
      projectName: "Portal",
      assignmentMode: "IMMEDIATE",
      status: "SUCCESS",
      taskId: "task-1",
      assignment: {
        state: "ASSIGNED",
        scheduled: false,
        emails: ["rahul@mydgv.com"],
      },
      errors: [],
      warnings: [],
      cellErrors: [],
    },
    {
      rowNumber: 3,
      taskTitle: "Scheduled launch",
      projectName: "Portal",
      assignmentMode: "SCHEDULED",
      status: "SUCCESS",
      taskId: "task-2",
      assignment: {
        state: "PENDING",
        scheduled: true,
        emails: ["priya@mydgv.com"],
      },
      errors: [],
      warnings: [],
      cellErrors: [],
    },
    {
      rowNumber: 4,
      taskTitle: "Assigned later",
      projectName: "Portal",
      assignmentMode: "SCHEDULED",
      status: "SUCCESS",
      taskId: "task-3",
      assignment: {
        state: "ASSIGNED",
        scheduled: true,
        emails: ["lead@mydgv.com"],
      },
      errors: [],
      warnings: [],
      cellErrors: [],
    },
    {
      rowNumber: 5,
      taskTitle: "Broken row",
      projectName: "",
      assignmentMode: "IMMEDIATE",
      status: "FAILED",
      taskId: null,
      assignment: { state: "NONE", scheduled: false, emails: [] },
      errors: [{ field: "project", message: "Unknown project" }],
      cellErrors: [{ column: "Project", cell: "B5", message: "Unknown project" }],
      warnings: [],
    },
  ],
};

beforeEach(() => {
  mockNavigate.mockReset();
  fetchTaskImport.mockReset();
  getTaskImportDownloadUrl.mockReset();
  fetchTaskImport.mockResolvedValue(DETAIL);
  getTaskImportDownloadUrl.mockResolvedValue({
    downloadUrl: "https://signed.example/tasks.xlsx",
    expiresIn: 300,
    fileName: "tasks.xlsx",
  });
});

test("batch summary and rows render", async () => {
  render(<TaskImportBatch />);
  expect(screen.getByText("Loading import...")).toBeInTheDocument();
  expect(await screen.findByText("tasks.xlsx")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Excel Import" })).toBeInTheDocument();
  expect(screen.getByText("batch-abc")).toBeInTheDocument();
  expect(screen.getByText("Ada Admin")).toBeInTheDocument();
  expect(screen.getByText("Partial")).toBeInTheDocument();
  expect(screen.getByText("Build portal")).toBeInTheDocument();
  expect(screen.getByText("rahul@mydgv.com")).toBeInTheDocument();
  expect(
    screen.getByText("Scheduled / Pending (priya@mydgv.com)")
  ).toBeInTheDocument();
  expect(screen.getByText("lead@mydgv.com")).toBeInTheDocument();
  expect(screen.getByText(/Project: Unknown project/)).toBeInTheDocument();
  expect(
    screen.getByText("Original Excel file is no longer available.")
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Download Original Excel" })
  ).not.toBeInTheDocument();
});

test("task IDs link to existing task detail", async () => {
  render(<TaskImportBatch />);
  const link = await screen.findByRole("link", { name: "Build portal" });
  expect(link).toHaveAttribute("href", "/admin/tasks/task-1");
});

test("completed import view keeps task details and download", async () => {
  fetchTaskImport.mockResolvedValue({
    summary: {
      ...DETAIL.summary,
      status: "COMPLETED",
      failureCount: 0,
      successCount: 3,
      auditEligibility: "ELIGIBLE",
      fileAvailable: true,
    },
    rows: DETAIL.rows,
  });
  render(<TaskImportBatch />);
  expect(await screen.findByRole("button", { name: "Download Original Excel" })).toBeInTheDocument();
  expect(screen.getByText("Build portal")).toBeInTheDocument();
  expect(screen.getByText("rahul@mydgv.com")).toBeInTheDocument();
  expect(
    screen.getByText("Scheduled / Pending (priya@mydgv.com)")
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Original Excel file is no longer available.")
  ).not.toBeInTheDocument();
});

test("download button requests a download URL", async () => {
  fetchTaskImport.mockResolvedValue({
    summary: {
      ...DETAIL.summary,
      status: "COMPLETED",
      failureCount: 0,
      successCount: 3,
      auditEligibility: "ELIGIBLE",
      fileAvailable: true,
    },
    rows: DETAIL.rows,
  });
  const click = jest.fn();
  const originalCreate = document.createElement.bind(document);
  jest.spyOn(document, "createElement").mockImplementation((tagName, options) => {
    const el = originalCreate(tagName, options);
    if (String(tagName).toLowerCase() === "a") {
      el.click = click;
    }
    return el;
  });
  render(<TaskImportBatch />);
  userEvent.click(
    await screen.findByRole("button", { name: "Download Original Excel" })
  );
  await waitFor(() => {
    expect(getTaskImportDownloadUrl).toHaveBeenCalledWith("batch-abc");
  });
  expect(click).toHaveBeenCalled();
  document.createElement.mockRestore();
});

test("missing original file shows a professional message", async () => {
  fetchTaskImport.mockResolvedValue({
    summary: { ...DETAIL.summary, fileAvailable: false },
    rows: DETAIL.rows,
  });
  render(<TaskImportBatch />);
  expect(
    await screen.findByText("Original Excel file is no longer available.")
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Download Original Excel" })
  ).not.toBeInTheDocument();
});

test("shows an error state", async () => {
  fetchTaskImport.mockRejectedValue(new Error("Import batch not found"));
  render(<TaskImportBatch />);
  expect(await screen.findByText("Import batch not found")).toBeInTheDocument();
});

test("Excel Import History navigates back", async () => {
  render(<TaskImportBatch />);
  userEvent.click(
    await screen.findByRole("button", { name: "Excel Import History" })
  );
  expect(mockNavigate).toHaveBeenCalledWith("/admin/task-imports");
});

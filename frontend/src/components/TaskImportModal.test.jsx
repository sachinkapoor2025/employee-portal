jest.mock("../services/api", () => ({
  getTaskImportUploadUrl: jest.fn(),
  previewTaskImport: jest.fn(),
}));

jest.mock("../utils/taskImportTemplate", () => ({
  downloadTaskImportTemplate: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskImportModal from "./TaskImportModal";
import { getTaskImportUploadUrl, previewTaskImport } from "../services/api";

const FILE_NAME = "DGV-Task-Import-Template.xlsx";
const BATCH_ID = "11111111-2222-3333-4444-555555555555";

const readyPreview = {
  batchId: BATCH_ID,
  status: "READY",
  totalRows: 2,
  validRows: 2,
  invalidRows: 0,
  warningCount: 0,
  errors: [],
  rows: [
    {
      rowNumber: 2,
      status: "VALID",
      values: { taskTitle: "Homepage banner update" },
      errors: [],
      warnings: [],
      cellErrors: [],
    },
    {
      rowNumber: 3,
      status: "VALID",
      values: { taskTitle: "Leave calendar" },
      errors: [],
      warnings: [],
      cellErrors: [],
    },
  ],
};

const warningPreview = {
  ...readyPreview,
  totalRows: 1,
  validRows: 1,
  warningCount: 1,
  rows: [
    {
      rowNumber: 5,
      status: "VALID",
      raw: { assigneeEmail: "rahul@mydgv.com; Rahul@mydgv.com" },
      values: { taskTitle: "Homepage banner update", assignees: ["rahul@mydgv.com"] },
      errors: [],
      warnings: [
        { field: "assigneeEmail", message: "Duplicate assignee emails were removed." },
      ],
      cellErrors: [],
    },
  ],
};

const invalidPreview = {
  batchId: BATCH_ID,
  status: "NEEDS_FIX",
  totalRows: 1,
  validRows: 0,
  invalidRows: 1,
  warningCount: 0,
  errors: [],
  rows: [
    {
      rowNumber: 7,
      status: "INVALID",
      raw: { project: "Testng", assigneeEmail: "employee@mydgv.com" },
      values: { taskTitle: "Broken row" },
      errors: [],
      warnings: [],
      cellErrors: [
        {
          cell: "B7",
          column: "Project",
          value: "Testng",
          message: "Project does not exist.",
        },
        {
          cell: "C8",
          column: "Assignee Email",
          value: "employee@mydgv.com",
          message: "User is not ACTIVE.",
        },
      ],
    },
  ],
};

const workbookPreview = {
  batchId: BATCH_ID,
  status: "NEEDS_FIX",
  totalRows: 0,
  validRows: 0,
  invalidRows: 0,
  warningCount: 0,
  errors: [{ field: "workbook", message: "The workbook must contain a sheet named Tasks." }],
  rows: [],
};

function xlsxFile() {
  return new File(["PK"], FILE_NAME, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function chooseAndUpload() {
  const input = screen.getByLabelText(/choose excel file/i);
  userEvent.upload(input, xlsxFile());
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /^upload$/i })).toBeEnabled();
  });
  userEvent.click(screen.getByRole("button", { name: /^upload$/i }));
}

beforeEach(() => {
  getTaskImportUploadUrl.mockReset();
  previewTaskImport.mockReset();
  getTaskImportUploadUrl.mockResolvedValue({
    batchId: BATCH_ID,
    uploadUrl: "https://s3.test/upload",
    s3Key: "task-imports/admin/batch/original.xlsx",
  });
  previewTaskImport.mockResolvedValue(readyPreview);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
});

test("successful preview shows summary after upload", async () => {
  render(<TaskImportModal open onClose={jest.fn()} />);
  await chooseAndUpload();
  expect(await screen.findByText("Task Import Preview")).toBeInTheDocument();
  expect(screen.getByText("Total Rows")).toBeInTheDocument();
  expect(screen.getAllByText("Valid").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Invalid").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Warnings").length).toBeGreaterThan(0);
  expect(screen.getAllByText(FILE_NAME).length).toBeGreaterThan(0);
  expect(screen.getByText(BATCH_ID)).toBeInTheDocument();
  expect(previewTaskImport).toHaveBeenCalledWith(BATCH_ID);
  expect(screen.queryByText(/file uploaded successfully/i)).not.toBeInTheDocument();
});

test("all rows valid shows Ready to Import", async () => {
  render(<TaskImportModal open onClose={jest.fn()} />);
  await chooseAndUpload();
  expect(await screen.findByText("Ready to Import")).toBeInTheDocument();
  expect(screen.getByText("2 tasks are ready to be imported.")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /confirm import — coming soon/i })
  ).toBeDisabled();
});

test("invalid rows show Needs Fix and exact cellErrors", async () => {
  previewTaskImport.mockResolvedValue(invalidPreview);
  render(<TaskImportModal open onClose={jest.fn()} />);
  await chooseAndUpload();
  expect(await screen.findByText("Needs Fix")).toBeInTheDocument();
  expect(
    screen.getByText(/Please fix the errors in your Excel file and upload it again/i)
  ).toBeInTheDocument();
  expect(screen.getByText("Excel Row 7")).toBeInTheDocument();
  expect(screen.getByText("B7 — Project")).toBeInTheDocument();
  expect(screen.getByText("Value: Testng")).toBeInTheDocument();
  expect(screen.getByText("Error: Project does not exist.")).toBeInTheDocument();
  expect(screen.getByText("C8 — Assignee Email")).toBeInTheDocument();
  expect(screen.getByText("Value: employee@mydgv.com")).toBeInTheDocument();
  expect(screen.getByText("Error: User is not ACTIVE.")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /confirm import — coming soon/i })
  ).toBeDisabled();
});

test("warnings are shown separately from errors", async () => {
  previewTaskImport.mockResolvedValue(warningPreview);
  render(<TaskImportModal open onClose={jest.fn()} />);
  await chooseAndUpload();
  expect(await screen.findByText("Ready to Import")).toBeInTheDocument();
  expect(screen.getByText("Warnings (1)")).toBeInTheDocument();
  expect(screen.getByText("C5 — Assignee Email")).toBeInTheDocument();
  expect(screen.getByText("Duplicate assignee emails were removed.")).toBeInTheDocument();
  expect(screen.queryByText("Needs Fix")).not.toBeInTheDocument();
});

test("workbook-level errors are displayed clearly", async () => {
  previewTaskImport.mockResolvedValue(workbookPreview);
  render(<TaskImportModal open onClose={jest.fn()} />);
  await chooseAndUpload();
  expect(await screen.findByText("Tasks worksheet is missing.")).toBeInTheDocument();
  expect(screen.getByText("Needs Fix")).toBeInTheDocument();
});

test("Upload Corrected File returns to the file picker", async () => {
  previewTaskImport.mockResolvedValue(invalidPreview);
  render(<TaskImportModal open onClose={jest.fn()} />);
  await chooseAndUpload();
  expect(await screen.findByText("Needs Fix")).toBeInTheDocument();
  userEvent.click(screen.getByRole("button", { name: /upload corrected file/i }));
  expect(screen.getByRole("button", { name: /choose file/i })).toBeInTheDocument();
  expect(screen.queryByText("Task Import Preview")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^upload$/i })).toBeDisabled();
});

test("preview API failure shows a clear error", async () => {
  previewTaskImport.mockRejectedValue(new Error("Import batch not found."));
  render(<TaskImportModal open onClose={jest.fn()} />);
  await chooseAndUpload();
  expect(
    await screen.findByText(/this import batch is no longer available/i)
  ).toBeInTheDocument();
  expect(screen.queryByText("Ready to Import")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry preview/i })).toBeInTheDocument();
});

test("loading states show uploading then validating", async () => {
  let resolvePreview;
  previewTaskImport.mockReturnValue(
    new Promise((resolve) => {
      resolvePreview = resolve;
    })
  );
  render(<TaskImportModal open onClose={jest.fn()} />);
  await chooseAndUpload();
  expect(await screen.findByText(/uploading your excel file|validating rows/i)).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByText("Validating rows...")).toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: /validating/i })).toBeDisabled();
  resolvePreview(readyPreview);
  expect(await screen.findByText("Ready to Import")).toBeInTheDocument();
});

test("keeps template download and does not confirm import", async () => {
  render(<TaskImportModal open onClose={jest.fn()} />);
  expect(screen.getByRole("button", { name: /download excel template/i })).toBeInTheDocument();
  await chooseAndUpload();
  expect(await screen.findByRole("button", { name: /confirm import — coming soon/i })).toBeDisabled();
});

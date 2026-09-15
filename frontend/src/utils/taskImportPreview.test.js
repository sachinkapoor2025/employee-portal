import {
  collectPreviewWarnings,
  formatWorkbookError,
  invalidPreviewRows,
  isPreviewReady,
  rowCellErrors,
  userFacingImportError,
  workbookErrors,
} from "./taskImportPreview";

test("maps missing Tasks sheet to a clear workbook error", () => {
  expect(
    formatWorkbookError("The workbook must contain a sheet named Tasks.")
  ).toBe("Tasks worksheet is missing.");
});

test("maps header mismatch to a clear workbook error", () => {
  expect(
    formatWorkbookError(
      "The Tasks sheet columns must match the template names and order exactly."
    )
  ).toBe("Column headers do not match the required template.");
});

test("READY preview with no invalid rows is ready to import", () => {
  expect(
    isPreviewReady({ status: "READY", invalidRows: 0, errors: [], rows: [] })
  ).toBe(true);
  expect(
    isPreviewReady({
      status: "NEEDS_FIX",
      invalidRows: 1,
      errors: [],
      rows: [{ status: "INVALID" }],
    })
  ).toBe(false);
  expect(
    isPreviewReady({
      status: "READY",
      invalidRows: 0,
      errors: [{ message: "The workbook must contain a sheet named Tasks." }],
    })
  ).toBe(false);
});

test("uses backend cellErrors exactly", () => {
  const errors = rowCellErrors({
    rowNumber: 7,
    cellErrors: [
      {
        cell: "B7",
        column: "Project",
        value: "Testng",
        message: "Project does not exist.",
      },
    ],
  });
  expect(errors).toEqual([
    {
      cell: "B7",
      column: "Project",
      value: "Testng",
      message: "Project does not exist.",
    },
  ]);
});

test("collects warnings without treating them as invalid rows", () => {
  const preview = {
    status: "READY",
    invalidRows: 0,
    rows: [
      {
        rowNumber: 5,
        status: "VALID",
        raw: { assigneeEmail: "rahul@mydgv.com; Rahul@mydgv.com" },
        warnings: [
          { field: "assigneeEmail", message: "Duplicate assignee emails were removed." },
        ],
        errors: [],
      },
    ],
  };
  expect(isPreviewReady(preview)).toBe(true);
  expect(invalidPreviewRows(preview)).toHaveLength(0);
  expect(collectPreviewWarnings(preview)).toEqual([
    {
      rowNumber: 5,
      cell: "C5",
      column: "Assignee Email",
      message: "Duplicate assignee emails were removed.",
      value: "rahul@mydgv.com; Rahul@mydgv.com",
    },
  ]);
});

test("extracts workbook-level errors", () => {
  expect(
    workbookErrors({
      errors: [{ field: "workbook", message: "The workbook must contain a sheet named Tasks." }],
    })
  ).toEqual(["Tasks worksheet is missing."]);
});

test("maps expired batch and network errors for admins", () => {
  expect(
    userFacingImportError({ message: "Import batch not found." }, "preview")
  ).toMatch(/no longer available/i);
  expect(
    userFacingImportError({ message: "failed", isNetworkError: true }, "preview")
  ).toMatch(/connection/i);
  expect(
    userFacingImportError({ message: "Session expired. Please sign in again." })
  ).toMatch(/sign in/i);
});

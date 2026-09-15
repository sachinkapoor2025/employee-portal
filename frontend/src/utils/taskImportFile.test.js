import {
  TASK_IMPORT_MAX_BYTES,
  formatFileSize,
  reportedContentType,
  validateTaskImportFile,
} from "./taskImportFile";

test("accepts a valid .xlsx under 5 MB", () => {
  expect(
    validateTaskImportFile({ name: "tasks.xlsx", size: 1024, type: "" })
  ).toBeNull();
});

test("rejects non-xlsx extensions", () => {
  expect(validateTaskImportFile({ name: "tasks.xls", size: 1024 })).toMatch(
    /xlsx/i
  );
  expect(validateTaskImportFile({ name: "tasks.csv", size: 1024 })).toMatch(
    /xlsx/i
  );
});

test("accepts mixed-case .XLSX", () => {
  expect(
    validateTaskImportFile({ name: "BULK.XLSX", size: 2048 })
  ).toBeNull();
});

test("rejects files over 5 MB", () => {
  expect(
    validateTaskImportFile({
      name: "tasks.xlsx",
      size: TASK_IMPORT_MAX_BYTES + 1,
    })
  ).toMatch(/5 MB/i);
});

test("formats file size", () => {
  expect(formatFileSize(512)).toBe("512 B");
  expect(formatFileSize(2048)).toBe("2 KB");
  expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
});

test("reports content type without parameters", () => {
  expect(
    reportedContentType({
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=utf-8",
    })
  ).toBe(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  expect(reportedContentType({ type: "" })).toBe("");
});

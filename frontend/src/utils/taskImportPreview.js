export const TASK_IMPORT_COLUMN_MAP = [
  { key: "taskTitle", letter: "A", header: "Task Title" },
  { key: "project", letter: "B", header: "Project" },
  { key: "assigneeEmail", letter: "C", header: "Assignee Email" },
  { key: "assignmentMode", letter: "D", header: "Assignment Mode" },
  { key: "taskType", letter: "E", header: "Task Type" },
  { key: "priority", letter: "F", header: "Priority" },
  { key: "startDate", letter: "G", header: "Start Date" },
  { key: "startTime", letter: "H", header: "Start Time" },
  { key: "deadlineDate", letter: "I", header: "Deadline Date" },
  { key: "deadlineTime", letter: "J", header: "Deadline Time" },
  { key: "description", letter: "K", header: "Description" },
];

function columnMeta(field) {
  return TASK_IMPORT_COLUMN_MAP.find((col) => col.key === field) || null;
}

export function excelCell(field, rowNumber) {
  const meta = columnMeta(field);
  if (!meta || !Number.isFinite(Number(rowNumber))) return "";
  return `${meta.letter}${Number(rowNumber)}`;
}

export function columnHeader(field) {
  return columnMeta(field)?.header || field || "";
}

export function formatWorkbookError(error) {
  const message = typeof error === "string" ? error : String(error?.message || "");
  if (/sheet named Tasks/i.test(message) || /Tasks sheet is missing/i.test(message)) {
    return "Tasks worksheet is missing.";
  }
  if (/columns must match/i.test(message) || /unexpected extra columns/i.test(message)) {
    return "Column headers do not match the required template.";
  }
  return message;
}

export function workbookErrors(preview) {
  return (preview?.errors || [])
    .map((item) => (typeof item === "string" ? item : item?.message || ""))
    .filter(Boolean)
    .map(formatWorkbookError);
}

export function isPreviewReady(preview) {
  if (!preview) return false;
  const invalid = Number(preview.invalidRows || 0);
  const status = String(preview.status || "").toUpperCase();
  return status === "READY" && invalid === 0 && workbookErrors(preview).length === 0;
}

export function invalidPreviewRows(preview) {
  return (preview?.rows || []).filter(
    (row) => String(row.status || "").toUpperCase() === "INVALID"
  );
}

export function validPreviewRows(preview) {
  return (preview?.rows || []).filter(
    (row) => String(row.status || "").toUpperCase() === "VALID"
  );
}

export function rowCellErrors(row) {
  if (Array.isArray(row?.cellErrors) && row.cellErrors.length) {
    return row.cellErrors.map((item) => ({
      cell: item.cell || excelCell(item.field, row.rowNumber),
      column: item.column || columnHeader(item.field),
      value: item.value == null ? "" : String(item.value),
      message: item.message || "",
    }));
  }
  return (row?.errors || []).map((item) => ({
    cell: excelCell(item.field, row.rowNumber),
    column: columnHeader(item.field),
    value: item.value != null ? String(item.value) : String(row?.raw?.[item.field] || ""),
    message: item.message || "",
  }));
}

export function collectPreviewWarnings(preview) {
  const out = [];
  for (const row of preview?.rows || []) {
    for (const warning of row.warnings || []) {
      out.push({
        rowNumber: row.rowNumber,
        cell: excelCell(warning.field, row.rowNumber),
        column: columnHeader(warning.field),
        message: warning.message || "",
        value: String(row.raw?.[warning.field] || ""),
      });
    }
  }
  return out;
}

export function userFacingImportError(err, stage = "preview") {
  const message = String(err?.message || "").trim();
  if (err?.isNetworkError) {
    return "Unable to reach the server. Check your connection and try again.";
  }
  if (/session expired/i.test(message)) {
    return "Session expired. Please sign in again.";
  }
  if (stage === "upload" && /upload failed/i.test(message)) {
    return message;
  }
  if (/not found|no longer available|invalid batch/i.test(message)) {
    return "This import batch is no longer available. Please upload the file again.";
  }
  if (!message || /internal server error|lambda|stack|token|cognito/i.test(message)) {
    return stage === "upload"
      ? "Upload failed. Please try again."
      : "Preview failed. Please try again.";
  }
  return message;
}

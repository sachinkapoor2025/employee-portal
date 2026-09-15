export const TASK_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export function extOf(fileName) {
  const i = String(fileName || "").lastIndexOf(".");
  return i >= 0 ? String(fileName).slice(i).toLowerCase() : "";
}

export function reportedContentType(file) {
  return String(file?.type || "")
    .split(";")[0]
    .trim();
}

export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateTaskImportFile(file) {
  if (!file) return "Choose an Excel .xlsx file to import.";
  if (extOf(file.name) !== ".xlsx") return "Only .xlsx files are allowed.";
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return "Invalid file size.";
  if (size > TASK_IMPORT_MAX_BYTES) return "File size exceeds the 5 MB limit.";
  return null;
}

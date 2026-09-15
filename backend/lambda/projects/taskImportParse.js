const XLSX = require("xlsx");
const {
  TITLE_MAX,
  DESCRIPTION_MAX,
  TASK_CATEGORIES,
  parseInstantMs,
  normalizeEmail,
  normalizeCategory,
} = require("./escalation");
const TASK_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

const TASKS_SHEET_NAME = "Tasks";
const ROW_STATUS = Object.freeze({
  VALID: "VALID",
  INVALID: "INVALID",
});
const ASSIGNMENT_MODES = Object.freeze(["IMMEDIATE", "SCHEDULED"]);
const IMPORT_PRIORITIES = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const TASK_IMPORT_COLUMNS = Object.freeze([
  "Task Title",
  "Project",
  "Assignee Email",
  "Assignment Mode",
  "Task Type",
  "Priority",
  "Start Date",
  "Start Time",
  "Deadline Date",
  "Deadline Time",
  "Description",
]);
const COLUMN_KEYS = Object.freeze([
  "taskTitle",
  "project",
  "assigneeEmail",
  "assignmentMode",
  "taskType",
  "priority",
  "startDate",
  "startTime",
  "deadlineDate",
  "deadlineTime",
  "description",
]);
const TASK_IMPORT_COLUMN_MAP = Object.freeze(
  TASK_IMPORT_COLUMNS.map((header, index) => ({
    key: COLUMN_KEYS[index],
    letter: String.fromCharCode(65 + index),
    header,
  }))
);
const PROJECT_MISSING_MESSAGE =
  "Project does not exist. Create the project first or use an existing project name.";
const PROJECT_DUPLICATE_MESSAGE =
  "Project name matches more than one project. Use a unique existing project name.";
const SCHEDULED_MIN_LEAD_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^\d{2}:\d{2}$/;
const EXCEL_UNIX_EPOCH_SERIAL = 25569;
const DAY_MS = 24 * 60 * 60 * 1000;

function companyOffset() {
  return process.env.COMPANY_TZ_OFFSET || "+05:30";
}

function companyTimeZone() {
  return process.env.COMPANY_TIMEZONE || "Asia/Kolkata";
}

function toBuffer(input) {
  if (input == null) return null;
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return null;
}

function emptyRaw() {
  const raw = {};
  for (const key of COLUMN_KEYS) raw[key] = "";
  return raw;
}

function emptyValues() {
  return {
    taskTitle: "",
    project: "",
    assignees: [],
    assignmentMode: "",
    taskType: "",
    priority: "",
    startDate: "",
    startTime: "",
    deadlineDate: "",
    deadlineTime: "",
    description: "",
    startDateTime: null,
    deadlineDateTime: null,
    projectId: null,
  };
}

function workbookResult({
  errors = [],
  totalRows = 0,
  validRows = 0,
  invalidRows = 0,
  warningCount = 0,
  rows = [],
} = {}) {
  return {
    ok: errors.length === 0 && invalidRows === 0,
    errors,
    totalRows,
    validRows,
    invalidRows,
    warningCount,
    rows,
  };
}

function workbookError(message) {
  return workbookResult({
    errors: [{ field: "workbook", message }],
  });
}

function headerCell(value) {
  return String(value == null ? "" : value)
    .replace(/^\uFEFF/, "")
    .trim();
}

function cellRaw(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function isBlankRow(cells) {
  const width = Math.max(COLUMN_KEYS.length, Array.isArray(cells) ? cells.length : 0);
  for (let i = 0; i < width; i += 1) {
    if (String(cells?.[i] ?? "").trim() !== "") return false;
  }
  return true;
}

function extraHeaderNames(headerRow) {
  const extras = [];
  for (let i = TASK_IMPORT_COLUMNS.length; i < headerRow.length; i += 1) {
    const name = headerCell(headerRow[i]);
    if (name) extras.push(name);
  }
  return extras;
}

function headersMatch(headerRow) {
  if (!Array.isArray(headerRow) || headerRow.length < TASK_IMPORT_COLUMNS.length) {
    return false;
  }
  return TASK_IMPORT_COLUMNS.every((name, i) => headerCell(headerRow[i]) === name);
}

function excelSerialToUtcDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const ms = Math.round((n - EXCEL_UNIX_EPOCH_SERIAL) * DAY_MS);
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date : null;
}

function resolveMaxRows(options = {}) {
  const override = Number(options.maxRows);
  if (Number.isFinite(override) && override > 0) return override;
  const n = Number(process.env.TASK_IMPORT_MAX_ROWS);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("TASK_IMPORT_MAX_ROWS is not configured");
  }
  return n;
}

function resolveMaxBytes(options = {}) {
  const override = Number(options.maxBytes);
  if (Number.isFinite(override) && override > 0) return override;
  const n = Number(process.env.TASK_IMPORT_MAX_BYTES);
  if (Number.isFinite(n) && n > 0) return n;
  return TASK_IMPORT_MAX_BYTES;
}

function ymdFromExcelSerial(serial) {
  const date = excelSerialToUtcDate(serial);
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

function hmFromExcelSerial(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  let fraction = n % 1;
  if (fraction < 0) fraction += 1;
  const totalMinutes = Math.round(fraction * 24 * 60) % (24 * 60);
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const mm = String(totalMinutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function parseYmdCell(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ymd = ymdFromExcelSerial(value);
    if (ymd && isValidCalendarYmd(ymd)) return { value: ymd };
    return { error: "must be YYYY-MM-DD" };
  }
  const text = String(value == null ? "" : value).trim();
  if (!YMD_RE.test(text)) return { error: "must be YYYY-MM-DD" };
  if (!isValidCalendarYmd(text)) return { error: "must be a valid calendar date (YYYY-MM-DD)." };
  return { value: text };
}

function isValidCalendarYmd(ymd) {
  if (!YMD_RE.test(ymd)) return false;
  const ms = Date.parse(`${ymd}T00:00:00${companyOffset()}`);
  if (!Number.isFinite(ms)) return false;
  const back = new Date(ms).toLocaleDateString("en-CA", {
    timeZone: companyTimeZone(),
  });
  return back === ymd;
}

function parseHmCell(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const hm = hmFromExcelSerial(value);
    if (!hm) return { error: "must be HH:mm" };
    return validateHm(hm);
  }
  const text = String(value == null ? "" : value).trim();
  return validateHm(text);
}

function validateHm(text) {
  if (!HM_RE.test(text)) return { error: "must be HH:mm" };
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(3, 5));
  if (hour > 23 || minute > 59) return { error: "must be a valid 24-hour time (HH:mm)." };
  if (minute !== 0 && minute !== 15 && minute !== 30 && minute !== 45) {
    return {
      error: "must be in 15-minute intervals (00, 15, 30, or 45).",
    };
  }
  return { value: text };
}

function combineIstIso(ymd, hm) {
  return `${ymd}T${hm}:00${companyOffset()}`;
}

function addError(errors, field, message, value) {
  const item = { field, message };
  if (value !== undefined) item.value = value;
  errors.push(item);
}

function columnMeta(field) {
  return TASK_IMPORT_COLUMN_MAP.find((col) => col.key === field) || null;
}

function excelCellRef(field, rowNumber) {
  const meta = columnMeta(field);
  if (!meta || !Number.isFinite(Number(rowNumber))) return "";
  return `${meta.letter}${Number(rowNumber)}`;
}

function buildCellErrors(row) {
  return (row.errors || []).map((err) => {
    const meta = columnMeta(err.field);
    const rawValue =
      err.value !== undefined
        ? err.value
        : row.raw && err.field
          ? row.raw[err.field]
          : "";
    return {
      cell: excelCellRef(err.field, row.rowNumber),
      column: meta?.header || err.field || "",
      value: rawValue == null ? "" : String(rawValue),
      message: err.message,
    };
  });
}

function addWarning(warnings, field, message) {
  warnings.push({ field, message });
}

function projectCatalog(projects) {
  if (!Array.isArray(projects)) return null;
  return projects
    .map((item) => {
      if (item == null) return null;
      if (typeof item === "string") {
        const name = item.trim();
        return name ? { name } : null;
      }
      const name = String(item.name || "").trim();
      return name ? { name, id: item.id || item.projectId || null } : null;
    })
    .filter(Boolean);
}

function matchProject(rawProject, catalog) {
  const trimmed = String(rawProject || "").trim();
  if (!trimmed) {
    return { error: "Project is required." };
  }
  if (!catalog) {
    return { value: trimmed };
  }
  const needle = trimmed.toLowerCase();
  const matches = catalog.filter((item) => item.name.toLowerCase() === needle);
  if (!matches.length) {
    return { error: PROJECT_MISSING_MESSAGE };
  }
  const uniqueIds = new Set(
    matches.map((item) => item.id || item.projectId || "").filter(Boolean)
  );
  if (matches.length > 1 && uniqueIds.size !== 1) {
    return { error: PROJECT_DUPLICATE_MESSAGE };
  }
  const found = matches[0];
  return {
    value: found.name,
    projectId: found.id || found.projectId || null,
  };
}

function parseAssignees(rawValue) {
  const warnings = [];
  const errors = [];
  const text = String(rawValue == null ? "" : rawValue);
  const parts = text
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (!parts.length) {
    errors.push({ message: "Assignee Email is required." });
    return { assignees: [], errors, warnings };
  }
  const seen = new Set();
  const assignees = [];
  let duplicate = false;
  for (const part of parts) {
    const email = normalizeEmail(part);
    if (!EMAIL_RE.test(email)) {
      errors.push({ message: `Invalid assignee email: ${part}`, value: part });
      continue;
    }
    if (seen.has(email)) {
      duplicate = true;
      continue;
    }
    seen.add(email);
    assignees.push(email);
  }
  if (duplicate) {
    warnings.push("Duplicate assignee emails were removed.");
  }
  if (!assignees.length && !errors.length) {
    errors.push({ message: "Assignee Email is required." });
  }
  return { assignees, errors, warnings };
}

function parseAssignmentMode(rawValue) {
  const trimmed = String(rawValue == null ? "" : rawValue).trim();
  if (!trimmed) return { error: "Assignment Mode is required." };
  const canonical = trimmed.toUpperCase();
  if (!ASSIGNMENT_MODES.includes(canonical)) {
    return { error: "Assignment Mode must be IMMEDIATE or SCHEDULED." };
  }
  return { value: canonical };
}

function parseTaskType(rawValue) {
  const trimmed = String(rawValue == null ? "" : rawValue).trim();
  if (!trimmed) return { value: "" };
  const canonical = normalizeCategory(trimmed);
  if (!canonical || !TASK_CATEGORIES.includes(canonical)) {
    return { error: "Task Type is not a valid category." };
  }
  return { value: canonical };
}

function parsePriority(rawValue) {
  const trimmed = String(rawValue == null ? "" : rawValue).trim();
  if (!trimmed) return { error: "Priority is required." };
  const canonical = trimmed.toUpperCase();
  if (!IMPORT_PRIORITIES.includes(canonical)) {
    return { error: "Priority must be LOW, MEDIUM, HIGH, or CRITICAL." };
  }
  return { value: canonical };
}

function rawFromCells(cells) {
  const raw = emptyRaw();
  COLUMN_KEYS.forEach((key, i) => {
    raw[key] = cellRaw(cells?.[i]);
  });
  return raw;
}

function validateDataRow(cells, { nowMs, catalog } = {}) {
  const errors = [];
  const warnings = [];
  const raw = rawFromCells(cells);
  const values = emptyValues();

  const title = String(cells?.[0] ?? "").trim();
  values.taskTitle = title;
  if (!title) addError(errors, "taskTitle", "Task Title is required.");
  else if (title.length > TITLE_MAX) {
    addError(errors, "taskTitle", `Title must be ${TITLE_MAX} characters or fewer.`);
  }

  const projectResult = matchProject(cells?.[1], catalog);
  if (projectResult.error) addError(errors, "project", projectResult.error);
  else {
    values.project = projectResult.value;
    values.projectId = projectResult.projectId || null;
  }

  const assigneeResult = parseAssignees(cells?.[2]);
  values.assignees = assigneeResult.assignees;
  assigneeResult.errors.forEach((item) => {
    const message = typeof item === "string" ? item : item.message;
    const value = typeof item === "string" ? undefined : item.value;
    addError(errors, "assigneeEmail", message, value);
  });
  assigneeResult.warnings.forEach((message) => addWarning(warnings, "assigneeEmail", message));

  const modeResult = parseAssignmentMode(cells?.[3]);
  if (modeResult.error) addError(errors, "assignmentMode", modeResult.error);
  else values.assignmentMode = modeResult.value;

  const typeResult = parseTaskType(cells?.[4]);
  if (typeResult.error) addError(errors, "taskType", typeResult.error);
  else values.taskType = typeResult.value;

  const priorityResult = parsePriority(cells?.[5]);
  if (priorityResult.error) addError(errors, "priority", priorityResult.error);
  else values.priority = priorityResult.value;

  const startDateResult = parseYmdCell(cells?.[6]);
  if (!String(cellRaw(cells?.[6])).trim()) {
    addError(errors, "startDate", "Start Date is required.");
  } else if (startDateResult.error) {
    addError(errors, "startDate", `Start Date ${startDateResult.error}`);
  } else {
    values.startDate = startDateResult.value;
  }

  const startTimeResult = parseHmCell(cells?.[7]);
  if (!String(cellRaw(cells?.[7])).trim()) {
    addError(errors, "startTime", "Start Time is required.");
  } else if (startTimeResult.error) {
    addError(errors, "startTime", `Start Time ${startTimeResult.error}`);
  } else {
    values.startTime = startTimeResult.value;
  }

  const deadlineDateResult = parseYmdCell(cells?.[8]);
  if (!String(cellRaw(cells?.[8])).trim()) {
    addError(errors, "deadlineDate", "Deadline Date is required.");
  } else if (deadlineDateResult.error) {
    addError(errors, "deadlineDate", `Deadline Date ${deadlineDateResult.error}`);
  } else {
    values.deadlineDate = deadlineDateResult.value;
  }

  const deadlineTimeResult = parseHmCell(cells?.[9]);
  if (!String(cellRaw(cells?.[9])).trim()) {
    addError(errors, "deadlineTime", "Deadline Time is required.");
  } else if (deadlineTimeResult.error) {
    addError(errors, "deadlineTime", `Deadline Time ${deadlineTimeResult.error}`);
  } else {
    values.deadlineTime = deadlineTimeResult.value;
  }

  const description = cells?.[10] == null ? "" : String(cells[10]);
  values.description = description;
  if (description.length > DESCRIPTION_MAX) {
    addError(
      errors,
      "description",
      `Description must be ${DESCRIPTION_MAX} characters or fewer.`
    );
  }

  if (values.startDate && values.startTime) {
    const startIso = combineIstIso(values.startDate, values.startTime);
    const startMs = parseInstantMs(startIso);
    if (!Number.isFinite(startMs)) {
      addError(errors, "startDate", "Start date and time are required.");
    } else {
      values.startDateTime = startIso;
      if (values.assignmentMode === "SCHEDULED") {
        if (!(startMs > nowMs + SCHEDULED_MIN_LEAD_MS)) {
          addError(
            errors,
            "startDate",
            "SCHEDULED start must be more than 1 minute in the future."
          );
        }
      }
    }
  }

  if (values.deadlineDate && values.deadlineTime) {
    const deadlineIso = combineIstIso(values.deadlineDate, values.deadlineTime);
    const deadlineMs = parseInstantMs(deadlineIso);
    if (!Number.isFinite(deadlineMs)) {
      addError(errors, "deadlineDate", "Deadline date and time are required.");
    } else {
      values.deadlineDateTime = deadlineIso;
    }
  }

  if (values.startDateTime && values.deadlineDateTime) {
    const startMs = parseInstantMs(values.startDateTime);
    const deadlineMs = parseInstantMs(values.deadlineDateTime);
    if (Number.isFinite(startMs) && Number.isFinite(deadlineMs) && startMs >= deadlineMs) {
      addError(
        errors,
        "deadlineDate",
        "Deadline must be after the start date and time."
      );
    }
  }

  return {
    status: errors.length ? ROW_STATUS.INVALID : ROW_STATUS.VALID,
    raw,
    values,
    errors,
    warnings,
  };
}

function parseTaskImportWorkbook(input, options = {}) {
  const buffer = toBuffer(input);
  if (!buffer || buffer.length === 0) {
    return workbookError("Excel file is missing or empty.");
  }

  const maxBytes = resolveMaxBytes(options);
  if (buffer.length > maxBytes) {
    return workbookError("File size exceeds the allowed limit.");
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: true });
  } catch (err) {
    return workbookError("Unable to read the Excel workbook.");
  }

  const sheet = workbook.Sheets?.[TASKS_SHEET_NAME];
  if (!sheet) {
    return workbookError(`The workbook must contain a sheet named ${TASKS_SHEET_NAME}.`);
  }

  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: true,
  });
  if (!matrix.length) {
    return workbookError("The Tasks sheet is missing the required header row.");
  }

  const headerRow = matrix[0] || [];
  if (!headersMatch(headerRow)) {
    return workbookError(
      "The Tasks sheet columns must match the template names and order exactly."
    );
  }
  const extras = extraHeaderNames(headerRow);
  if (extras.length) {
    return workbookError("The Tasks sheet has unexpected extra columns.");
  }

  const catalog = projectCatalog(options.projects);
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : Date.now();
  const maxRows = resolveMaxRows(options);

  const rows = [];
  for (let i = 1; i < matrix.length; i += 1) {
    const cells = Array.isArray(matrix[i]) ? matrix[i] : [];
    if (isBlankRow(cells)) continue;
    const parsed = validateDataRow(cells, { nowMs, catalog });
    rows.push({
      rowNumber: i + 1,
      ...parsed,
    });
  }

  const errors = [];
  if (rows.length > maxRows) {
    errors.push({
      field: "workbook",
      message: `Maximum ${maxRows} data rows allowed.`,
    });
  }

  const validRows = rows.filter((row) => row.status === ROW_STATUS.VALID).length;
  const invalidRows = rows.length - validRows;
  const warningCount = rows.reduce((sum, row) => sum + row.warnings.length, 0);
  return workbookResult({
    errors,
    totalRows: rows.length,
    validRows,
    invalidRows,
    warningCount,
    rows,
  });
}

module.exports = {
  TASKS_SHEET_NAME,
  TASK_IMPORT_COLUMNS,
  TASK_IMPORT_COLUMN_MAP,
  ASSIGNMENT_MODES,
  IMPORT_PRIORITIES,
  ROW_STATUS,
  SCHEDULED_MIN_LEAD_MS,
  PROJECT_MISSING_MESSAGE,
  PROJECT_DUPLICATE_MESSAGE,
  parseTaskImportWorkbook,
  validateDataRow,
  combineIstIso,
  excelCellRef,
  buildCellErrors,
};

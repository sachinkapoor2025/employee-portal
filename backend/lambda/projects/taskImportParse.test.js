const assert = require("assert");
const XLSX = require("xlsx");
const { DESCRIPTION_MAX, TITLE_MAX } = require("./escalation");
const {
  TASK_IMPORT_COLUMNS,
  parseTaskImportWorkbook,
  combineIstIso,
} = require("./taskImportParse");

process.env.TASK_IMPORT_MAX_ROWS = "200";
process.env.TASK_IMPORT_MAX_BYTES = "5242880";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";

const NOW_MS = Date.parse("2026-09-15T09:00:00+05:30");
const PROJECTS = [{ name: "DGV Employee Portal" }, { name: "DGV Internal HR" }];

const VALID_ROW = [
  "Homepage banner update",
  "DGV Employee Portal",
  "rahul@mydgv.com",
  "IMMEDIATE",
  "Development",
  "HIGH",
  "2026-10-01",
  "09:30",
  "2026-10-03",
  "18:00",
  "Update the homepage banner.",
];

function workbookBuffer({
  rows = [TASK_IMPORT_COLUMNS, VALID_ROW],
  sheetName = "Tasks",
  extraSheets = [],
  mutateSheet,
} = {}) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (mutateSheet) mutateSheet(sheet);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  extraSheets.forEach(({ name, rows: extraRows }) => {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(extraRows || [["Note"]]),
      name
    );
  });
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function parseRows(dataRows, options = {}) {
  return parseTaskImportWorkbook(
    workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, ...dataRows] }),
    { nowMs: NOW_MS, projects: PROJECTS, ...options }
  );
}

function fieldErrors(row, field) {
  return (row.errors || [])
    .filter((item) => item.field === field)
    .map((item) => item.message);
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test("valid row is VALID with canonical IST values", () => {
  const result = parseRows([VALID_ROW]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.totalRows, 1);
  assert.strictEqual(result.validRows, 1);
  assert.strictEqual(result.invalidRows, 0);
  assert.strictEqual(result.warningCount, 0);
  const row = result.rows[0];
  assert.strictEqual(row.rowNumber, 2);
  assert.strictEqual(row.status, "VALID");
  assert.deepStrictEqual(row.errors, []);
  assert.deepStrictEqual(row.warnings, []);
  assert.strictEqual(row.raw.taskTitle, "Homepage banner update");
  assert.strictEqual(row.values.taskTitle, "Homepage banner update");
  assert.strictEqual(row.values.project, "DGV Employee Portal");
  assert.deepStrictEqual(row.values.assignees, ["rahul@mydgv.com"]);
  assert.strictEqual(row.values.assignmentMode, "IMMEDIATE");
  assert.strictEqual(row.values.taskType, "Development");
  assert.strictEqual(row.values.priority, "HIGH");
  assert.strictEqual(row.values.startDate, "2026-10-01");
  assert.strictEqual(row.values.startTime, "09:30");
  assert.strictEqual(row.values.deadlineDate, "2026-10-03");
  assert.strictEqual(row.values.deadlineTime, "18:00");
  assert.strictEqual(row.values.startDateTime, "2026-10-01T09:30:00+05:30");
  assert.strictEqual(row.values.deadlineDateTime, "2026-10-03T18:00:00+05:30");
});

test("missing required fields produce INVALID errors", () => {
  const result = parseRows([["", "", "", "", "", "", "", "", "", "", "Only a description"]]);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.invalidRows, 1);
  const row = result.rows[0];
  assert.strictEqual(row.status, "INVALID");
  assert.ok(fieldErrors(row, "taskTitle").some((m) => /required/i.test(m)));
  assert.ok(fieldErrors(row, "project").some((m) => /required/i.test(m)));
  assert.ok(fieldErrors(row, "assigneeEmail").some((m) => /required/i.test(m)));
  assert.ok(fieldErrors(row, "assignmentMode").some((m) => /required/i.test(m)));
  assert.ok(fieldErrors(row, "priority").some((m) => /required/i.test(m)));
  assert.ok(fieldErrors(row, "startDate").some((m) => /required/i.test(m)));
  assert.ok(fieldErrors(row, "startTime").some((m) => /required/i.test(m)));
  assert.ok(fieldErrors(row, "deadlineDate").some((m) => /required/i.test(m)));
  assert.ok(fieldErrors(row, "deadlineTime").some((m) => /required/i.test(m)));
  assert.ok(!row.errors.some((item) => item.field === "taskType"));
  assert.ok(!row.errors.some((item) => item.field === "description"));
});

test("invalid project value does not match the catalog", () => {
  const row = [...VALID_ROW];
  row[1] = "Unknown Project";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "project").some((m) => /does not exist/i.test(m)));
  assert.strictEqual(result.rows[0].values.project, "");
});

test("project matching is case-insensitive and uses the catalog name", () => {
  const row = [...VALID_ROW];
  row[1] = "  dgv employee portal  ";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "VALID");
  assert.strictEqual(result.rows[0].values.project, "DGV Employee Portal");
  assert.strictEqual(result.rows[0].values.projectId, null);
  assert.strictEqual(result.rows[0].raw.project, "  dgv employee portal  ");
});

test("multiple assignees are split, trimmed, and lowercased", () => {
  const row = [...VALID_ROW];
  row[2] = " Priya@mydgv.com ; anita@mydgv.com ";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "VALID");
  assert.deepStrictEqual(result.rows[0].values.assignees, [
    "priya@mydgv.com",
    "anita@mydgv.com",
  ]);
});

test("duplicate assignee emails collapse with a warning", () => {
  const row = [...VALID_ROW];
  row[2] = "rahul@mydgv.com; Rahul@mydgv.com ;RAHUL@mydgv.com";
  const result = parseRows([row]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.rows[0].status, "VALID");
  assert.strictEqual(result.warningCount, 1);
  assert.deepStrictEqual(result.rows[0].values.assignees, ["rahul@mydgv.com"]);
  assert.ok(
    result.rows[0].warnings.some(
      (item) => item.field === "assigneeEmail" && /duplicate/i.test(item.message)
    )
  );
});

test("invalid assignment mode is reported and not rewritten", () => {
  const row = [...VALID_ROW];
  row[3] = "ASAP";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(
    fieldErrors(result.rows[0], "assignmentMode").some((m) => /IMMEDIATE|SCHEDULED/i.test(m))
  );
  assert.strictEqual(result.rows[0].values.assignmentMode, "");
  assert.strictEqual(result.rows[0].raw.assignmentMode, "ASAP");
});

test("invalid task type is reported and not rewritten", () => {
  const row = [...VALID_ROW];
  row[4] = "Engineering";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "taskType").length > 0);
  assert.strictEqual(result.rows[0].values.taskType, "");
  assert.strictEqual(result.rows[0].raw.taskType, "Engineering");
});

test("invalid priority including URGENT is not silently mapped", () => {
  const row = [...VALID_ROW];
  row[5] = "URGENT";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "priority").some((m) => /LOW|MEDIUM|HIGH|CRITICAL/i.test(m)));
  assert.strictEqual(result.rows[0].values.priority, "");
  assert.strictEqual(result.rows[0].raw.priority, "URGENT");
});

test("invalid date format is reported", () => {
  const row = [...VALID_ROW];
  row[6] = "01/10/2026";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "startDate").some((m) => /YYYY-MM-DD/i.test(m)));
  assert.strictEqual(result.rows[0].values.startDate, "");
});

test("invalid calendar date is reported", () => {
  const row = [...VALID_ROW];
  row[8] = "2026-02-30";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "deadlineDate").length > 0);
  assert.strictEqual(result.rows[0].values.deadlineDate, "");
});

test("invalid time format is reported", () => {
  const row = [...VALID_ROW];
  row[7] = "9:30";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "startTime").some((m) => /HH:mm/i.test(m)));
  assert.strictEqual(result.rows[0].values.startTime, "");
});

test("non-15-minute time is reported and not rounded", () => {
  const row = [...VALID_ROW];
  row[7] = "09:31";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "startTime").some((m) => /15-minute/i.test(m)));
  assert.strictEqual(result.rows[0].values.startTime, "");
  assert.strictEqual(result.rows[0].raw.startTime, "09:31");
});

test("deadline before start is invalid", () => {
  const row = [...VALID_ROW];
  row[6] = "2026-10-03";
  row[7] = "18:00";
  row[8] = "2026-10-01";
  row[9] = "09:30";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "deadlineDate").some((m) => /after the start/i.test(m)));
});

test("equal start and deadline is invalid", () => {
  const row = [...VALID_ROW];
  row[8] = row[6];
  row[9] = row[7];
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "deadlineDate").length > 0);
});

test("description longer than 5000 is invalid and not truncated", () => {
  const row = [...VALID_ROW];
  row[10] = "x".repeat(DESCRIPTION_MAX + 1);
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "description").some((m) => new RegExp(String(DESCRIPTION_MAX)).test(m)));
  assert.strictEqual(result.rows[0].values.description.length, DESCRIPTION_MAX + 1);
  assert.strictEqual(result.rows[0].raw.description.length, DESCRIPTION_MAX + 1);
});

test("more than 200 data rows is a workbook error", () => {
  const rows = Array.from({ length: 201 }, (_, i) => {
    const row = [...VALID_ROW];
    row[0] = `Task ${i + 1}`;
    return row;
  });
  const result = parseRows(rows);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.totalRows, 201);
  assert.ok(result.errors.some((item) => /200 data rows/i.test(item.message)));
});

test("completely blank rows are ignored and Excel row numbers stay real", () => {
  const result = parseRows([VALID_ROW, ["", "", "", "", "", "", "", "", "", "", ""], VALID_ROW]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.totalRows, 2);
  assert.strictEqual(result.validRows, 2);
  assert.deepStrictEqual(
    result.rows.map((row) => row.rowNumber),
    [2, 4]
  );
});

test("whitespace-only rows are treated as blank", () => {
  const result = parseRows([VALID_ROW, ["  ", "\t", "", "", "", "", "", "", "", "", "  "]]);
  assert.strictEqual(result.totalRows, 1);
  assert.strictEqual(result.rows[0].rowNumber, 2);
});

test("SCHEDULED start in the past is invalid", () => {
  const row = [...VALID_ROW];
  row[3] = "SCHEDULED";
  row[6] = "2026-09-01";
  row[7] = "09:30";
  row[8] = "2026-09-02";
  row[9] = "18:00";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.ok(fieldErrors(result.rows[0], "startDate").some((m) => /1 minute/i.test(m)));
});

test("SCHEDULED start must be more than 1 minute in the future", () => {
  const tooSoon = [...VALID_ROW];
  tooSoon[3] = "SCHEDULED";
  tooSoon[6] = "2026-09-15";
  tooSoon[7] = "09:00";
  tooSoon[8] = "2026-09-16";
  tooSoon[9] = "18:00";
  const soonResult = parseRows([tooSoon]);
  assert.strictEqual(soonResult.rows[0].status, "INVALID");

  const okRow = [...tooSoon];
  okRow[7] = "09:15";
  const okResult = parseRows([okRow]);
  assert.strictEqual(okResult.rows[0].status, "VALID");
  assert.strictEqual(okResult.rows[0].values.startDateTime, "2026-09-15T09:15:00+05:30");
});

test("IMMEDIATE start may be in the past when the deadline is after start", () => {
  const row = [...VALID_ROW];
  row[3] = "IMMEDIATE";
  row[6] = "2026-09-01";
  row[7] = "09:30";
  row[8] = "2026-09-02";
  row[9] = "18:00";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "VALID");
});

test("date and time are interpreted as IST (+05:30), not local timezone", () => {
  const result = parseRows([VALID_ROW]);
  const startIso = result.rows[0].values.startDateTime;
  assert.strictEqual(startIso, combineIstIso("2026-10-01", "09:30"));
  assert.strictEqual(Date.parse(startIso), Date.parse("2026-10-01T04:00:00.000Z"));
  assert.strictEqual(
    Date.parse(result.rows[0].values.deadlineDateTime),
    Date.parse("2026-10-03T12:30:00.000Z")
  );
});

test("Excel serial date/time cells are read as IST civil values", () => {
  const startSerial = 25569 + Date.UTC(2026, 9, 1) / 86400000;
  const deadlineSerial = 25569 + Date.UTC(2026, 9, 3) / 86400000;
  const startTimeSerial = 9.5 / 24;
  const deadlineTimeSerial = 18 / 24;
  const buffer = workbookBuffer({
    rows: [TASK_IMPORT_COLUMNS, [...VALID_ROW]],
    mutateSheet(sheet) {
      sheet.G2 = { t: "n", v: startSerial };
      sheet.H2 = { t: "n", v: startTimeSerial };
      sheet.I2 = { t: "n", v: deadlineSerial };
      sheet.J2 = { t: "n", v: deadlineTimeSerial };
    },
  });
  const result = parseTaskImportWorkbook(buffer, {
    nowMs: NOW_MS,
    projects: PROJECTS,
  });
  assert.strictEqual(result.rows[0].status, "VALID");
  assert.strictEqual(result.rows[0].values.startDate, "2026-10-01");
  assert.strictEqual(result.rows[0].values.startTime, "09:30");
  assert.strictEqual(result.rows[0].values.deadlineDate, "2026-10-03");
  assert.strictEqual(result.rows[0].values.deadlineTime, "18:00");
  assert.strictEqual(
    Date.parse(result.rows[0].values.startDateTime),
    Date.parse("2026-10-01T04:00:00.000Z")
  );
});

test("title longer than 200 is invalid and not truncated", () => {
  const row = [...VALID_ROW];
  row[0] = "T".repeat(TITLE_MAX + 1);
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "INVALID");
  assert.strictEqual(result.rows[0].values.taskTitle.length, TITLE_MAX + 1);
});

test("missing Tasks sheet is a workbook error", () => {
  const result = parseTaskImportWorkbook(
    workbookBuffer({
      rows: [["Note"], ["hello"]],
      sheetName: "Instructions",
    }),
    { nowMs: NOW_MS }
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.totalRows, 0);
  assert.ok(result.errors.some((item) => /Tasks/i.test(item.message)));
});

test("wrong column order is a workbook error", () => {
  const headers = [...TASK_IMPORT_COLUMNS];
  const tmp = headers[0];
  headers[0] = headers[1];
  headers[1] = tmp;
  const result = parseTaskImportWorkbook(
    workbookBuffer({ rows: [headers, VALID_ROW] }),
    { nowMs: NOW_MS }
  );
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((item) => /columns/i.test(item.message)));
  assert.strictEqual(result.rows.length, 0);
});

test("oversize buffer is rejected", () => {
  const buffer = workbookBuffer({ rows: [TASK_IMPORT_COLUMNS, VALID_ROW] });
  const result = parseTaskImportWorkbook(buffer, { nowMs: NOW_MS, maxBytes: 10 });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((item) => /file size/i.test(item.message)));
});

test("optional task type may be blank", () => {
  const row = [...VALID_ROW];
  row[4] = "";
  const result = parseRows([row]);
  assert.strictEqual(result.rows[0].status, "VALID");
  assert.strictEqual(result.rows[0].values.taskType, "");
});

console.log(`taskImportParse.test.js: ${passed} tests passed`);

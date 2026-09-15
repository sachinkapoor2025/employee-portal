import * as XLSX from "xlsx";
import {
  TASK_IMPORT_COLUMNS,
  TASK_IMPORT_INSTRUCTION_ROWS,
  TASK_IMPORT_SAMPLE_ROWS,
  buildTaskImportWorkbook,
  taskImportTemplateBytes,
} from "./taskImportTemplate";

function sheetMatrix(workbook, name) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[name], {
    header: 1,
    raw: false,
    defval: "",
  });
}

test("workbook has Tasks then Instructions sheets", () => {
  const workbook = buildTaskImportWorkbook();
  expect(workbook.SheetNames).toEqual(["Tasks", "Instructions"]);
});

test("Tasks sheet has the required columns in order", () => {
  const rows = sheetMatrix(buildTaskImportWorkbook(), "Tasks");
  expect(rows[0]).toEqual(TASK_IMPORT_COLUMNS);
});

test("Tasks sheet includes 3 example rows with required formats", () => {
  const rows = sheetMatrix(buildTaskImportWorkbook(), "Tasks");
  expect(rows.slice(1)).toEqual(TASK_IMPORT_SAMPLE_ROWS);
  expect(rows.length - 1).toBe(3);
  rows.slice(1).forEach((row) => {
    expect(String(row[0])).toMatch(/^EXAMPLE/);
    expect(["IMMEDIATE", "SCHEDULED"]).toContain(row[3]);
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(row[5]);
    expect(row[6]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row[7]).toMatch(/^\d{2}:(00|15|30|45)$/);
    expect(row[8]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row[9]).toMatch(/^\d{2}:(00|15|30|45)$/);
    expect(`${row[6]}T${row[7]}` < `${row[8]}T${row[9]}`).toBe(true);
  });
  expect(rows[2][2]).toMatch(/;/);
});

test("Instructions sheet covers admin rules", () => {
  const text = sheetMatrix(buildTaskImportWorkbook(), "Instructions")
    .map((row) => row.join(" "))
    .join("\n");
  expect(TASK_IMPORT_INSTRUCTION_ROWS[0]).toEqual(["Topic", "Instruction"]);
  expect(text).toMatch(/Required/);
  expect(text).toMatch(/optional/i);
  expect(text).toMatch(/IMMEDIATE/);
  expect(text).toMatch(/SCHEDULED/);
  expect(text).toMatch(/YYYY-MM-DD/);
  expect(text).toMatch(/HH:mm/);
  expect(text).toMatch(/semicolon/);
  expect(text).toMatch(/200/);
  expect(text).toMatch(/5 MB/);
  expect(text).toMatch(/Do not change the column names/);
  expect(text).toMatch(/\+05:30/);
});

test("generated file is a real xlsx zip", () => {
  const bytes = taskImportTemplateBytes();
  expect(bytes.length).toBeGreaterThan(1000);
  expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");
  const parsed = XLSX.read(bytes, { type: "array" });
  expect(parsed.SheetNames).toEqual(["Tasks", "Instructions"]);
});

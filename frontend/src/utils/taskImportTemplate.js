import * as XLSX from "xlsx";

export const TASK_IMPORT_TEMPLATE_FILENAME = "DGV-Task-Import-Template.xlsx";

export const TASK_IMPORT_COLUMNS = [
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
];

export const TASK_IMPORT_SAMPLE_ROWS = [
  [
    "EXAMPLE — Homepage banner update",
    "DGV Employee Portal",
    "rahul@mydgv.com",
    "IMMEDIATE",
    "Development",
    "HIGH",
    "2026-10-01",
    "09:30",
    "2026-10-03",
    "18:00",
    "Example row only. Delete these sample rows before importing live tasks.",
  ],
  [
    "EXAMPLE — Q4 leave calendar design",
    "DGV Internal HR",
    "priya@mydgv.com; anita@mydgv.com",
    "SCHEDULED",
    "Design",
    "MEDIUM",
    "2026-10-15",
    "10:00",
    "2026-10-20",
    "17:15",
    "Example row only. Scheduled tasks are assigned at Start Date/Time (IST).",
  ],
  [
    "EXAMPLE — Client onboarding kit",
    "DGV Sales Enablement",
    "amit@mydgv.com",
    "IMMEDIATE",
    "Sales",
    "CRITICAL",
    "2026-09-20",
    "11:45",
    "2026-09-22",
    "16:30",
    "Example row only. Use this row as a format reference, not a real assignment.",
  ],
];

export const TASK_IMPORT_INSTRUCTION_ROWS = [
  ["Topic", "Instruction"],
  [
    "Workbook layout",
    "Use the Tasks sheet for data. Do not rename sheets. Do not change the column names in row 1.",
  ],
  [
    "Task Title",
    "Required. Short name of the task.",
  ],
  [
    "Project",
    "Required. Existing project name exactly as it appears in the portal.",
  ],
  [
    "Assignee Email",
    "Required. One or more @mydgv.com emails. Separate multiple assignees with a semicolon (;). Example: rahul@mydgv.com; priya@mydgv.com",
  ],
  [
    "Assignment Mode",
    "Required. IMMEDIATE assigns as soon as the import is confirmed. SCHEDULED creates the task now but assigns it at the Start Date/Time (IST, +05:30).",
  ],
  [
    "Task Type",
    "Optional. Allowed values: Development, Design, HR, Sales, Marketing, Support, Meeting, Administrative, Other.",
  ],
  [
    "Priority",
    "Required. Allowed values: LOW, MEDIUM, HIGH, CRITICAL.",
  ],
  [
    "Start Date / Deadline Date",
    "Required. Format YYYY-MM-DD. Values are interpreted in IST (+05:30). Do not put timezone text in the cells.",
  ],
  [
    "Start Time / Deadline Time",
    "Required. Format HH:mm using 24-hour time in 15-minute increments (00, 15, 30, 45). Example: 09:30 or 17:15. Do not put timezone text in the cells.",
  ],
  [
    "Start vs deadline",
    "Start Date/Time must be before Deadline Date/Time.",
  ],
  [
    "Description",
    "Optional. Extra task details.",
  ],
  [
    "Sample rows",
    "The Tasks sheet includes EXAMPLE rows so you can see the format. Delete those rows before importing live work.",
  ],
  [
    "Limits",
    "Maximum 200 data rows per file (not including the header). Maximum file size 5 MB. File type must be .xlsx.",
  ],
];

export function buildTaskImportWorkbook() {
  const workbook = XLSX.utils.book_new();
  const tasksSheet = XLSX.utils.aoa_to_sheet([
    TASK_IMPORT_COLUMNS,
    ...TASK_IMPORT_SAMPLE_ROWS,
  ]);
  tasksSheet["!cols"] = TASK_IMPORT_COLUMNS.map((name) => ({
    wch: Math.max(16, name.length + 4),
  }));
  const instructionsSheet = XLSX.utils.aoa_to_sheet(TASK_IMPORT_INSTRUCTION_ROWS);
  instructionsSheet["!cols"] = [{ wch: 28 }, { wch: 88 }];
  XLSX.utils.book_append_sheet(workbook, tasksSheet, "Tasks");
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, "Instructions");
  return workbook;
}

export function taskImportTemplateBytes() {
  const output = XLSX.write(buildTaskImportWorkbook(), {
    bookType: "xlsx",
    type: "array",
  });
  return output instanceof Uint8Array ? output : new Uint8Array(output);
}

export function downloadTaskImportTemplate() {
  const bytes = taskImportTemplateBytes();
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = TASK_IMPORT_TEMPLATE_FILENAME;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

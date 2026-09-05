const assert = require("assert");
const { zoneNotifyCopy, formatWhen } = require("./zoneNotify");

const orange = zoneNotifyCopy({
  orange: true,
  title: "Prepare Monthly Report",
  deadline: "2026-08-25T11:30:00.000Z",
  zoneStartedAt: "2026-08-25T11:30:00.000Z",
  timeZone: "Asia/Kolkata",
});
assert.strictEqual(orange.type, "TASK_ORANGE");
assert.strictEqual(orange.category, "TASK_MOVED_TO_ORANGE");
assert.ok(orange.title.includes("Orange Zone"));
assert.ok(orange.message.includes("Prepare Monthly Report"));
assert.ok(orange.message.includes("Orange Zone started"));
assert.ok(!orange.message.toLowerCase().includes("red zone"));

const red = zoneNotifyCopy({
  orange: false,
  title: "Prepare Monthly Report",
  deadline: "2026-08-25T11:30:00.000Z",
  zoneStartedAt: "2026-08-26T11:30:00.000Z",
  timeZone: "Asia/Kolkata",
});
assert.strictEqual(red.type, "TASK_RED");
assert.strictEqual(red.category, "TASK_MOVED_TO_RED");
assert.ok(red.title.includes("Red Zone"));
assert.ok(red.message.includes("24-hour"));
assert.ok(red.message.includes("Red Zone started"));

assert.ok(formatWhen("2026-08-25T11:30:00.000Z", "Asia/Kolkata").includes("2026"));

const { redAdminNotifyCopy } = require("./zoneNotify");
const adminCopy = redAdminNotifyCopy({
  employeeName: "Priya Yadav",
  employeeEmail: "priya.yadav@mydgv.com",
  title: "Website Homepage Update",
  projectName: "Client Website",
  status: "IN_PROGRESS",
  deadline: "2026-08-31T10:30:00.000Z",
  redZoneStartedAt: "2026-09-01T10:30:00.000Z",
  overdueLabel: "1 day",
  priority: "High",
  description: "Update homepage banner and CTA.",
  viewTaskUrl: "https://login.mydgv.com/admin/tasks/task-1",
  timeZone: "Asia/Kolkata",
});
assert.strictEqual(adminCopy.type, "TASK_RED_ADMIN");
assert.strictEqual(
  adminCopy.subject,
  "🔴 Task Entered Red Zone – Action Required: Website Homepage Update"
);
assert.ok(adminCopy.message.includes("Website Homepage Update"));
assert.ok(adminCopy.message.includes("Priya Yadav"));
assert.ok(adminCopy.message.includes("priya.yadav@mydgv.com"));
assert.ok(adminCopy.message.includes("Client Website"));
assert.ok(adminCopy.message.includes("IN_PROGRESS"));
assert.ok(adminCopy.message.includes("Original Deadline:"));
assert.ok(adminCopy.message.includes("Red Zone Started:"));
assert.ok(adminCopy.message.includes("31 August 2026"));
assert.ok(adminCopy.message.includes("1 September 2026"));
assert.ok(adminCopy.message.includes("High"));
assert.ok(adminCopy.message.includes("Update homepage banner and CTA."));
assert.ok(adminCopy.message.includes("https://login.mydgv.com/admin/tasks/task-1"));
assert.ok(adminCopy.html.includes("VIEW TASK"));
assert.ok(adminCopy.html.includes("Website Homepage Update"));
assert.ok(!adminCopy.message.toLowerCase().includes("your task"));

const deadlineMs = Date.parse("2026-08-31T10:30:00.000Z");
const redFromCopy = Date.parse("2026-09-01T10:30:00.000Z");
assert.strictEqual(redFromCopy - deadlineMs, 24 * 60 * 60 * 1000);

const omitted = redAdminNotifyCopy({
  employeeName: "Amit Sharma",
  employeeEmail: "amit@mydgv.com",
  title: "Client Website Development",
  status: "IN_PROGRESS",
  deadline: "2026-08-31T10:30:00.000Z",
  redZoneStartedAt: "2026-09-01T10:30:00.000Z",
  timeZone: "Asia/Kolkata",
});
assert.ok(!omitted.message.includes("Project:"));
assert.ok(!omitted.message.includes("Priority:"));
assert.ok(!omitted.message.includes("Description:"));
assert.ok(!omitted.html.includes("VIEW TASK"));
assert.ok(omitted.message.includes("Assigned To:\nAmit Sharma"));

console.log("zone notify tests passed");

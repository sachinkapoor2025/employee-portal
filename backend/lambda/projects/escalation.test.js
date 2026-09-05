const assert = require("assert");
const {
  ORANGE_MS,
  ZONES,
  parseDeadlineMs,
  zoneAt,
  computeAssignmentView,
  completeAssignment,
  detectTransitions,
  synthesizeAssignments,
  deriveParentStatus,
  decorateTask,
  taskAssignedTo,
  resetEscalationForNewDeadline,
  normalizeEmailList,
  normalizePriority,
  creatorDisplayName,
  displayNameFromEmail,
} = require("./escalation");

const DEADLINE = "2026-08-25T11:30:00.000Z"; // 17:00 IST
const DEADLINE_MS = Date.parse(DEADLINE);

assert.strictEqual(parseDeadlineMs(DEADLINE), DEADLINE_MS);
assert.ok(parseDeadlineMs("2026-08-25") > Date.parse("2026-08-25T18:29:00.000Z"));

assert.strictEqual(zoneAt(DEADLINE_MS, DEADLINE_MS - 1), ZONES.GREEN);
assert.strictEqual(zoneAt(DEADLINE_MS, DEADLINE_MS), ZONES.ORANGE);
assert.strictEqual(zoneAt(DEADLINE_MS, DEADLINE_MS + ORANGE_MS - 1), ZONES.ORANGE);
assert.strictEqual(zoneAt(DEADLINE_MS, DEADLINE_MS + ORANGE_MS), ZONES.RED);

// Test 1 — completed before deadline stays Green, never Orange/Red
const t1Now = Date.parse("2026-08-25T11:00:00.000Z"); // 16:30 IST
const t1Done = completeAssignment(
  { email: "rahul@mydgv.com", status: "IN_PROGRESS" },
  DEADLINE,
  t1Now,
  new Date(t1Now).toISOString()
);
assert.strictEqual(t1Done.status, "DONE");
assert.strictEqual(t1Done.completedZone, ZONES.GREEN);
const t1Later = computeAssignmentView(
  t1Done,
  DEADLINE,
  DEADLINE_MS + ORANGE_MS + 60 * 1000
);
assert.strictEqual(t1Later.zone, ZONES.GREEN);
assert.strictEqual(t1Later.completed, true);
assert.strictEqual(t1Later.reachedRed, false);

// Test 2 — becomes Orange at 6:00 PM same day
const t2 = computeAssignmentView(
  { email: "amit@mydgv.com", status: "TODO" },
  DEADLINE,
  Date.parse("2026-08-25T12:30:00.000Z") // 18:00 IST
);
assert.strictEqual(t2.zone, ZONES.ORANGE);
assert.strictEqual(t2.completed, false);

// Detection at 5:10 PM still Orange since 5:00 PM (not detection+24h)
const lateDetect = detectTransitions(
  { email: "amit@mydgv.com", status: "TODO", recordedZone: "GREEN" },
  DEADLINE,
  Date.parse("2026-08-25T11:40:00.000Z")
);
assert.strictEqual(lateDetect.assignment.recordedZone, ZONES.ORANGE);
assert.strictEqual(lateDetect.events[0].action, "zone_orange");
assert.strictEqual(lateDetect.events[0].timestamp, DEADLINE);

// Test 3 — completed during Orange never becomes Red
const t3Now = Date.parse("2026-08-26T09:30:00.000Z"); // next day 15:00 IST
const t3Done = completeAssignment(
  { email: "priya@mydgv.com", status: "TODO", recordedZone: "ORANGE" },
  DEADLINE,
  t3Now,
  new Date(t3Now).toISOString()
);
assert.strictEqual(t3Done.completedZone, ZONES.ORANGE);
const t3AfterRedWindow = computeAssignmentView(
  t3Done,
  DEADLINE,
  DEADLINE_MS + ORANGE_MS + 60 * 1000
);
assert.strictEqual(t3AfterRedWindow.zone, ZONES.ORANGE);
assert.strictEqual(t3AfterRedWindow.reachedRed, false);

// Test 4 — becomes Red the next day at 5:01 PM
const t4 = computeAssignmentView(
  { email: "dev@mydgv.com", status: "TODO" },
  DEADLINE,
  Date.parse("2026-08-26T11:31:00.000Z")
);
assert.strictEqual(t4.zone, ZONES.RED);

const skippedOrange = detectTransitions(
  { email: "dev@mydgv.com", status: "TODO", recordedZone: "GREEN" },
  DEADLINE,
  Date.parse("2026-08-26T11:31:00.000Z")
);
assert.strictEqual(skippedOrange.events.length, 2);
assert.strictEqual(skippedOrange.events[0].action, "zone_orange");
assert.strictEqual(skippedOrange.events[0].timestamp, DEADLINE);
assert.strictEqual(skippedOrange.events[1].action, "zone_red");
assert.strictEqual(
  skippedOrange.events[1].timestamp,
  new Date(DEADLINE_MS + ORANGE_MS).toISOString()
);

// Test 5 — completed after Red retains Red history
const t5Now = Date.parse("2026-08-26T12:00:00.000Z");
const t5Done = completeAssignment(
  {
    email: "dev@mydgv.com",
    status: "TODO",
    recordedZone: "RED",
    highestZone: "RED",
  },
  DEADLINE,
  t5Now,
  new Date(t5Now).toISOString()
);
assert.strictEqual(t5Done.status, "DONE");
assert.strictEqual(t5Done.completedZone, ZONES.RED);
assert.strictEqual(t5Done.highestZone, ZONES.RED);
const t5View = computeAssignmentView(t5Done, DEADLINE, t5Now + 86400000);
assert.strictEqual(t5View.zone, ZONES.RED);
assert.strictEqual(t5View.reachedRed, true);
assert.strictEqual(t5View.completed, true);

// Completing again must not reopen or change zone
const t5Again = completeAssignment(t5Done, DEADLINE, t5Now + 1000, new Date(t5Now + 1000).toISOString());
assert.strictEqual(t5Again.completedAt, t5Done.completedAt);
assert.strictEqual(t5Again.completedZone, ZONES.RED);

// Test 6 — multiple employees independent
const task = {
  taskId: "t1",
  title: "Prepare Monthly Report",
  dueDate: DEADLINE,
  assignee: "rahul@mydgv.com",
  assignees: [
    "rahul@mydgv.com",
    "amit@mydgv.com",
    "priya@mydgv.com",
    "dev@mydgv.com",
  ],
  assignments: [
    completeAssignment(
      { email: "rahul@mydgv.com", status: "TODO" },
      DEADLINE,
      t1Now,
      new Date(t1Now).toISOString()
    ),
    { email: "amit@mydgv.com", status: "TODO" },
    completeAssignment(
      { email: "priya@mydgv.com", status: "TODO" },
      DEADLINE,
      t3Now,
      new Date(t3Now).toISOString()
    ),
    { email: "dev@mydgv.com", status: "TODO" },
  ],
};

const nowAll = Date.parse("2026-08-26T11:31:00.000Z");
const decorated = decorateTask(task, nowAll, "amit@mydgv.com");
const byEmail = Object.fromEntries(decorated.assignments.map((a) => [a.email, a]));
assert.strictEqual(byEmail["rahul@mydgv.com"].status, "DONE");
assert.strictEqual(byEmail["rahul@mydgv.com"].zone, ZONES.GREEN);
assert.strictEqual(byEmail["amit@mydgv.com"].status, "TODO");
assert.strictEqual(byEmail["amit@mydgv.com"].zone, ZONES.RED);
assert.strictEqual(byEmail["priya@mydgv.com"].status, "DONE");
assert.strictEqual(byEmail["priya@mydgv.com"].zone, ZONES.ORANGE);
assert.strictEqual(byEmail["dev@mydgv.com"].zone, ZONES.RED);
assert.strictEqual(deriveParentStatus(task.assignments), "TODO");
assert.strictEqual(decorated.myAssignment.email, "amit@mydgv.com");

// Legacy single-assignee task still works
const legacy = synthesizeAssignments({
  assignee: "old@mydgv.com",
  status: "IN_PROGRESS",
  dueDate: DEADLINE,
});
assert.strictEqual(legacy.length, 1);
assert.strictEqual(legacy[0].email, "old@mydgv.com");
assert.strictEqual(legacy[0].status, "IN_PROGRESS");
assert.ok(taskAssignedTo({ assignee: "old@mydgv.com" }, "old@mydgv.com"));
assert.ok(
  taskAssignedTo(
    { assignees: ["a@mydgv.com", "b@mydgv.com"] },
    "b@mydgv.com"
  )
);

// Deadline change resets live escalation for incomplete work
const reset = resetEscalationForNewDeadline(
  { email: "amit@mydgv.com", status: "TODO", recordedZone: "RED", highestZone: "RED" },
  "2026-08-30T11:30:00.000Z",
  Date.parse("2026-08-26T12:00:00.000Z")
);
assert.strictEqual(reset.recordedZone, ZONES.GREEN);
assert.strictEqual(reset.highestZone, ZONES.GREEN);

assert.deepStrictEqual(
  normalizeEmailList(["A@mydgv.com", "a@mydgv.com", "b@mydgv.com"], ""),
  ["a@mydgv.com", "b@mydgv.com"]
);
assert.strictEqual(normalizePriority("critical"), "CRITICAL");
assert.strictEqual(normalizePriority("URGENT"), "URGENT");

const {
  applyZoneFilter,
  zoneCounts,
  assignmentMatchesZone,
  matchesSearch,
  matchesPriorityFilter,
} = require("./escalation");

const mixed = decorateTask(task, nowAll);
const filteredRed = applyZoneFilter([mixed], "RED");
assert.strictEqual(filteredRed.length, 1);
assert.deepStrictEqual(
  filteredRed[0].matchedAssignments.map((a) => a.email).sort(),
  ["amit@mydgv.com", "dev@mydgv.com"]
);

const filteredCompleted = applyZoneFilter([mixed], "COMPLETED");
assert.deepStrictEqual(
  filteredCompleted[0].matchedAssignments.map((a) => a.email).sort(),
  ["priya@mydgv.com", "rahul@mydgv.com"]
);
assert.ok(!filteredCompleted[0].matchedAssignments.some((a) => a.email === "dev@mydgv.com"));

const orangeNow = Date.parse("2026-08-25T12:30:00.000Z");
const orangeTask = decorateTask(
  {
    title: "Monthly Report",
    dueDate: DEADLINE,
    assignments: [
      { email: "amit@mydgv.com", status: "TODO" },
      completeAssignment(
        { email: "rahul@mydgv.com", status: "TODO" },
        DEADLINE,
        t1Now,
        new Date(t1Now).toISOString()
      ),
    ],
  },
  orangeNow
);
const filteredOrange = applyZoneFilter([orangeTask], "ORANGE");
assert.strictEqual(filteredOrange[0].matchedAssignments.map((a) => a.email).join(), "amit@mydgv.com");

const amitOnly = applyZoneFilter([decorateTask(task, nowAll, "amit@mydgv.com")], "RED", "amit@mydgv.com");
assert.strictEqual(amitOnly.length, 1);
const rahulRed = applyZoneFilter([decorateTask(task, nowAll, "rahul@mydgv.com")], "RED", "rahul@mydgv.com");
assert.strictEqual(rahulRed.length, 0);

const counts = zoneCounts([mixed]);
assert.strictEqual(counts.COMPLETED, 2);
assert.strictEqual(counts.RED, 2);
assert.strictEqual(counts.ORANGE, 0);
assert.strictEqual(counts.ALL, 4);

assert.ok(matchesSearch(task, "Monthly"));
assert.ok(!matchesSearch(task, "Weekly"));
assert.ok(matchesPriorityFilter({ priority: "HIGH" }, "HIGH"));
assert.ok(matchesPriorityFilter({ priority: "URGENT" }, "CRITICAL"));
assert.ok(assignmentMatchesZone({ status: "TODO", zone: "GREEN" }, "GREEN"));
assert.ok(!assignmentMatchesZone({ status: "DONE", zone: "GREEN" }, "GREEN"));
assert.ok(assignmentMatchesZone({ status: "DONE", zone: "GREEN" }, "COMPLETED"));

const { validateCreatePayload } = require("./escalation");
const validCreate = validateCreatePayload({
  title: "  Prepare Monthly Report  ",
  assignees: ["rahul@mydgv.com", "amit@mydgv.com"],
  priority: "HIGH",
  startDate: "2026-08-25T04:30:00.000Z",
  dueDate: "2026-08-25T11:30:00.000Z",
  category: "HR",
});
assert.strictEqual(validCreate.ok, true);
assert.strictEqual(validCreate.title, "Prepare Monthly Report");
assert.strictEqual(validCreate.emails.length, 2);
assert.strictEqual(validCreate.category, "HR");

const missing = validateCreatePayload({ title: "  " });
assert.strictEqual(missing.ok, false);
assert.ok(missing.errors.title);
assert.ok(missing.errors.assignees);
assert.ok(missing.errors.priority);
assert.ok(missing.errors.startDate);
assert.ok(missing.errors.dueDate);

const badDates = validateCreatePayload({
  title: "Late deadline",
  assignees: ["rahul@mydgv.com"],
  priority: "MEDIUM",
  startDate: "2026-08-25T11:30:00.000Z",
  dueDate: "2026-08-25T09:30:00.000Z",
});
assert.strictEqual(badDates.ok, false);
assert.ok(String(badDates.errors.dueDate).includes("after"));

const badMinutes = validateCreatePayload({
  title: "Odd minutes",
  assignees: ["rahul@mydgv.com"],
  priority: "MEDIUM",
  startDate: "2026-08-25T04:31:00.000Z",
  dueDate: "2026-08-25T11:30:00.000Z",
});
assert.strictEqual(badMinutes.ok, false);
assert.ok(String(badMinutes.errors.startDate).includes("15-minute"));

const { validateAttachment } = require("./escalation");
assert.strictEqual(
  validateAttachment({ fileName: "notes.exe", fileSize: 100 }),
  "Invalid file type. Allowed: PDF, JPG, JPEG, PNG, DOC, DOCX, XLS, XLSX."
);
assert.strictEqual(
  validateAttachment({ fileName: "brief.pdf", fileSize: 2048 }),
  null
);

assert.strictEqual(displayNameFromEmail("nitesh.kumar@mydgv.com"), "Nitesh Kumar");
assert.strictEqual(
  creatorDisplayName({ createdBy: "nitesh.kumar@mydgv.com" }),
  "Nitesh Kumar"
);
assert.strictEqual(
  creatorDisplayName({
    createdBy: "nitesh.kumar@mydgv.com",
    createdByName: "Nitesh Kumar",
  }),
  "Nitesh Kumar"
);
assert.strictEqual(
  decorateTask({
    createdBy: "nitesh.kumar@mydgv.com",
    createdByName: "Nitesh Kumar",
    status: "TODO",
  }).createdByName,
  "Nitesh Kumar"
);

const { needsRedAdminNotify, employeeMayComplete } = require("./escalation");
assert.strictEqual(needsRedAdminNotify({}, {}, false), false);
assert.strictEqual(needsRedAdminNotify({}, {}, true), true);
assert.strictEqual(needsRedAdminNotify({ redAdminNotifyStatus: "SENT" }, {}, true), false);
assert.strictEqual(needsRedAdminNotify({ redAdminNotifyStatus: "SENT" }, {}, false), false);
assert.strictEqual(needsRedAdminNotify({ redAdminNotifyStatus: "FAILED" }, {}, false), true);
assert.strictEqual(needsRedAdminNotify({ redAdminNotifyStatus: "PENDING" }, {}, false), true);
assert.strictEqual(needsRedAdminNotify({ redAdminNotifyStatus: "PENDING" }, {}, true), true);
assert.strictEqual(
  needsRedAdminNotify(
    { redAdminNotifyStatus: "SENT" },
    { redAdminNotifyStatus: "FAILED" },
    false
  ),
  true
);
assert.strictEqual(
  needsRedAdminNotify({}, { redAdminNotifyStatus: "SENT" }, true),
  false
);
assert.strictEqual(
  needsRedAdminNotify(
    { redAdminNotifyStatus: "SENT" },
    { email: "rahul@mydgv.com", status: "TODO" },
    true
  ),
  true
);

const redNow = DEADLINE_MS + ORANGE_MS;
const taskDue = { dueDate: DEADLINE, taskId: "t-red" };

// TEST 1 — assignment enters Red
const enterRed = detectTransitions(
  { email: "a@mydgv.com", status: "TODO", recordedZone: "ORANGE" },
  DEADLINE,
  redNow
);
assert.strictEqual(enterRed.events.some((e) => e.action === "zone_red"), true);
assert.strictEqual(
  needsRedAdminNotify(taskDue, { ...enterRed.assignment, email: "a@mydgv.com" }, true, redNow),
  true
);

// TEST 2 — already Red and SENT: next sweep does not notify again
assert.strictEqual(
  needsRedAdminNotify(
    taskDue,
    {
      email: "a@mydgv.com",
      status: "TODO",
      recordedZone: "RED",
      redAdminNotifyStatus: "SENT",
    },
    false,
    redNow + 5 * 60 * 1000
  ),
  false
);

// TEST 3 — only the Red assignment notifies; Orange/DONE peers do not
assert.strictEqual(
  needsRedAdminNotify(
    taskDue,
    { email: "a@mydgv.com", status: "TODO", recordedZone: "ORANGE" },
    true,
    redNow
  ),
  true
);
assert.strictEqual(
  needsRedAdminNotify(
    taskDue,
    { email: "b@mydgv.com", status: "TODO", recordedZone: "ORANGE" },
    false,
    orangeNow
  ),
  false
);

// TEST 4 — completed before Red: no admin email
assert.strictEqual(
  needsRedAdminNotify(
    taskDue,
    { email: "a@mydgv.com", status: "DONE", recordedZone: "ORANGE" },
    true,
    redNow
  ),
  false
);
assert.strictEqual(
  needsRedAdminNotify(
    { dueDate: DEADLINE },
    { email: "suman@mydgv.com", status: "TODO" },
    false,
    redNow
  ),
  true
);

assert.strictEqual(
  employeeMayComplete({ email: "amit@mydgv.com", status: "TODO" }, DEADLINE, DEADLINE_MS - 1),
  true
);
assert.strictEqual(
  employeeMayComplete({ email: "amit@mydgv.com", status: "TODO" }, DEADLINE, DEADLINE_MS + 1),
  true
);
assert.strictEqual(
  employeeMayComplete(
    { email: "amit@mydgv.com", status: "TODO" },
    DEADLINE,
    DEADLINE_MS + ORANGE_MS
  ),
  false
);
assert.strictEqual(
  employeeMayComplete(
    completeAssignment(
      { email: "amit@mydgv.com", status: "TODO" },
      DEADLINE,
      DEADLINE_MS + 1,
      new Date(DEADLINE_MS + 1).toISOString()
    ),
    DEADLINE,
    DEADLINE_MS + ORANGE_MS
  ),
  false
);

const { activeAdminEmailsFromAccess } = require("../common/roles");
assert.deepStrictEqual(
  activeAdminEmailsFromAccess([
    { PK: "admin@mydgv.com", role: "ADMIN", status: "ACTIVE" },
    { email: "emp@mydgv.com", role: "EMPLOYEE", status: "ACTIVE" },
    { email: "mgr@mydgv.com", role: "MANAGER", status: "BLOCKED" },
    { email: "waiting@mydgv.com", role: "ADMIN", status: "PENDING" },
    { email: "super@mydgv.com", role: "SUPER_ADMIN", status: "ACTIVE" },
    { email: "lead@mydgv.com", role: "MANAGER", status: "ACTIVE" },
    { PK: "no-email-row", role: "ADMIN", status: "ACTIVE" },
  ]),
  ["admin@mydgv.com", "super@mydgv.com", "lead@mydgv.com"]
);

console.log("escalation tests passed");

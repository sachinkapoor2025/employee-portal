const assert = require("assert");
const fs = require("fs");
const { notifyAdminsTaskEnteredRed } = require("./redAdminNotify");
const { needsRedAdminNotify, detectTransitions, ORANGE_MS } = require("./escalation");
const { activeAdminEmailsFromAccess } = require("../common/roles");

const DEADLINE = "2026-08-31T10:30:00.000Z";
const DEADLINE_MS = Date.parse(DEADLINE);
const RED_AT = new Date(DEADLINE_MS + ORANGE_MS).toISOString();
const task = {
  taskId: "task-rakhi",
  title: "Create 4 images for Rakhi",
  dueDate: DEADLINE,
};
const assignmentA = { email: "priya.yadav@mydgv.com", status: "TODO" };

const logs = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => {
  logs.push(args.map(String).join(" "));
};
console.error = (...args) => {
  logs.push(args.map(String).join(" "));
};

function logged(token) {
  return logs.some((line) => line.includes(token));
}

async function run() {
  logs.length = 0;

  // TEST 1 — assignment enters Red → admin notify is invoked
  const entered = detectTransitions(
    { email: assignmentA.email, status: "TODO", recordedZone: "ORANGE" },
    DEADLINE,
    DEADLINE_MS + ORANGE_MS
  );
  assert.ok(entered.events.some((e) => e.action === "zone_red"));
  assert.strictEqual(
    needsRedAdminNotify(task, entered.assignment, true, DEADLINE_MS + ORANGE_MS),
    true
  );
  const dispatched = [];
  const status1 = await notifyAdminsTaskEnteredRed({
    task: {
      ...task,
      projectId: "proj-1",
      priority: "HIGH",
      description: "Create 4 festival images.",
    },
    assignment: { ...assignmentA, status: "IN_PROGRESS" },
    redAt: RED_AT,
    adminEmails: ["admin1@mydgv.com"],
    nowMs: DEADLINE_MS + ORANGE_MS,
    getAssigneeProfile: async () => ({ name: "Priya Yadav" }),
    getProjectName: async (projectId) => {
      assert.strictEqual(projectId, "proj-1");
      return "Festival Campaign";
    },
    dispatchNotification: async (opts) => {
      dispatched.push(opts);
      return { status: "SENT", skipped: false };
    },
  });
  assert.strictEqual(status1, "SENT");
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(
    dispatched[0].subject,
    "🔴 Task Entered Red Zone – Action Required: Create 4 images for Rakhi"
  );
  assert.ok(dispatched[0].message.includes("Create 4 images for Rakhi"));
  assert.ok(dispatched[0].message.includes("Priya Yadav"));
  assert.ok(dispatched[0].message.includes("priya.yadav@mydgv.com"));
  assert.ok(dispatched[0].message.includes("Festival Campaign"));
  assert.ok(dispatched[0].message.includes("IN_PROGRESS"));
  assert.ok(dispatched[0].message.includes("Original Deadline:"));
  assert.ok(dispatched[0].message.includes("Red Zone Started:"));
  assert.ok(dispatched[0].message.includes("1 September 2026"));
  assert.ok(dispatched[0].message.includes("High"));
  assert.ok(dispatched[0].message.includes("Create 4 festival images."));
  assert.ok(dispatched[0].html.includes("VIEW TASK"));
  assert.ok(dispatched[0].html.includes("/admin/tasks/task-rakhi"));
  assert.strictEqual(Date.parse(RED_AT) - DEADLINE_MS, ORANGE_MS);
  assert.ok(logged("RED_ADMIN_NOTIFY_TRIGGERED"));
  assert.ok(logged("RED_ADMIN_NOTIFY_SENT"));

  const omittedFields = [];
  await notifyAdminsTaskEnteredRed({
    task,
    assignment: assignmentA,
    redAt: RED_AT,
    adminEmails: ["admin1@mydgv.com"],
    nowMs: DEADLINE_MS + ORANGE_MS,
    getAssigneeProfile: async () => ({ name: "Priya Yadav" }),
    dispatchNotification: async (opts) => {
      omittedFields.push(opts);
      return { status: "SENT", skipped: false };
    },
  });
  assert.ok(!omittedFields[0].message.includes("Project:"));
  assert.ok(!omittedFields[0].message.includes("Priority:"));
  assert.ok(!omittedFields[0].message.includes("Description:"));

  // TEST 2 — already SENT: needsRedAdminNotify is false (no duplicate sweep)
  assert.strictEqual(
    needsRedAdminNotify(
      task,
      {
        email: assignmentA.email,
        status: "TODO",
        recordedZone: "RED",
        redAdminNotifyStatus: "SENT",
      },
      false,
      DEADLINE_MS + ORANGE_MS + 5 * 60 * 1000
    ),
    false
  );
  logs.length = 0;
  dispatched.length = 0;
  const statusDup = await notifyAdminsTaskEnteredRed({
    task,
    assignment: assignmentA,
    redAt: RED_AT,
    adminEmails: ["admin1@mydgv.com"],
    dispatchNotification: async (opts) => {
      dispatched.push(opts);
      return { status: "SENT", skipped: true };
    },
  });
  assert.strictEqual(statusDup, "SENT");
  assert.ok(logged("already sent"));

  // TEST 3 — only Employee A (Red) generates the alert; B still Orange does not
  assert.strictEqual(
    needsRedAdminNotify(
      task,
      { email: "a@mydgv.com", status: "IN_PROGRESS", recordedZone: "ORANGE" },
      true,
      DEADLINE_MS + ORANGE_MS
    ),
    true
  );
  assert.strictEqual(
    needsRedAdminNotify(
      task,
      { email: "b@mydgv.com", status: "IN_PROGRESS", recordedZone: "ORANGE" },
      false,
      DEADLINE_MS + 60 * 60 * 1000
    ),
    false
  );

  // TEST 4 — DONE before Red: no admin email
  assert.strictEqual(
    needsRedAdminNotify(
      task,
      { email: "a@mydgv.com", status: "DONE", completedZone: "ORANGE" },
      true,
      DEADLINE_MS + ORANGE_MS
    ),
    false
  );

  // TEST 5 — no active admins: no SES, SKIPPED, not SENT
  logs.length = 0;
  dispatched.length = 0;
  const emptyStatus = await notifyAdminsTaskEnteredRed({
    task,
    assignment: assignmentA,
    redAt: RED_AT,
    adminEmails: [],
    dispatchNotification: async (opts) => {
      dispatched.push(opts);
      return { status: "SENT" };
    },
  });
  assert.strictEqual(emptyStatus, "FAILED");
  assert.strictEqual(dispatched.length, 0);
  assert.ok(logged("RED_ADMIN_NOTIFY_SKIPPED"));
  assert.ok(logged("no active administrators"));
  assert.ok(!logged("RED_ADMIN_NOTIFY_SENT"));

  // TEST 6 — SES succeeds → SENT
  logs.length = 0;
  const okStatus = await notifyAdminsTaskEnteredRed({
    task,
    assignment: assignmentA,
    redAt: RED_AT,
    adminEmails: ["admin1@mydgv.com"],
    getAssigneeProfile: async () => ({ name: "Priya Yadav" }),
    dispatchNotification: async () => ({ status: "SENT", skipped: false }),
  });
  assert.strictEqual(okStatus, "SENT");
  assert.ok(logged("RED_ADMIN_NOTIFY_SENT"));

  // TEST 7 — SES fails → not SENT, retryable FAILED
  logs.length = 0;
  const failStatus = await notifyAdminsTaskEnteredRed({
    task,
    assignment: assignmentA,
    redAt: RED_AT,
    adminEmails: ["admin1@mydgv.com"],
    dispatchNotification: async () => ({
      status: "FAILED",
      skipped: false,
      error: "MessageRejected",
    }),
  });
  assert.strictEqual(failStatus, "FAILED");
  assert.ok(logged("EMAIL_SEND_FAILED"));
  assert.ok(!logs.some((line) => line.includes("RED_ADMIN_NOTIFY_SENT")));
  assert.strictEqual(
    needsRedAdminNotify(
      task,
      {
        email: assignmentA.email,
        status: "TODO",
        redAdminNotifyStatus: "FAILED",
      },
      false,
      DEADLINE_MS + ORANGE_MS
    ),
    true
  );

  // TEST 8 — every eligible admin receives the alert
  const admins = ["admin1@mydgv.com", "admin2@mydgv.com", "admin3@mydgv.com"];
  const recipients = [];
  const multiStatus = await notifyAdminsTaskEnteredRed({
    task,
    assignment: assignmentA,
    redAt: RED_AT,
    adminEmails: admins,
    getAssigneeProfile: async () => ({ name: "Priya Yadav" }),
    dispatchNotification: async (opts) => {
      recipients.push(opts.email);
      return { status: "SENT", skipped: false };
    },
  });
  assert.strictEqual(multiStatus, "SENT");
  assert.deepStrictEqual(recipients, admins);

  // TEST 9 / 10 — EMPLOYEE, BLOCKED, PENDING excluded; active admins kept
  assert.deepStrictEqual(
    activeAdminEmailsFromAccess([
      { email: "admin1@mydgv.com", role: "ADMIN", status: "ACTIVE" },
      { email: "emp@mydgv.com", role: "EMPLOYEE", status: "ACTIVE" },
      { email: "blocked@mydgv.com", role: "ADMIN", status: "BLOCKED" },
      { email: "pending@mydgv.com", role: "SUPER_ADMIN", status: "PENDING" },
      { email: "admin2@mydgv.com", role: "SUPER_ADMIN", status: "ACTIVE" },
      { email: "lead@mydgv.com", role: "MANAGER", status: "ACTIVE" },
    ]),
    ["admin1@mydgv.com", "admin2@mydgv.com", "lead@mydgv.com"]
  );

  const handlerSrc = fs.readFileSync(require.resolve("./handler.js"), "utf8");
  assert.ok(handlerSrc.includes('require("./redAdminNotify")'));
  assert.ok(handlerSrc.includes("notifyAdminsTaskEnteredRed"));
  assert.ok(handlerSrc.includes("notifyTaskEvent"));
  assert.ok(handlerSrc.includes("listActiveAdminEmails"));
  assert.ok(handlerSrc.includes("runWeeklyRedZoneReport"));
  assert.ok(handlerSrc.includes("zoneNotifyCopy"));
  assert.ok(handlerSrc.includes("copy.type"));
  assert.ok(handlerSrc.includes("getProjectName"));

  console.log = originalLog;
  console.error = originalError;
  console.log("red admin notify tests passed");
}

run().catch((err) => {
  console.log = originalLog;
  console.error = originalError;
  console.error(err);
  process.exit(1);
});

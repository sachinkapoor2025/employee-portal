const assert = require("assert");
const fs = require("fs");
const { dispatchNotification } = require("../common/notify");
const { activeAdminEmailsFromAccess } = require("../common/roles");
const { needsRedAdminNotify, detectTransitions } = require("./escalation");
const { zoneNotifyCopy, redAdminNotifyCopy } = require("./zoneNotify");
const { notifyAdminsTaskEnteredRed } = require("./redAdminNotify");

process.env.WORK_TABLE = "WorkTasksTable";
process.env.NOTIFICATION_FROM_EMAIL = "";

function createMemoryDdb() {
  const items = new Map();
  const puts = [];
  return {
    puts,
    send: async (cmd) => {
      const input = cmd.input;
      if (input.Item) {
        puts.push(input.Item);
        items.set(`${input.Item.PK}|${input.Item.SK}`, input.Item);
        return {};
      }
      if (input.Key) {
        return { Item: items.get(`${input.Key.PK}|${input.Key.SK}`) };
      }
      return {};
    },
  };
}

function notifyItems(ddb) {
  return ddb.puts.filter((item) => String(item.SK || "").startsWith("NOTIFY#"));
}

function reminderItems(ddb) {
  return ddb.puts.filter((item) => String(item.SK || "").startsWith("REMINDER#"));
}

function notifyTaskEventCalls(handlerSrc) {
  const parts = handlerSrc.split("await notifyTaskEvent(").slice(1);
  return parts.map((part) => {
    const end = part.indexOf(");");
    return part.slice(0, end);
  });
}

async function run() {
  const assignedDdb = createMemoryDdb();
  const assigned = await dispatchNotification(assignedDdb, {
    email: "doer@mydgv.com",
    type: "TASK_ASSIGNED",
    title: "New task assigned: Homepage Update",
    message: 'You have been assigned "Homepage Update".',
    dedupKey: "task-1#doer@mydgv.com#assigned",
    extra: { taskId: "task-1" },
  });
  assert.strictEqual(assigned.status, "SENT");
  assert.ok(!assigned.messageId);
  const assignedBell = notifyItems(assignedDdb);
  assert.strictEqual(assignedBell.length, 1);
  assert.strictEqual(assignedBell[0].type, "TASK_ASSIGNED");
  assert.strictEqual(assignedBell[0].email, "doer@mydgv.com");
  assert.ok(assignedBell[0].title.includes("New task assigned"));
  const assignedReminder = reminderItems(assignedDdb).pop();
  assert.strictEqual(assignedReminder.channel, "inapp");
  assert.strictEqual(assignedReminder.type, "TASK_ASSIGNED");

  const orangeCopy = zoneNotifyCopy({
    orange: true,
    title: "Homepage Update",
    deadline: "2026-08-25T11:30:00.000Z",
    zoneStartedAt: "2026-08-25T11:30:00.000Z",
  });
  const orangeDdb = createMemoryDdb();
  const orange = await dispatchNotification(orangeDdb, {
    email: "doer@mydgv.com",
    type: orangeCopy.type,
    title: orangeCopy.title,
    message: orangeCopy.message,
    dedupKey: "task-1#doer@mydgv.com#zone_orange",
    extra: { taskId: "task-1", zone: orangeCopy.zone, category: orangeCopy.category },
    channel: "inapp",
  });
  assert.strictEqual(orangeCopy.type, "TASK_ORANGE");
  assert.strictEqual(orange.status, "SENT");
  assert.ok(!orange.messageId);
  const orangeBell = notifyItems(orangeDdb);
  assert.strictEqual(orangeBell.length, 1);
  assert.strictEqual(orangeBell[0].type, "TASK_ORANGE");
  assert.strictEqual(reminderItems(orangeDdb).pop().channel, "inapp");

  const redCopy = zoneNotifyCopy({
    orange: false,
    title: "Homepage Update",
    deadline: "2026-08-25T11:30:00.000Z",
    zoneStartedAt: "2026-08-26T11:30:00.000Z",
  });
  const redDdb = createMemoryDdb();
  const redInApp = await dispatchNotification(redDdb, {
    email: "doer@mydgv.com",
    type: redCopy.type,
    title: redCopy.title,
    message: redCopy.message,
    dedupKey: "task-1#doer@mydgv.com#zone_red",
    extra: { taskId: "task-1", zone: redCopy.zone, category: redCopy.category },
    channel: "inapp",
  });
  assert.strictEqual(redCopy.type, "TASK_RED");
  assert.strictEqual(redInApp.status, "SENT");
  assert.ok(!redInApp.messageId);
  const redBell = notifyItems(redDdb);
  assert.strictEqual(redBell.length, 1);
  assert.strictEqual(redBell[0].type, "TASK_RED");
  assert.strictEqual(reminderItems(redDdb).pop().channel, "inapp");

  const adminEmails = [];
  const adminStatus = await notifyAdminsTaskEnteredRed({
    task: {
      taskId: "task-1",
      title: "Homepage Update",
      projectId: "p1",
      dueDate: "2026-08-25T11:30:00.000Z",
      description: "Update homepage banner.",
      priority: "HIGH",
    },
    assignment: { email: "doer@mydgv.com", status: "IN_PROGRESS" },
    redAt: "2026-08-26T11:30:00.000Z",
    adminEmails: ["super@mydgv.com", "admin@mydgv.com", "lead@mydgv.com"],
    getAssigneeProfile: async () => ({ name: "Amit Sharma" }),
    getProjectName: async () => "Client Website",
    sendEmail: async (opts) => {
      adminEmails.push(opts.to);
      return { ok: true, messageId: `ses-${opts.to}` };
    },
  });
  assert.strictEqual(adminStatus, "SENT");
  assert.deepStrictEqual(adminEmails, [
    "super@mydgv.com",
    "admin@mydgv.com",
    "lead@mydgv.com",
  ]);

  const recipients = activeAdminEmailsFromAccess([
    { PK: "super@mydgv.com", role: "SUPER_ADMIN", status: "ACTIVE" },
    { email: "admin@mydgv.com", role: "ADMIN", status: "ACTIVE" },
    { email: "lead@mydgv.com", role: "MANAGER", status: "ACTIVE" },
    { email: "doer@mydgv.com", role: "EMPLOYEE", status: "ACTIVE" },
    { email: "blocked-admin@mydgv.com", role: "ADMIN", status: "BLOCKED" },
    { email: "pending-mgr@mydgv.com", role: "MANAGER", status: "PENDING" },
  ]);
  assert.deepStrictEqual(recipients, [
    "super@mydgv.com",
    "admin@mydgv.com",
    "lead@mydgv.com",
  ]);
  assert.ok(!recipients.includes("doer@mydgv.com"));

  const deadline = "2026-08-25T11:30:00.000Z";
  const deadlineMs = Date.parse(deadline);
  const orangeMs = require("./escalation").ORANGE_MS;
  const redNow = deadlineMs + orangeMs;
  const taskDue = { dueDate: deadline, taskId: "task-multi" };
  const aRed = detectTransitions(
    { email: "a@mydgv.com", status: "TODO", recordedZone: "ORANGE" },
    deadline,
    redNow
  );
  const bOrange = detectTransitions(
    { email: "b@mydgv.com", status: "TODO", recordedZone: "GREEN" },
    deadline,
    deadlineMs
  );
  assert.ok(aRed.events.some((e) => e.action === "zone_red"));
  assert.ok(bOrange.events.some((e) => e.action === "zone_orange"));
  assert.strictEqual(
    needsRedAdminNotify(taskDue, { ...aRed.assignment, email: "a@mydgv.com" }, true, redNow),
    true
  );
  assert.strictEqual(
    needsRedAdminNotify(
      taskDue,
      { ...bOrange.assignment, email: "b@mydgv.com" },
      false,
      deadlineMs
    ),
    false
  );
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

  const content = redAdminNotifyCopy({
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
  assert.strictEqual(content.type, "TASK_RED_ADMIN");
  assert.strictEqual(
    content.subject,
    "🔴 Task Entered Red Zone – Action Required: Website Homepage Update"
  );
  assert.ok(content.message.includes("Priya Yadav"));
  assert.ok(content.message.includes("priya.yadav@mydgv.com"));
  assert.ok(content.message.includes("IN_PROGRESS"));
  assert.ok(content.message.includes("Original Deadline:"));
  assert.ok(content.message.includes("Red Zone Started:"));
  assert.ok(content.message.includes("1 day"));
  assert.ok(content.message.includes("https://login.mydgv.com/admin/tasks/task-1"));
  assert.ok(content.message.includes("Client Website"));
  assert.ok(content.message.includes("High"));
  assert.ok(content.message.includes("Update homepage banner and CTA."));
  assert.ok(content.html.includes("VIEW TASK"));

  const handlerSrc = fs.readFileSync(require.resolve("./handler.js"), "utf8");
  const calls = notifyTaskEventCalls(handlerSrc);
  const assignedCalls = calls.filter((call) => call.includes('"TASK_ASSIGNED"'));
  assert.ok(assignedCalls.length >= 3);
  for (const call of assignedCalls) {
    assert.ok(
      call.includes('channel: "inapp"'),
      "TASK_ASSIGNED notifyTaskEvent must be in-app only"
    );
  }
  const zoneCall = calls.find((call) => call.includes("copy.type"));
  assert.ok(zoneCall);
  assert.ok(zoneCall.includes('channel: "inapp"'));
  assert.ok(handlerSrc.includes("notifyAdminsTaskEnteredRed"));
  assert.ok(handlerSrc.includes("claimRedAdminNotify"));
  assert.ok(handlerSrc.includes("finalizeRedAdminNotify"));
  assert.ok(handlerSrc.includes("persistRedAdminRecipient"));
  assert.ok(handlerSrc.includes("existingRecipients"));
  assert.ok(handlerSrc.includes("listActiveAdminEmails"));
  assert.ok(handlerSrc.includes("for (const a of pendingAdmin)"));
  assert.ok(handlerSrc.includes("activeAdminEmailsFromAccess"));

  console.log("task notify tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

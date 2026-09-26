const assert = require("assert");
const { PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
const {
  TYPE_ASSIGNED_EMAIL,
  TYPE_REVIEW_REASSIGNED_EMAIL,
  assignedEmailKey,
  reviewReassignedEmailKey,
  employeeTaskUrl,
  assignedEmployeeCopy,
  notifyAssignedEmployee,
} = require("./taskAssignNotify");

process.env.WORK_TABLE = process.env.WORK_TABLE || "WorkTasksTable";
process.env.PORTAL_URL = "https://login.mydgv.com";
process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";

function createMemoryDdb() {
  const items = new Map();
  return {
    items,
    send: async (cmd) => {
      const input = cmd.input;
      if (cmd instanceof PutCommand || input.Item) {
        items.set(`${input.Item.PK}|${input.Item.SK}`, { ...input.Item });
        return {};
      }
      if (cmd instanceof GetCommand || input.Key) {
        return { Item: items.get(`${input.Key.PK}|${input.Key.SK}`) };
      }
      return {};
    },
  };
}

const assigned = assignedEmployeeCopy({
  kind: "assigned",
  title: "Homepage Update",
  projectName: "Client Website",
  priority: "HIGH",
  category: "Marketing",
  description: "Update the banner.",
  startDate: "2026-08-31T10:30:00.000Z",
  dueDate: "2026-08-31T12:30:00.000Z",
  assignedByName: "Priya Yadav",
  assignedByEmail: "priya.yadav@mydgv.com",
  viewTaskUrl: "https://login.mydgv.com/work/task-1",
  timeZone: "Asia/Kolkata",
});
assert.strictEqual(assigned.type, TYPE_ASSIGNED_EMAIL);
assert.strictEqual(assigned.subject, "Task Assigned: Homepage Update");
assert.ok(assigned.message.includes("You have been assigned a new task"));
assert.ok(assigned.message.includes("Homepage Update"));
assert.ok(assigned.message.includes("Client Website"));
assert.ok(assigned.message.includes("High"));
assert.ok(assigned.message.includes("Marketing"));
assert.ok(assigned.message.includes("Update the banner."));
assert.ok(assigned.message.includes("Priya Yadav"));
assert.ok(!assigned.message.includes("priya.yadav@mydgv.com"));
assert.ok(assigned.html.includes("font-family:Arial,sans-serif"));
assert.ok(assigned.html.includes("background:#1f2937"));
assert.ok(assigned.html.includes("VIEW TASK"));
assert.ok(assigned.html.includes("https://login.mydgv.com/work/task-1"));
assert.ok(!assigned.html.includes("sourceTaskId"));
assert.ok(!assigned.message.includes("sourceTaskId"));
assert.ok(!assigned.html.includes("PK#"));
assert.ok(!assigned.html.includes("SK#"));

const reassigned = assignedEmployeeCopy({
  kind: "review-reassigned",
  title: "Banner update",
  projectName: "DGV Employee Portal",
  priority: "HIGH",
  category: "Marketing",
  description: "Original description",
  startDate: "2099-12-31T18:15:00+05:30",
  dueDate: "2099-12-31T19:45:00+05:30",
  assignedByName: "Admin",
  assignedByEmail: "admin@mydgv.com",
  reasonLabel: "Changes Required",
  remark: "Please add alt text.",
  viewTaskUrl: "https://login.mydgv.com/work/new-task",
  timeZone: "Asia/Kolkata",
});
assert.strictEqual(reassigned.type, TYPE_REVIEW_REASSIGNED_EMAIL);
assert.strictEqual(reassigned.subject, "Task Reassigned to You: Banner update");
assert.ok(reassigned.message.includes("A task has been reassigned to you"));
assert.ok(reassigned.message.includes("Changes Required"));
assert.ok(reassigned.message.includes("Please add alt text."));
assert.ok(reassigned.html.includes("background:#b45309"));
assert.ok(reassigned.html.includes("Please add alt text."));
assert.ok(reassigned.html.includes("Changes Required"));
assert.ok(!reassigned.html.includes("sourceTaskId"));
assert.ok(!reassigned.message.includes("TASK-"));

const xss = assignedEmployeeCopy({
  kind: "assigned",
  title: '<script>alert("x")</script>',
  description: "A & B",
  assignedByName: '<img src=x>',
  viewTaskUrl: 'https://login.mydgv.com/work/ab&c',
});
assert.ok(!xss.html.includes("<script>"));
assert.ok(xss.html.includes("&lt;script&gt;"));
assert.ok(xss.html.includes("A &amp; B"));
assert.ok(xss.html.includes("&lt;img src=x&gt;"));
assert.ok(xss.html.includes("ab&amp;c"));

assert.strictEqual(
  assignedEmailKey("task-1", "Rahul@mydgv.com", "2026-01-01T00:00:00.000Z"),
  "task-1#rahul@mydgv.com#assigned-email#2026-01-01T00:00:00.000Z"
);
assert.ok(
  reviewReassignedEmailKey("task-2", "a@mydgv.com").includes(
    "review-reassigned-email"
  )
);
assert.strictEqual(
  employeeTaskUrl("task 1"),
  "https://login.mydgv.com/work/task%201"
);

async function runNotify() {
  const orig = email.sendEmail;
  const mails = [];
  email.sendEmail = async (payload) => {
    mails.push(payload);
    return { ok: true, messageId: "ses-1" };
  };
  const ddb = createMemoryDdb();
  const first = await notifyAssignedEmployee({
    ddb,
    task: {
      taskId: "task-1",
      title: "Homepage Update",
      projectId: "p1",
      priority: "HIGH",
      startDate: "2026-08-31T10:30:00.000Z",
      dueDate: "2026-08-31T12:30:00.000Z",
    },
    assigneeEmail: "doer@mydgv.com",
    assignedByName: "Priya Yadav",
    assignedByEmail: "priya@mydgv.com",
    projectName: "Client Website",
    assignedAt: "2026-09-01T00:00:00.000Z",
    kind: "assigned",
  });
  assert.strictEqual(first.status, "SENT");
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, "doer@mydgv.com");
  assert.strictEqual(mails[0].subject, "Task Assigned: Homepage Update");
  assert.ok(mails[0].html.includes("VIEW TASK"));

  const retry = await notifyAssignedEmployee({
    ddb,
    task: {
      taskId: "task-1",
      title: "Homepage Update",
    },
    assigneeEmail: "doer@mydgv.com",
    assignedAt: "2026-09-01T00:00:00.000Z",
    kind: "assigned",
  });
  assert.strictEqual(retry.skipped, true);
  assert.strictEqual(mails.length, 1);

  email.sendEmail = async () => {
    throw new Error("SES down");
  };
  const failed = await notifyAssignedEmployee({
    ddb,
    task: { taskId: "task-fail", title: "X" },
    assigneeEmail: "doer@mydgv.com",
    assignedAt: "now",
    kind: "assigned",
  });
  assert.strictEqual(failed.status, "FAILED");
  email.sendEmail = orig;
}

runNotify()
  .then(() => {
    console.log("task assign notify tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

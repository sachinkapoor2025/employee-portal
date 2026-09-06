const assert = require("assert");
const { notifyAdminsTaskEnteredRed } = require("./redAdminNotify");

async function run() {
  const calls = [];
  const status = await notifyAdminsTaskEnteredRed({
    task: {
      taskId: "task-1",
      title: "test",
      projectId: "p1",
      dueDate: "2026-09-05T15:15:00.000Z",
      description: "desc",
      priority: "HIGH",
    },
    assignment: { email: "amit@mydgv.com", status: "TODO" },
    redAt: "2026-09-05T15:25:00.000Z",
    adminEmails: ["admin@mydgv.com"],
    getAssigneeProfile: async () => ({ name: "Amit Sharma" }),
    getProjectName: async () => "Sample Project",
    sendEmail: async (opts) => {
      calls.push(opts);
      return { ok: true, messageId: "ses-1" };
    },
  });
  assert.strictEqual(status, "SENT");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].to, "admin@mydgv.com");
  assert.ok(calls[0].subject.includes("Task Entered Red Zone"));
  assert.ok(calls[0].text.includes("Amit Sharma"));
  assert.ok(calls[0].text.includes("amit@mydgv.com"));
  assert.ok(calls[0].html);

  const empty = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-2", title: "x" },
    assignment: { email: "a@mydgv.com", status: "TODO" },
    adminEmails: [],
    sendEmail: async () => ({ ok: true, messageId: "x" }),
  });
  assert.strictEqual(empty, "FAILED");

  const failed = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-3", title: "x" },
    assignment: { email: "a@mydgv.com", status: "TODO" },
    adminEmails: ["admin@mydgv.com"],
    sendEmail: async () => ({ ok: false, error: "MessageRejected" }),
  });
  assert.strictEqual(failed, "FAILED");

  const handlerSrc = require("fs").readFileSync(require.resolve("./handler.js"), "utf8");
  assert.ok(handlerSrc.includes("notifyAdminsTaskEnteredRed"));
  assert.ok(!handlerSrc.includes("TASK_DUE_SOON"));
  console.log("red admin notify tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

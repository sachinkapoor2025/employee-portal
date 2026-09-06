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
    dispatchNotification: async (opts) => {
      calls.push(opts);
      return { status: "SENT" };
    },
  });
  assert.strictEqual(status, "SENT");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].email, "admin@mydgv.com");
  assert.strictEqual(calls[0].channel, "email");
  assert.ok(calls[0].message.includes("Amit Sharma"));
  assert.ok(calls[0].message.includes("amit@mydgv.com"));

  const empty = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-2", title: "x" },
    assignment: { email: "a@mydgv.com", status: "TODO" },
    adminEmails: [],
    dispatchNotification: async () => ({ status: "SENT" }),
  });
  assert.strictEqual(empty, "FAILED");

  const handlerSrc = require("fs").readFileSync(require.resolve("./handler.js"), "utf8");
  assert.ok(handlerSrc.includes("notifyAdminsTaskEnteredRed"));
  assert.ok(!handlerSrc.includes("TASK_DUE_SOON"));
  console.log("red admin notify tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

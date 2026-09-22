process.env.WORK_TABLE = "work-table";
process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";
process.env.TASK_NOTIFY_FROM_NAME = "DGV Portal";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";

const assert = require("assert");
const { GetCommand, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
const {
  TYPE_SCHEDULED_POSTPONED_EMAIL,
  postponedNotifyKey,
  notifyScheduledPostponement,
} = require("./taskScheduledPostponeNotify");

const emailCalls = [];
email.sendEmail = async (payload) => {
  emailCalls.push(payload);
  return { ok: true, messageId: "ses-postpone" };
};

function createDdb(accessRows) {
  const items = [];
  return {
    items,
    async send(command) {
      if (command instanceof ScanCommand) {
        return { Items: accessRows };
      }
      if (command instanceof GetCommand) {
        const found = items.find(
          (item) =>
            item.PK === command.input.Key.PK && item.SK === command.input.Key.SK
        );
        return { Item: found };
      }
      if (command instanceof PutCommand) {
        const item = command.input.Item;
        const idx = items.findIndex(
          (row) => row.PK === item.PK && row.SK === item.SK
        );
        if (idx >= 0) items[idx] = item;
        else items.push(item);
        return {};
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
}

async function run() {
  const accessRows = [
    { email: "super@mydgv.com", role: "SUPER_ADMIN", status: "ACTIVE" },
    { email: "oldsuper@mydgv.com", role: "SUPER_ADMIN", status: "BLOCKED" },
    { email: "admin@mydgv.com", role: "ADMIN", status: "ACTIVE" },
    { email: "lead@mydgv.com", role: "MANAGER", status: "ACTIVE" },
    { email: "projadmin@mydgv.com", role: "ADMIN", status: "ACTIVE" },
    { email: "priya@mydgv.com", role: "EMPLOYEE", status: "ACTIVE" },
  ];
  const ddb = createDdb(accessRows);
  const task = {
    taskId: "task-postpone-1",
    title: "Leave calendar",
    startDate: "2026-09-22T08:30:00.000Z",
    dueDate: "2026-09-22T09:00:00.000Z",
  };
  const first = await notifyScheduledPostponement({
    ddb,
    accessTable: "access-table",
    task,
    postponedEmails: ["priya@mydgv.com"],
    previousStart: task.startDate,
    previousDue: task.dueDate,
    previousScheduledAssignAt: "2026-09-22T08:30:00.000Z",
    nextStart: "2026-09-23T08:30:00.000Z",
    nextDue: "2026-09-23T09:00:00.000Z",
    reasons: ["LEAVE"],
    attendanceStatusByEmail: { "priya@mydgv.com": "Leave" },
    postponementCount: 1,
  });
  assert.deepStrictEqual(first.recipients, ["super@mydgv.com"]);
  assert.strictEqual(emailCalls.length, 1);
  assert.strictEqual(emailCalls[0].to, "super@mydgv.com");
  assert.strictEqual(emailCalls[0].from, "noreply@mydgv.com");
  assert.ok(/Scheduled task postponed/i.test(emailCalls[0].subject));
  assert.ok(/priya@mydgv.com/.test(emailCalls[0].text));
  assert.ok(/Leave/.test(emailCalls[0].text));
  assert.ok(/Postponement count: 1/.test(emailCalls[0].text));
  assert.ok(!emailCalls.some((call) => call.to === "priya@mydgv.com"));
  assert.ok(!emailCalls.some((call) => call.to === "admin@mydgv.com"));
  assert.ok(!emailCalls.some((call) => call.to === "lead@mydgv.com"));
  assert.ok(!emailCalls.some((call) => call.to === "projadmin@mydgv.com"));
  assert.ok(!emailCalls.some((call) => call.to === "oldsuper@mydgv.com"));
  assert.ok(
    ddb.items.some(
      (item) =>
        item.type === TYPE_SCHEDULED_POSTPONED_EMAIL && item.status === "SENT"
    )
  );

  const second = await notifyScheduledPostponement({
    ddb,
    accessTable: "access-table",
    task,
    postponedEmails: ["priya@mydgv.com"],
    previousStart: task.startDate,
    previousDue: task.dueDate,
    previousScheduledAssignAt: "2026-09-22T08:30:00.000Z",
    nextStart: "2026-09-23T08:30:00.000Z",
    nextDue: "2026-09-23T09:00:00.000Z",
    reasons: ["LEAVE"],
    attendanceStatusByEmail: { "priya@mydgv.com": "Leave" },
    postponementCount: 1,
  });
  assert.strictEqual(emailCalls.length, 1);
  assert.ok(second.results.every((row) => row.skipped || row.status === "SENT"));
  assert.strictEqual(
    postponedNotifyKey("task-postpone-1", "2026-09-22T08:30:00.000Z"),
    "task-postpone-1#2026-09-22T08:30:00.000Z#postponed"
  );
  console.log("taskScheduledPostponeNotify tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.env.WORK_TABLE = "work-table";
process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";
process.env.TASK_NOTIFY_FROM_NAME = "DGV Portal";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.PORTAL_URL = "https://login.mydgv.com";

const assert = require("assert");
const { GetCommand, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
const { ASSIGNED_SHIFT_FIT } = require("./assignedShiftFit");
const {
  TYPE_SHIFT_CONFLICT,
  TYPE_SHIFT_CONFLICT_EMAIL,
  shiftConflictNotifyKey,
  notifyScheduledShiftConflicts,
} = require("./taskScheduledShiftConflictNotify");

const emailCalls = [];
email.sendEmail = async (payload) => {
  emailCalls.push(payload);
  return { ok: true, messageId: "ses-shift-conflict" };
};

function createDdb(accessRows) {
  const items = [];
  return {
    items,
    seed(item) {
      const idx = items.findIndex((row) => row.PK === item.PK && row.SK === item.SK);
      if (idx >= 0) items[idx] = item;
      else items.push(item);
    },
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
        this.seed(command.input.Item);
        return {};
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
}

const ACCESS_ROWS = [
  { email: "super@mydgv.com", role: "SUPER_ADMIN", status: "ACTIVE" },
  { email: "oldsuper@mydgv.com", role: "SUPER_ADMIN", status: "BLOCKED" },
  { email: "admin@mydgv.com", role: "ADMIN", status: "ACTIVE" },
  { email: "lead@mydgv.com", role: "MANAGER", status: "ACTIVE" },
  { email: "priya@mydgv.com", role: "EMPLOYEE", status: "ACTIVE" },
  { email: "rahul@mydgv.com", role: "EMPLOYEE", status: "ACTIVE" },
];

const TASK = {
  taskId: "task-conflict-1",
  title: "Evening banner",
  startDate: "2026-09-22T18:00:00+05:30",
  dueDate: "2026-09-22T21:00:00+05:30",
  scheduledAssignAt: "2026-09-22T18:00:00+05:30",
  assignmentState: "PENDING",
};

function seedMorning(ddb, email) {
  ddb.seed({
    PK: `USER#${email}`,
    SK: "SHIFT#CURRENT",
    shiftId: "morning",
    name: "Morning Shift",
    startTime: "11:00",
    endTime: "20:00",
    crossesMidnight: false,
  });
}

async function run() {
  emailCalls.length = 0;
  const ddb = createDdb(ACCESS_ROWS);
  seedMorning(ddb, "priya@mydgv.com");

  const first = await notifyScheduledShiftConflicts({
    ddb,
    accessTable: "access-table",
    tableName: "work-table",
    task: TASK,
    conflictEmails: ["priya@mydgv.com"],
    fitByEmail: { "priya@mydgv.com": ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT },
  });
  assert.deepStrictEqual(first.recipients.sort(), [
    "admin@mydgv.com",
    "super@mydgv.com",
  ]);
  const conflictMail = emailCalls.filter((call) =>
    /shift conflict/i.test(String(call.subject || ""))
  );
  assert.strictEqual(conflictMail.length, 2);
  assert.ok(conflictMail.some((call) => call.to === "super@mydgv.com"));
  assert.ok(conflictMail.some((call) => call.to === "admin@mydgv.com"));
  assert.ok(conflictMail.every((call) => call.from === "noreply@mydgv.com"));
  assert.ok(conflictMail.every((call) => /priya@mydgv.com/.test(call.text)));
  assert.ok(conflictMail.every((call) => /SHIFT_CONFLICT/.test(call.text)));
  assert.ok(conflictMail.every((call) => /Morning Shift/.test(call.text)));
  assert.ok(conflictMail.every((call) => /11:00/.test(call.text)));
  assert.ok(conflictMail.every((call) => /Edit or reassign/.test(call.text)));
  assert.ok(!emailCalls.some((call) => call.to === "priya@mydgv.com"));
  assert.ok(!emailCalls.some((call) => call.to === "lead@mydgv.com"));
  assert.ok(!emailCalls.some((call) => call.to === "oldsuper@mydgv.com"));
  assert.ok(
    ddb.items.some(
      (item) => item.type === TYPE_SHIFT_CONFLICT_EMAIL && item.status === "SENT"
    )
  );
  assert.ok(
    ddb.items.some(
      (item) => item.type === TYPE_SHIFT_CONFLICT && item.SK.startsWith("NOTIFY#")
    )
  );

  const second = await notifyScheduledShiftConflicts({
    ddb,
    accessTable: "access-table",
    tableName: "work-table",
    task: TASK,
    conflictEmails: ["priya@mydgv.com"],
    fitByEmail: { "priya@mydgv.com": ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT },
  });
  assert.strictEqual(
    emailCalls.filter((call) => /shift conflict/i.test(String(call.subject || ""))).length,
    2
  );
  assert.ok(second.results.every((row) => row.skipped || row.status === "SENT"));

  emailCalls.length = 0;
  const noShiftDdb = createDdb(ACCESS_ROWS);
  const noShift = await notifyScheduledShiftConflicts({
    ddb: noShiftDdb,
    accessTable: "access-table",
    tableName: "work-table",
    task: TASK,
    conflictEmails: ["rahul@mydgv.com"],
    fitByEmail: { "rahul@mydgv.com": ASSIGNED_SHIFT_FIT.NO_SHIFT },
  });
  assert.ok(noShift.recipients.includes("admin@mydgv.com"));
  assert.ok(noShift.recipients.includes("super@mydgv.com"));
  const noShiftMail = emailCalls.filter((call) =>
    /shift conflict/i.test(String(call.subject || ""))
  );
  assert.strictEqual(noShiftMail.length, 2);
  assert.ok(noShiftMail.every((call) => /NO_SHIFT/.test(call.text)));
  assert.ok(noShiftMail.every((call) => /Assigned shift: none/.test(call.text)));
  assert.ok(noShiftMail.every((call) => /rahul@mydgv.com/.test(call.text)));

  emailCalls.length = 0;
  const multi = createDdb(ACCESS_ROWS);
  seedMorning(multi, "priya@mydgv.com");
  await notifyScheduledShiftConflicts({
    ddb: multi,
    accessTable: "access-table",
    tableName: "work-table",
    task: TASK,
    conflictEmails: ["priya@mydgv.com", "rahul@mydgv.com"],
    fitByEmail: {
      "priya@mydgv.com": ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT,
      "rahul@mydgv.com": ASSIGNED_SHIFT_FIT.NO_SHIFT,
    },
  });
  assert.strictEqual(
    emailCalls.filter((call) => /priya@mydgv.com/.test(call.text)).length,
    2
  );
  assert.strictEqual(
    emailCalls.filter((call) => /rahul@mydgv.com/.test(call.text)).length,
    2
  );

  emailCalls.length = 0;
  const fitSkip = await notifyScheduledShiftConflicts({
    ddb: createDdb(ACCESS_ROWS),
    accessTable: "access-table",
    tableName: "work-table",
    task: TASK,
    conflictEmails: ["priya@mydgv.com"],
    fitByEmail: { "priya@mydgv.com": ASSIGNED_SHIFT_FIT.FIT },
  });
  assert.strictEqual(fitSkip.skipped, true);
  assert.strictEqual(emailCalls.length, 0);

  assert.ok(
    shiftConflictNotifyKey(
      "task-conflict-1",
      "priya@mydgv.com",
      "SHIFT_CONFLICT",
      TASK.startDate,
      TASK.dueDate
    ).includes("priya@mydgv.com")
  );

  console.log("taskScheduledShiftConflictNotify tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

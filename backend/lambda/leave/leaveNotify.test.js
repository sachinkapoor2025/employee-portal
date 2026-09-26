process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.WORK_TABLE = "work-table";
process.env.PORTAL_URL = "https://login.mydgv.com";
process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";

const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
const {
  TYPE_LEAVE_REQUESTED_EMAIL,
  TYPE_LEAVE_APPROVED_EMAIL,
  TYPE_LEAVE_REJECTED_EMAIL,
  adminLeaveUrl,
  employeeLeaveUrl,
  leaveRequestedEmailKey,
  leaveApprovedEmailKey,
  leaveRejectedEmailKey,
  leaveRequestedCopy,
  leaveApprovedCopy,
  leaveRejectedCopy,
  notifyLeaveRequested,
  notifyLeaveApproved,
  notifyLeaveRejected,
} = require("./leaveNotify");

const WORKER = "worker@mydgv.com";
const PRIYA = "priya@mydgv.com";
const SACHIN = "sachin@mydgv.com";
const BOSS = "boss@mydgv.com";

function createMemoryDdb() {
  const items = [];
  function keyOf(tableName, item) {
    return `${tableName}|${item.PK}|${item.SK}`;
  }
  return {
    items,
    seed(tableName, item) {
      const idx = items.findIndex(
        (row) => keyOf(row.TableName, row.Item) === keyOf(tableName, item)
      );
      const entry = { TableName: tableName, Item: { ...item } };
      if (idx >= 0) items[idx] = entry;
      else items.push(entry);
    },
    of(tableName) {
      return items
        .filter((row) => row.TableName === tableName)
        .map((row) => ({ ...row.Item }));
    },
    async send(command) {
      if (command instanceof GetCommand) {
        const { TableName, Key } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        return { Item: found ? { ...found.Item } : undefined };
      }
      if (command instanceof PutCommand) {
        this.seed(command.input.TableName, command.input.Item);
        return {};
      }
      if (command instanceof QueryCommand) {
        const { TableName, ExpressionAttributeValues = {} } = command.input;
        const pk = ExpressionAttributeValues[":pk"];
        const found = items
          .filter((row) => row.TableName === TableName && row.Item.PK === pk)
          .map((row) => ({ ...row.Item }));
        return { Items: found };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

const requested = leaveRequestedCopy({
  employeeName: "Pat Worker",
  employeeEmail: WORKER,
  leaveType: "CASUAL",
  startDate: "2026-10-05",
  endDate: "2026-10-06",
  days: 2,
  reason: "Family function",
  submittedAt: "2026-09-26T04:30:00.000Z",
  viewLeaveUrl: adminLeaveUrl(),
  timeZone: "Asia/Kolkata",
});
assert.strictEqual(requested.type, TYPE_LEAVE_REQUESTED_EMAIL);
assert.strictEqual(requested.subject, "Leave Request: Pat Worker");
assert.ok(requested.message.includes("Pat Worker"));
assert.ok(requested.message.includes("Casual Leave"));
assert.ok(requested.message.includes("Family function"));
assert.ok(requested.message.includes("5 October 2026"));
assert.ok(!requested.message.includes(WORKER));
assert.ok(!requested.message.includes("ENTITY#LEAVE"));
assert.ok(!requested.message.includes("LEAVE#"));
assert.ok(requested.html.includes("background:#b45309"));
assert.ok(requested.html.includes("REVIEW LEAVE"));
assert.ok(requested.html.includes("/admin/leave"));
assert.ok(!requested.html.includes("/admin/tasks/"));

const approved = leaveApprovedCopy({
  employeeName: "Pat Worker",
  employeeEmail: WORKER,
  leaveType: "SICK",
  startDate: "2026-10-05",
  endDate: "2026-10-05",
  days: 1,
  reason: "Fever",
  approvedByName: "Boss",
  approvedByEmail: BOSS,
  approvedAt: "2026-09-26T05:00:00.000Z",
  viewLeaveUrl: employeeLeaveUrl(),
});
assert.strictEqual(approved.type, TYPE_LEAVE_APPROVED_EMAIL);
assert.strictEqual(approved.subject, "Leave Approved: 5 October 2026");
assert.ok(approved.html.includes("background:#047857"));
assert.ok(approved.html.includes("VIEW LEAVE"));
assert.ok(approved.html.includes("/leave"));
assert.ok(!approved.html.includes("/admin/leave"));
assert.ok(approved.html.includes("Boss"));
assert.ok(!approved.html.includes(BOSS));

const rejected = leaveRejectedCopy({
  employeeName: "Pat Worker",
  employeeEmail: WORKER,
  leaveType: "EARNED",
  startDate: "2026-10-05",
  endDate: "2026-10-07",
  days: 3,
  rejectedByName: "Boss",
  rejectedByEmail: BOSS,
  rejectedAt: "2026-09-26T05:00:00.000Z",
  rejectionReason: "Coverage needed",
  viewLeaveUrl: employeeLeaveUrl(),
});
assert.strictEqual(rejected.type, TYPE_LEAVE_REJECTED_EMAIL);
assert.strictEqual(rejected.subject, "Leave Request Update: 5 October 2026");
assert.ok(rejected.html.includes("Coverage needed"));
assert.ok(rejected.html.includes("background:#b45309"));
assert.ok(!rejected.html.includes("ENTITY#LEAVE"));

const xss = leaveRequestedCopy({
  employeeName: '<script>x</script>',
  employeeEmail: WORKER,
  leaveType: "CASUAL",
  startDate: "2026-10-05",
  endDate: "2026-10-05",
  days: 1,
  reason: '<img src=x>',
  viewLeaveUrl: adminLeaveUrl(),
});
assert.ok(xss.html.includes("&lt;script&gt;x&lt;/script&gt;"));
assert.ok(!xss.html.includes("<script>x</script>"));

assert.strictEqual(
  leaveRequestedEmailKey("leave-1", "Priya@mydgv.com"),
  "leave-1#priya@mydgv.com#requested"
);
assert.strictEqual(
  leaveApprovedEmailKey("leave-1", "Worker@mydgv.com"),
  "leave-1#worker@mydgv.com#approved"
);
assert.strictEqual(
  leaveRejectedEmailKey("leave-1", "Worker@mydgv.com"),
  "leave-1#worker@mydgv.com#rejected"
);

function sampleLeave(extra = {}) {
  return {
    leaveId: "leave-1",
    email: WORKER,
    type: "CASUAL",
    fromDate: "2026-10-05",
    toDate: "2026-10-06",
    startDate: "2026-10-05",
    endDate: "2026-10-06",
    days: 2,
    reason: "Family function",
    submittedAt: "2026-09-26T04:30:00.000Z",
    ...extra,
  };
}

async function withMail(fn) {
  const orig = email.sendEmail;
  const mails = [];
  email.sendEmail = async (payload) => {
    mails.push(payload);
    return { ok: true, messageId: `ses-${payload.to}` };
  };
  try {
    return await fn(mails);
  } finally {
    email.sendEmail = orig;
  }
}

(async () => {
  await withMail(async (mails) => {
    const ddb = createMemoryDdb();
    const result = await notifyLeaveRequested({
      ddb,
      leave: sampleLeave(),
      employeeName: "Pat Worker",
      approverEmails: [PRIYA, SACHIN, PRIYA],
    });
    assert.strictEqual(result.status, "SENT");
    assert.deepStrictEqual(
      mails.map((mail) => mail.to).sort(),
      [PRIYA, SACHIN]
    );
    assert.ok(!mails.some((mail) => mail.to === WORKER));
    for (const mail of mails) {
      assert.strictEqual(mail.subject, "Leave Request: Pat Worker");
      assert.ok(mail.html.includes("/admin/leave"));
      assert.ok(mail.html.includes("Family function"));
      assert.ok(!mail.html.includes("ENTITY#LEAVE"));
    }
  });

  await withMail(async (mails) => {
    const ddb = createMemoryDdb();
    const leave = sampleLeave();
    await notifyLeaveRequested({
      ddb,
      leave,
      employeeName: "Pat Worker",
      approverEmails: [PRIYA],
    });
    const first = mails.length;
    assert.ok(first > 0);
    await notifyLeaveRequested({
      ddb,
      leave,
      employeeName: "Pat Worker",
      approverEmails: [PRIYA],
    });
    assert.strictEqual(mails.length, first);
  });

  await withMail(async (mails) => {
    const ddb = createMemoryDdb();
    const skipped = await notifyLeaveRequested({
      ddb,
      leave: { leaveId: "", email: WORKER },
      approverEmails: [PRIYA],
    });
    assert.strictEqual(skipped.skipped, true);
    assert.strictEqual(mails.length, 0);
  });

  await withMail(async (mails) => {
    const ddb = createMemoryDdb();
    const result = await notifyLeaveApproved({
      ddb,
      leave: sampleLeave({
        approvedBy: BOSS,
        approvedAt: "2026-09-26T05:00:00.000Z",
      }),
      employeeName: "Pat Worker",
      approvedByName: "Boss",
    });
    assert.strictEqual(result.status, "SENT");
    assert.deepStrictEqual(
      mails.map((mail) => mail.to),
      [WORKER]
    );
    assert.ok(mails[0].html.includes("Leave approved"));
    assert.ok(mails[0].html.includes("/leave"));
    assert.ok(!mails[0].html.includes("/admin/leave"));
  });

  await withMail(async (mails) => {
    const ddb = createMemoryDdb();
    const result = await notifyLeaveRejected({
      ddb,
      leave: sampleLeave({
        rejectedBy: BOSS,
        rejectedAt: "2026-09-26T05:00:00.000Z",
        rejectionReason: "Coverage needed",
      }),
      employeeName: "Pat Worker",
      rejectedByName: "Boss",
    });
    assert.strictEqual(result.status, "SENT");
    assert.strictEqual(mails[0].to, WORKER);
    assert.ok(mails[0].html.includes("Coverage needed"));
    assert.ok(mails[0].subject.startsWith("Leave Request Update:"));
  });

  const orig = email.sendEmail;
  email.sendEmail = async () => ({ ok: false, error: "MessageRejected" });
  try {
    const ddb = createMemoryDdb();
    const failed = await notifyLeaveRequested({
      ddb,
      leave: sampleLeave({ leaveId: "leave-fail" }),
      approverEmails: [PRIYA],
    });
    assert.strictEqual(failed.status, "FAILED");
  } finally {
    email.sendEmail = orig;
  }

  console.log("leave notify tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

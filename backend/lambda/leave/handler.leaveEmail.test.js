process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.ATTENDANCE_TABLE = "Attendance";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.WORK_TABLE = "WorkTasks";
process.env.AWS_REGION = "ap-south-1";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.PORTAL_URL = "https://login.mydgv.com";
process.env.NOTIFICATION_FROM_EMAIL = "noreply@mydgv.com";
process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";
process.env.LEAVE_APPROVER_EMAILS = "priya@mydgv.com,sachin@mydgv.com";
process.env.LEAVE_APPROVAL_HOURS = "5";

const assert = require("assert");
const email = require("../common/email");
email.sendEmail = async () => ({ ok: true, messageId: "ses-test" });
const {
  handler,
  setDocumentClientForTests,
  setNowMsForTests,
} = require("./handler");

const WORKER = "worker@mydgv.com";
const PRIYA = "priya@mydgv.com";
const SACHIN = "sachin@mydgv.com";
const BOSS = "boss@mydgv.com";
const FROM = "2026-10-05";
const TO = "2026-10-06";

function createFakeDdb({ access = {}, profiles = {}, work = {} } = {}) {
  const puts = [];
  const workStore = { ...work };
  return {
    puts,
    workStore,
    send: async (cmd) => {
      const input = cmd.input || {};
      const table = input.TableName;
      if (input.Item) {
        puts.push({ table, item: input.Item });
        workStore[`${input.Item.PK}|${input.Item.SK}`] = { ...input.Item };
        return {};
      }
      if (input.KeyConditionExpression) {
        const pk = input.ExpressionAttributeValues?.[":pk"];
        const skPrefix = input.ExpressionAttributeValues?.[":sk"];
        return {
          Items: Object.values(workStore).filter((row) => {
            if (row.PK !== pk) return false;
            if (skPrefix) return String(row.SK || "").startsWith(skPrefix);
            return true;
          }),
        };
      }
      if (input.Key) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        if (table === process.env.USER_ACCESS_TABLE) {
          return { Item: access[input.Key.PK] || null };
        }
        if (table === process.env.USER_PROFILE_TABLE) {
          return {
            Item:
              profiles[input.Key.PK] || {
                name: "Pat Worker",
                empId: "E1",
              },
          };
        }
        return { Item: workStore[key] || null };
      }
      return { Items: [] };
    },
  };
}

function seedLeave(db, item) {
  const entity = { PK: "ENTITY#LEAVE", SK: `LEAVE#${item.leaveId}`, ...item };
  db.workStore[`${entity.PK}|${entity.SK}`] = entity;
  db.workStore[`USER#${item.email}|LEAVE#${item.leaveId}`] = {
    ...entity,
    PK: `USER#${item.email}`,
    SK: `LEAVE#${item.leaveId}`,
  };
  return entity;
}

function eventFor(method, emailAddr, body, groups = []) {
  return {
    path: "/leave",
    httpMethod: method,
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: { email: emailAddr, "cognito:groups": groups },
      },
    },
  };
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function freeze(iso) {
  setNowMsForTests(() => Date.parse(iso));
}

function notifyItems(db, type) {
  return db.puts
    .filter((row) => String(row.item?.SK || "").startsWith("NOTIFY#"))
    .map((row) => row.item)
    .filter((item) => !type || item.type === type);
}

function reminderItems(db, type) {
  return db.puts
    .filter((row) => String(row.item?.SK || "").startsWith("REMINDER#"))
    .map((row) => row.item)
    .filter((item) => !type || item.type === type);
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

let passed = 0;
async function test(name, fn) {
  await Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    });
}

(async () => {
  freeze("2026-09-26T10:00:00+05:30");

  await test("successful leave submission sends email to existing approvers", async () => {
    await withMail(async (mails) => {
      const db = createFakeDdb({
        access: { [WORKER]: { role: "EMPLOYEE", status: "ACTIVE" } },
      });
      setDocumentClientForTests(db);
      const res = parse(
        await handler(
          eventFor("POST", WORKER, {
            category: "LEAVE",
            type: "CASUAL",
            fromDate: FROM,
            toDate: TO,
            reason: "Family function",
          })
        )
      );
      assert.strictEqual(res.statusCode, 201, res.body.error);
      assert.strictEqual(res.body.status, "PENDING_APPROVAL");
      assert.deepStrictEqual(
        mails.map((mail) => mail.to).sort(),
        [PRIYA, SACHIN]
      );
      assert.ok(!mails.some((mail) => mail.to === WORKER));
      for (const mail of mails) {
        assert.ok(mail.subject.startsWith("Leave Request:"));
        assert.ok(mail.html.includes("Pat Worker"));
        assert.ok(mail.html.includes("Family function"));
        assert.ok(mail.html.includes("/admin/leave"));
        assert.ok(mail.html.includes("REVIEW LEAVE"));
        assert.ok(!mail.html.includes("ENTITY#LEAVE"));
        assert.ok(!mail.html.includes(`LEAVE#${res.body.leaveId}`));
      }
      const inApp = notifyItems(db, "LEAVE_SUBMITTED");
      assert.ok(inApp.length >= 2);
      assert.ok(inApp.every((n) => n.type === "LEAVE_SUBMITTED"));
      assert.ok(inApp.some((n) => n.email === PRIYA));
      assert.ok(inApp.some((n) => n.email === SACHIN));
      assert.ok(reminderItems(db, "LEAVE_REQUESTED_EMAIL").length >= 2);
    });
  });

  await test("invalid leave submission sends no email", async () => {
    await withMail(async (mails) => {
      const db = createFakeDdb();
      setDocumentClientForTests(db);
      const res = parse(
        await handler(
          eventFor("POST", WORKER, {
            category: "LEAVE",
            type: "CASUAL",
            fromDate: "not-a-date",
            toDate: "also-bad",
            reason: "Nope",
          })
        )
      );
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(mails.length, 0);
      assert.strictEqual(notifyItems(db, "LEAVE_SUBMITTED").length, 0);
      assert.strictEqual(reminderItems(db, "LEAVE_REQUESTED_EMAIL").length, 0);
    });
  });

  await test("duplicate leave requested email is skipped by reminder dedup", async () => {
    await withMail(async (mails) => {
      const db = createFakeDdb({
        access: { [WORKER]: { role: "EMPLOYEE", status: "ACTIVE" } },
      });
      setDocumentClientForTests(db);
      const first = parse(
        await handler(
          eventFor("POST", WORKER, {
            category: "LEAVE",
            type: "SICK",
            fromDate: FROM,
            toDate: FROM,
            reason: "Fever",
          })
        )
      );
      assert.strictEqual(first.statusCode, 201, first.body.error);
      const afterFirst = mails.length;
      assert.ok(afterFirst > 0);
      const { notifyLeaveRequested } = require("./leaveNotify");
      await notifyLeaveRequested({
        ddb: db,
        leave: first.body,
        employeeName: "Pat Worker",
        approverEmails: [PRIYA, SACHIN],
      });
      assert.strictEqual(mails.length, afterFirst);
    });
  });

  await test("SES failure does not fail leave submission and in-app remains", async () => {
    const orig = email.sendEmail;
    email.sendEmail = async () => ({ ok: false, error: "MessageRejected" });
    try {
      const db = createFakeDdb({
        access: { [WORKER]: { role: "EMPLOYEE", status: "ACTIVE" } },
      });
      setDocumentClientForTests(db);
      const res = parse(
        await handler(
          eventFor("POST", WORKER, {
            category: "LEAVE",
            type: "CASUAL",
            fromDate: FROM,
            toDate: FROM,
            reason: "Need off",
          })
        )
      );
      assert.strictEqual(res.statusCode, 201, res.body.error);
      assert.strictEqual(res.body.status, "PENDING_APPROVAL");
      const inApp = notifyItems(db, "LEAVE_SUBMITTED");
      assert.ok(inApp.length >= 2);
    } finally {
      email.sendEmail = orig;
    }
  });

  await test("planned off does not send leave request email", async () => {
    await withMail(async (mails) => {
      const db = createFakeDdb({
        access: { [WORKER]: { role: "EMPLOYEE", status: "ACTIVE" } },
      });
      setDocumentClientForTests(db);
      const res = parse(
        await handler(
          eventFor("POST", WORKER, {
            category: "PLANNED_OFF",
            type: "PLANNED_OFF",
            fromDate: FROM,
            toDate: FROM,
            reason: "Week off",
          })
        )
      );
      assert.strictEqual(res.statusCode, 201, res.body.error);
      assert.strictEqual(res.body.status, "PLANNED_OFF");
      assert.strictEqual(mails.length, 0);
      assert.strictEqual(notifyItems(db, "LEAVE_SUBMITTED").length, 0);
    });
  });

  await test("successful approval emails the employee", async () => {
    await withMail(async (mails) => {
      const db = createFakeDdb({
        access: { [WORKER]: { role: "EMPLOYEE", status: "ACTIVE" } },
        profiles: {
          [`USER#${WORKER}`]: { name: "Pat Worker", empId: "E1" },
          [`USER#${BOSS}`]: { name: "Boss Admin", empId: "A1" },
        },
      });
      seedLeave(db, {
        leaveId: "leave-approve-1",
        email: WORKER,
        category: "LEAVE",
        type: "CASUAL",
        fromDate: FROM,
        toDate: TO,
        startDate: FROM,
        endDate: TO,
        days: 2,
        reason: "Family function",
        status: "PENDING_APPROVAL",
        submittedAt: "2026-09-26T04:30:00.000Z",
        approvalDeadline: "2026-09-26T15:00:00.000Z",
      });
      setDocumentClientForTests(db);
      const res = parse(
        await handler(
          eventFor(
            "PUT",
            BOSS,
            { leaveId: "leave-approve-1", status: "APPROVED" },
            ["Admin"]
          )
        )
      );
      assert.strictEqual(res.statusCode, 200, res.body.error);
      assert.strictEqual(res.body.status, "APPROVED");
      const leaveMails = mails.filter((mail) =>
        String(mail.subject || "").startsWith("Leave Approved:")
      );
      assert.strictEqual(leaveMails.length, 1);
      assert.strictEqual(leaveMails[0].to, WORKER);
      assert.ok(leaveMails[0].html.includes("Pat Worker"));
      assert.ok(leaveMails[0].html.includes("Boss Admin"));
      assert.ok(leaveMails[0].html.includes("Family function"));
      assert.ok(leaveMails[0].html.includes("/leave"));
      const inApp = notifyItems(db, "LEAVE_APPROVED");
      assert.ok(inApp.some((n) => n.email === WORKER));
    });
  });

  await test("approval SES failure is nonfatal", async () => {
    const orig = email.sendEmail;
    email.sendEmail = async () => ({ ok: false, error: "MessageRejected" });
    try {
      const db = createFakeDdb({
        access: { [WORKER]: { role: "EMPLOYEE", status: "ACTIVE" } },
      });
      seedLeave(db, {
        leaveId: "leave-approve-fail",
        email: WORKER,
        category: "LEAVE",
        type: "CASUAL",
        fromDate: FROM,
        toDate: FROM,
        status: "PENDING_APPROVAL",
        approvalDeadline: "2026-09-26T15:00:00.000Z",
      });
      setDocumentClientForTests(db);
      const res = parse(
        await handler(
          eventFor(
            "PUT",
            BOSS,
            { leaveId: "leave-approve-fail", status: "APPROVED" },
            ["Admin"]
          )
        )
      );
      assert.strictEqual(res.statusCode, 200, res.body.error);
      assert.strictEqual(res.body.status, "APPROVED");
      assert.ok(notifyItems(db, "LEAVE_APPROVED").some((n) => n.email === WORKER));
    } finally {
      email.sendEmail = orig;
    }
  });

  await test("successful rejection emails the employee with remark", async () => {
    await withMail(async (mails) => {
      const db = createFakeDdb({
        access: { [WORKER]: { role: "EMPLOYEE", status: "ACTIVE" } },
        profiles: {
          [`USER#${WORKER}`]: { name: "Pat Worker", empId: "E1" },
          [`USER#${BOSS}`]: { name: "Boss Admin", empId: "A1" },
        },
      });
      seedLeave(db, {
        leaveId: "leave-reject-1",
        email: WORKER,
        category: "LEAVE",
        type: "SICK",
        fromDate: FROM,
        toDate: FROM,
        startDate: FROM,
        endDate: FROM,
        days: 1,
        status: "PENDING_APPROVAL",
        approvalDeadline: "2026-09-26T15:00:00.000Z",
      });
      setDocumentClientForTests(db);
      const res = parse(
        await handler(
          eventFor(
            "PUT",
            BOSS,
            {
              leaveId: "leave-reject-1",
              status: "REJECTED",
              rejectionReason: "Coverage needed",
            },
            ["Admin"]
          )
        )
      );
      assert.strictEqual(res.statusCode, 200, res.body.error);
      assert.strictEqual(res.body.status, "REJECTED");
      const leaveMails = mails.filter((mail) =>
        String(mail.subject || "").startsWith("Leave Request Update:")
      );
      assert.strictEqual(leaveMails.length, 1);
      assert.strictEqual(leaveMails[0].to, WORKER);
      assert.ok(leaveMails[0].html.includes("Coverage needed"));
      assert.ok(leaveMails[0].html.includes("Boss Admin"));
      assert.ok(notifyItems(db, "LEAVE_REJECTED").some((n) => n.email === WORKER));
    });
  });

  await test("rejection SES failure is nonfatal", async () => {
    const orig = email.sendEmail;
    email.sendEmail = async () => ({ ok: false, error: "MessageRejected" });
    try {
      const db = createFakeDdb({
        access: { [WORKER]: { role: "EMPLOYEE", status: "ACTIVE" } },
      });
      seedLeave(db, {
        leaveId: "leave-reject-fail",
        email: WORKER,
        category: "LEAVE",
        type: "CASUAL",
        fromDate: FROM,
        toDate: FROM,
        status: "PENDING_APPROVAL",
        approvalDeadline: "2026-09-26T15:00:00.000Z",
      });
      setDocumentClientForTests(db);
      const res = parse(
        await handler(
          eventFor(
            "PUT",
            BOSS,
            {
              leaveId: "leave-reject-fail",
              status: "REJECTED",
              rejectionReason: "No",
            },
            ["Admin"]
          )
        )
      );
      assert.strictEqual(res.statusCode, 200, res.body.error);
      assert.strictEqual(res.body.status, "REJECTED");
    } finally {
      email.sendEmail = orig;
    }
  });

  await test("already reviewed leave does not send another email", async () => {
    await withMail(async (mails) => {
      const db = createFakeDdb({
        access: { [WORKER]: { role: "EMPLOYEE", status: "ACTIVE" } },
      });
      seedLeave(db, {
        leaveId: "leave-already",
        email: WORKER,
        category: "LEAVE",
        type: "CASUAL",
        fromDate: FROM,
        toDate: FROM,
        status: "APPROVED",
        approvedBy: BOSS,
        approvedAt: "2026-09-26T05:00:00.000Z",
      });
      setDocumentClientForTests(db);
      const res = parse(
        await handler(
          eventFor(
            "PUT",
            BOSS,
            { leaveId: "leave-already", status: "APPROVED" },
            ["Admin"]
          )
        )
      );
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(mails.length, 0);
    });
  });

  setNowMsForTests(null);
  console.log(`\n${passed} tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

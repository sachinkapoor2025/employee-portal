process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.WORK_TABLE = "work-table";
process.env.USER_ACCESS_TABLE = "access-table";
process.env.PORTAL_URL = "https://login.mydgv.com";
process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";

const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
email.sendEmail = async () => ({ ok: true, messageId: "ses-test" });

const {
  TYPE_BLOCKER_REPORTED,
  TYPE_BLOCKER_REPORTED_EMAIL,
  ADMIN_BLOCKERS_PATH,
  blockerNotifyKey,
  blockerReportedEmailKey,
  adminTaskUrl,
  blockerReportedCopy,
  notifyBlockerReported,
} = require("./taskBlockerNotify");
const { TASK_IN_APP_ONLY_TYPES, resolveChannels } = require("../common/notify");
const { activeCompletionAdminEmailsFromAccess } = require("../common/roles");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const ADMIN = "admin@mydgv.com";
const SUPER = "super@mydgv.com";
const MANAGER = "manager@mydgv.com";
const PA = "pa@mydgv.com";
const ANKIT = "ankit@mydgv.com";
const PRIYA = "priya@mydgv.com";
const PROJECT_ID = "proj-open";
const REST_PROJECT_ID = "proj-restricted";
const TASK_ID = "task-seo";

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
      return items.filter((row) => row.TableName === tableName).map((row) => ({ ...row.Item }));
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
        const skPrefix = ExpressionAttributeValues[":sk"];
        const found = items
          .filter((row) => row.TableName === TableName && row.Item.PK === pk)
          .filter((row) =>
            skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true
          )
          .map((row) => ({ ...row.Item }));
        return { Items: found };
      }
      if (command instanceof ScanCommand) {
        const { TableName } = command.input;
        return {
          Items: items
            .filter((row) => row.TableName === TableName)
            .map((row) => ({ ...row.Item })),
        };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function seedAccess(ddb, email, role = "EMPLOYEE", status = "ACTIVE") {
  ddb.seed(ACCESS, { PK: email, SK: email, email, role, status });
}

function seedOpenProject(ddb) {
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${PROJECT_ID}`,
    projectId: PROJECT_ID,
    name: "Open project",
    status: "ACTIVE",
    accessMode: "OPEN",
  });
}

function seedRestrictedProject(ddb) {
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${REST_PROJECT_ID}`,
    projectId: REST_PROJECT_ID,
    name: "Restricted project",
    status: "ACTIVE",
    accessMode: "RESTRICTED",
  });
  ddb.seed(WORK, {
    PK: `PROJECT#${REST_PROJECT_ID}`,
    SK: `PROJECT_ADMIN#${PA}`,
    type: "PROJECT_ADMIN",
    projectId: REST_PROJECT_ID,
    email: PA,
    status: "ACTIVE",
    taskVisibility: "ALL_PROJECT_TASKS",
  });
}

function notifyItems(ddb) {
  return ddb
    .of(WORK)
    .filter(
      (item) =>
        String(item.SK || "").startsWith("NOTIFY#") &&
        item.type === TYPE_BLOCKER_REPORTED
    );
}

function reminderItems(ddb) {
  return ddb
    .of(WORK)
    .filter(
      (item) =>
        String(item.SK || "").startsWith("REMINDER#") &&
        item.type === TYPE_BLOCKER_REPORTED_EMAIL
    );
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

async function run() {
  await test("TASK_BLOCKER_REPORTED is a dedicated in-app-only type", () => {
    assert.ok(TASK_IN_APP_ONLY_TYPES.has(TYPE_BLOCKER_REPORTED));
    assert.notStrictEqual(TYPE_BLOCKER_REPORTED, "TASK_RED");
    assert.notStrictEqual(TYPE_BLOCKER_REPORTED, "TASK_RED_ADMIN");
    assert.notStrictEqual(TYPE_BLOCKER_REPORTED, "TASK_COMPLETED");
    assert.notStrictEqual(TYPE_BLOCKER_REPORTED, "TASK_ASSIGNED");
    assert.deepStrictEqual(resolveChannels({ type: TYPE_BLOCKER_REPORTED }), {
      emailEnabled: false,
      inAppEnabled: true,
    });
    assert.ok(!TASK_IN_APP_ONLY_TYPES.has(TYPE_BLOCKER_REPORTED_EMAIL));
    assert.deepStrictEqual(
      resolveChannels({ type: TYPE_BLOCKER_REPORTED_EMAIL, channel: "email" }),
      { emailEnabled: true, inAppEnabled: false }
    );
  });

  await test("blocker reported copy uses urgent layout and admin task CTA", () => {
    const copy = blockerReportedCopy({
      title: "Create SEO report",
      projectName: "Open project",
      priority: "HIGH",
      category: "Marketing",
      employeeName: "Ankit Kumar",
      employeeEmail: ANKIT,
      startDate: "2099-12-31T18:00:00+05:30",
      dueDate: "2099-12-31T20:00:00+05:30",
      blockerRemark: "Waiting for client credentials",
      reportedAt: "2026-09-25T10:00:00.000Z",
      viewTaskUrl: adminTaskUrl(TASK_ID),
      timeZone: "Asia/Kolkata",
    });
    assert.strictEqual(copy.type, TYPE_BLOCKER_REPORTED_EMAIL);
    assert.strictEqual(copy.subject, "Task Blocker Reported: Create SEO report");
    assert.ok(copy.message.includes("Ankit Kumar"));
    assert.ok(copy.message.includes("Waiting for client credentials"));
    assert.ok(copy.message.includes("Admin action may be required"));
    assert.ok(!copy.message.includes(ANKIT));
    assert.ok(!copy.message.includes("ENTITY#TASK"));
    assert.ok(!copy.message.includes("ASSIGNMENT#"));
    assert.ok(copy.html.includes("font-family:Arial,sans-serif"));
    assert.ok(copy.html.includes("background:#991b1b"));
    assert.ok(copy.html.includes("VIEW TASK"));
    assert.ok(copy.html.includes(`/admin/tasks/${TASK_ID}`));
    assert.ok(!copy.html.includes("/admin/blockers"));
    assert.ok(!copy.html.includes("sourceTaskId"));
    assert.ok(!copy.html.includes("PK#"));
  });

  await test("blocker reported copy escapes dynamic HTML values", () => {
    const xss = blockerReportedCopy({
      title: '<script>x</script>',
      projectName: '<b>proj</b>',
      employeeName: '<img src=x>',
      employeeEmail: ANKIT,
      blockerRemark: '<script>alert(1)</script>',
      viewTaskUrl: "https://login.mydgv.com/admin/tasks/task-seo",
    });
    assert.ok(xss.html.includes("&lt;script&gt;x&lt;/script&gt;"));
    assert.ok(xss.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!xss.html.includes("<script>x</script>"));
  });

  await test("email dedup key is per task, assignment, and recipient", () => {
    const key = blockerReportedEmailKey(TASK_ID, "Ankit@mydgv.com", "Admin@mydgv.com");
    assert.strictEqual(
      key,
      `${TASK_ID}#${ANKIT}#${ADMIN}#blocker-reported`
    );
    assert.notStrictEqual(
      blockerReportedEmailKey(TASK_ID, ANKIT, ADMIN),
      blockerReportedEmailKey(TASK_ID, PRIYA, ADMIN)
    );
    assert.notStrictEqual(
      blockerReportedEmailKey(TASK_ID, ANKIT, ADMIN),
      blockerReportedEmailKey(TASK_ID, ANKIT, SUPER)
    );
  });

  await test("recipient resolution includes ADMIN and SUPER_ADMIN, excludes MANAGER", () => {
    const emails = activeCompletionAdminEmailsFromAccess([
      { email: ADMIN, role: "ADMIN", status: "ACTIVE" },
      { email: SUPER, role: "SUPER_ADMIN", status: "ACTIVE" },
      { email: MANAGER, role: "MANAGER", status: "ACTIVE" },
      { email: ANKIT, role: "EMPLOYEE", status: "ACTIVE" },
      { email: "gone@mydgv.com", role: "ADMIN", status: "INACTIVE" },
    ]);
    assert.ok(emails.includes(ADMIN));
    assert.ok(emails.includes(SUPER));
    assert.ok(!emails.includes(MANAGER));
    assert.ok(!emails.includes(ANKIT));
    assert.ok(!emails.includes("gone@mydgv.com"));
  });

  await test("OPEN project notifies portal ADMIN and SUPER_ADMIN with assignment identity", async () => {
    const ddb = createMemoryDdb();
    seedOpenProject(ddb);
    seedAccess(ddb, ADMIN, "ADMIN");
    seedAccess(ddb, SUPER, "SUPER_ADMIN");
    seedAccess(ddb, MANAGER, "MANAGER");
    seedAccess(ddb, ANKIT);
    seedAccess(ddb, PRIYA);
    const reportedAt = "2026-09-25T10:00:00.000Z";
    const result = await notifyBlockerReported({
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      task: {
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        title: "Create SEO report",
      },
      assignmentEmail: ANKIT,
      remark: "Waiting for client credentials",
      reportedAt,
    });
    assert.strictEqual(result.skipped, false);
    assert.ok(result.recipients.includes(ADMIN));
    assert.ok(result.recipients.includes(SUPER));
    assert.ok(!result.recipients.includes(MANAGER));
    assert.ok(!result.recipients.includes(ANKIT));
    const notified = notifyItems(ddb);
    assert.strictEqual(notified.length, result.recipients.length);
    assert.ok(notified.some((n) => n.email === ADMIN));
    assert.ok(notified.some((n) => n.email === SUPER));
    for (const n of notified) {
      assert.strictEqual(n.type, TYPE_BLOCKER_REPORTED);
      assert.strictEqual(n.title, "Task Blocker Reported");
      assert.strictEqual(
        n.message,
        'Ankit reported a blocker on "Create SEO report".'
      );
      assert.ok(!/task is blocked/i.test(n.message));
      assert.strictEqual(n.taskId, TASK_ID);
      assert.strictEqual(n.assignmentEmail, ANKIT);
      assert.strictEqual(n.taskTitle, "Create SEO report");
      assert.strictEqual(n.blockerRemark, "Waiting for client credentials");
      assert.strictEqual(n.path, ADMIN_BLOCKERS_PATH);
      assert.strictEqual(n.path, "/admin/blockers");
    }
  });

  await test("RESTRICTED project uses existing project-admin recipient lookup", async () => {
    const ddb = createMemoryDdb();
    seedRestrictedProject(ddb);
    seedAccess(ddb, ADMIN, "ADMIN");
    seedAccess(ddb, SUPER, "SUPER_ADMIN");
    seedAccess(ddb, PA, "EMPLOYEE");
    seedAccess(ddb, ANKIT);
    const result = await notifyBlockerReported({
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      task: {
        taskId: TASK_ID,
        projectId: REST_PROJECT_ID,
        title: "Restricted task",
      },
      assignmentEmail: ANKIT,
      remark: "Need access",
      reportedAt: "2026-09-25T11:00:00.000Z",
    });
    assert.strictEqual(result.skipped, false);
    assert.deepStrictEqual(result.recipients, [PA]);
    const notified = notifyItems(ddb);
    assert.strictEqual(notified.length, 1);
    assert.strictEqual(notified[0].email, PA);
    assert.strictEqual(notified[0].assignmentEmail, ANKIT);
  });

  await test("invalid input skips without writing", async () => {
    const ddb = createMemoryDdb();
    const result = await notifyBlockerReported({
      ddb,
      task: { taskId: "" },
      assignmentEmail: ANKIT,
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(notifyItems(ddb).length, 0);
  });

  await test("dispatch failure is best-effort and does not throw", async () => {
    const ddb = createMemoryDdb();
    seedOpenProject(ddb);
    seedAccess(ddb, ADMIN, "ADMIN");
    const orig = ddb.send.bind(ddb);
    ddb.send = async (command) => {
      if (command instanceof ScanCommand) throw new Error("scan down");
      return orig(command);
    };
    const result = await notifyBlockerReported({
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      task: { taskId: TASK_ID, projectId: PROJECT_ID, title: "Task" },
      assignmentEmail: ANKIT,
      remark: "Stuck",
      reportedAt: "2026-09-25T12:00:00.000Z",
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "NOTIFY_FAILED");
    assert.strictEqual(notifyItems(ddb).length, 0);
  });

  await test("repeat cycles use distinct dedup keys so Cycle B can notify", () => {
    const a = blockerNotifyKey(TASK_ID, ANKIT, "2026-09-25T10:00:00.000Z");
    const b = blockerNotifyKey(TASK_ID, ANKIT, "2026-09-26T10:00:00.000Z");
    assert.notStrictEqual(a, b);
    assert.ok(a.includes("blocker-reported"));
  });

  await test("Cycle B writes a new in-app item after Cycle A", async () => {
    const ddb = createMemoryDdb();
    seedOpenProject(ddb);
    seedAccess(ddb, ADMIN, "ADMIN");
    seedAccess(ddb, ANKIT);
    await notifyBlockerReported({
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      task: { taskId: TASK_ID, projectId: PROJECT_ID, title: "Create SEO report" },
      assignmentEmail: ANKIT,
      remark: "Cycle A",
      reportedAt: "2026-09-25T10:00:00.000Z",
    });
    const afterA = notifyItems(ddb);
    assert.ok(afterA.length > 0);
    await notifyBlockerReported({
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      task: { taskId: TASK_ID, projectId: PROJECT_ID, title: "Create SEO report" },
      assignmentEmail: ANKIT,
      remark: "Cycle B",
      reportedAt: "2026-09-26T10:00:00.000Z",
    });
    const all = notifyItems(ddb);
    assert.ok(all.length > afterA.length);
    assert.ok(all.some((n) => n.blockerRemark === "Cycle A"));
    assert.ok(all.some((n) => n.blockerRemark === "Cycle B"));
  });

  await test("OPEN project sends blocker email to ADMIN and SUPER_ADMIN", async () => {
    await withMail(async (mails) => {
      const ddb = createMemoryDdb();
      seedOpenProject(ddb);
      seedAccess(ddb, ADMIN, "ADMIN");
      seedAccess(ddb, SUPER, "SUPER_ADMIN");
      seedAccess(ddb, MANAGER, "MANAGER");
      seedAccess(ddb, ANKIT);
      const result = await notifyBlockerReported({
        ddb,
        tableName: WORK,
        accessTable: ACCESS,
        task: {
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          title: "Create SEO report",
          priority: "HIGH",
          category: "Marketing",
          startDate: "2099-12-31T18:00:00+05:30",
          dueDate: "2099-12-31T20:00:00+05:30",
        },
        assignmentEmail: ANKIT,
        employeeName: "Ankit Kumar",
        remark: "Waiting for client credentials",
        reportedAt: "2026-09-25T10:00:00.000Z",
        projectName: "Open project",
      });
      assert.strictEqual(result.skipped, false);
      assert.strictEqual(result.email.status, "SENT");
      assert.deepStrictEqual(
        mails.map((mail) => mail.to).sort(),
        [ADMIN, SUPER]
      );
      assert.ok(!mails.some((mail) => mail.to === ANKIT));
      assert.ok(!mails.some((mail) => mail.to === MANAGER));
      for (const mail of mails) {
        assert.strictEqual(
          mail.subject,
          "Task Blocker Reported: Create SEO report"
        );
        assert.ok(mail.html.includes("Ankit Kumar"));
        assert.ok(mail.html.includes("Waiting for client credentials"));
        assert.ok(mail.html.includes("Admin action may be required"));
        assert.ok(mail.html.includes(`/admin/tasks/${TASK_ID}`));
        assert.ok(mail.html.includes("background:#991b1b"));
        assert.ok(!mail.html.includes("/admin/blockers"));
        assert.ok(!mail.html.includes(ANKIT));
        assert.ok(!mail.text.includes("ENTITY#TASK"));
      }
      const inApp = notifyItems(ddb);
      assert.ok(inApp.length > 0);
      assert.ok(inApp.every((n) => n.path === ADMIN_BLOCKERS_PATH));
      assert.ok(reminderItems(ddb).length >= 2);
    });
  });

  await test("RESTRICTED project sends blocker email to project admins only", async () => {
    await withMail(async (mails) => {
      const ddb = createMemoryDdb();
      seedRestrictedProject(ddb);
      seedAccess(ddb, ADMIN, "ADMIN");
      seedAccess(ddb, SUPER, "SUPER_ADMIN");
      seedAccess(ddb, PA, "EMPLOYEE");
      seedAccess(ddb, ANKIT);
      await notifyBlockerReported({
        ddb,
        tableName: WORK,
        accessTable: ACCESS,
        task: {
          taskId: TASK_ID,
          projectId: REST_PROJECT_ID,
          title: "Restricted task",
        },
        assignmentEmail: ANKIT,
        remark: "Need access",
        reportedAt: "2026-09-25T11:00:00.000Z",
        projectName: "Restricted project",
      });
      assert.deepStrictEqual(
        mails.map((mail) => mail.to),
        [PA]
      );
      assert.ok(mails[0].html.includes("Ankit"));
      assert.ok(mails[0].html.includes("Need access"));
    });
  });

  await test("email identifies the exact reporting assignment, not another assignee", async () => {
    await withMail(async (mails) => {
      const ddb = createMemoryDdb();
      seedOpenProject(ddb);
      seedAccess(ddb, ADMIN, "ADMIN");
      seedAccess(ddb, ANKIT);
      seedAccess(ddb, PRIYA);
      await notifyBlockerReported({
        ddb,
        tableName: WORK,
        accessTable: ACCESS,
        task: {
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          title: "Shared banner",
        },
        assignmentEmail: PRIYA,
        remark: "Priya is blocked",
        reportedAt: "2026-09-25T12:00:00.000Z",
      });
      assert.ok(mails.length > 0);
      for (const mail of mails) {
        assert.ok(mail.html.includes("Priya"));
        assert.ok(mail.text.includes("Priya"));
        assert.ok(mail.html.includes("Priya is blocked"));
        assert.ok(!/Ankit reported/i.test(mail.html));
      }
      assert.ok(notifyItems(ddb).every((n) => n.assignmentEmail === PRIYA));
    });
  });

  await test("duplicate email dispatch is skipped by reminder dedup", async () => {
    await withMail(async (mails) => {
      const ddb = createMemoryDdb();
      seedOpenProject(ddb);
      seedAccess(ddb, ADMIN, "ADMIN");
      seedAccess(ddb, ANKIT);
      const args = {
        ddb,
        tableName: WORK,
        accessTable: ACCESS,
        task: {
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          title: "Create SEO report",
        },
        assignmentEmail: ANKIT,
        remark: "Waiting",
        reportedAt: "2026-09-25T10:00:00.000Z",
      };
      await notifyBlockerReported(args);
      const firstCount = mails.length;
      assert.ok(firstCount > 0);
      await notifyBlockerReported(args);
      assert.strictEqual(mails.length, firstCount);
    });
  });

  await test("email send failure is nonfatal and in-app still writes", async () => {
    const orig = email.sendEmail;
    email.sendEmail = async () => ({ ok: false, error: "MessageRejected" });
    try {
      const ddb = createMemoryDdb();
      seedOpenProject(ddb);
      seedAccess(ddb, ADMIN, "ADMIN");
      seedAccess(ddb, ANKIT);
      const result = await notifyBlockerReported({
        ddb,
        tableName: WORK,
        accessTable: ACCESS,
        task: { taskId: TASK_ID, projectId: PROJECT_ID, title: "Task" },
        assignmentEmail: ANKIT,
        remark: "Stuck",
        reportedAt: "2026-09-25T12:00:00.000Z",
      });
      assert.strictEqual(result.skipped, false);
      assert.ok(notifyItems(ddb).length > 0);
      assert.ok(notifyItems(ddb).every((n) => n.type === TYPE_BLOCKER_REPORTED));
      assert.ok(result.email.failed > 0);
    } finally {
      email.sendEmail = orig;
    }
  });
}

run()
  .then(() => {
    console.log(`\n${passed} tests passed`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

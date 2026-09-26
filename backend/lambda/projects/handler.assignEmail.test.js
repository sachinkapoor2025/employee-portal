process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.AWS_REGION = "ap-south-1";
process.env.WORK_TABLE = "work-table";
process.env.USER_ACCESS_TABLE = "access-table";
process.env.PORTAL_URL = "https://login.mydgv.com";
process.env.NOTIFICATION_FROM_EMAIL = "noreply@mydgv.com";
process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";

const assert = require("assert");
const fs = require("fs");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
const { handler, setClientsForTests } = require("./handler");
const { TYPE_EMPLOYEE_EMAIL } = require("./taskImportAssignNotify");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const PROJECT_ID = "proj-assign-mail-1";
const TASK_ID = "task-assign-mail-1";
const ADMIN = "admin@mydgv.com";
const PRIYA = "priya@mydgv.com";
const RAHUL = "rahul@mydgv.com";
const ANKIT = "ankit@mydgv.com";
const FUTURE_START = "2099-12-31T18:00:00+05:30";
const FUTURE_DUE = "2099-12-31T19:00:00+05:30";
const NEW_START = "2099-12-31T18:15:00+05:30";
const NEW_DUE = "2099-12-31T19:45:00+05:30";

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
        const skPrefix = ExpressionAttributeValues[":sk"];
        const found = items
          .filter((row) => row.TableName === TableName && row.Item.PK === pk)
          .filter((row) =>
            skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true
          )
          .map((row) => ({ ...row.Item }));
        return { Items: found };
      }
      if (command instanceof TransactWriteCommand) {
        for (const op of command.input.TransactItems || []) {
          if (op.Put) this.seed(op.Put.TableName, op.Put.Item);
        }
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function seedAccess(ddb, emailAddr, role = "EMPLOYEE", status = "ACTIVE") {
  ddb.seed(ACCESS, {
    PK: emailAddr,
    SK: emailAddr,
    email: emailAddr,
    role,
    status,
  });
}

function seedShift(ddb, emailAddr) {
  ddb.seed(WORK, {
    PK: `USER#${emailAddr}`,
    SK: "SHIFT#CURRENT",
    shiftId: "morning",
    name: "Morning Shift",
    startTime: "11:00",
    endTime: "20:00",
    graceMinutes: 15,
    crossesMidnight: false,
  });
}

function seedBase(ddb) {
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${PROJECT_ID}`,
    projectId: PROJECT_ID,
    name: "DGV Employee Portal",
    status: "ACTIVE",
  });
  seedAccess(ddb, ADMIN, "ADMIN");
  seedAccess(ddb, PRIYA);
  seedAccess(ddb, RAHUL);
  seedAccess(ddb, ANKIT);
  seedShift(ddb, PRIYA);
  seedShift(ddb, RAHUL);
  seedShift(ddb, ANKIT);
}

function seedExistingTask(ddb, { assignees = [PRIYA], status = "TODO" } = {}) {
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${TASK_ID}`,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    title: "Banner update",
    description: "Original description",
    status,
    priority: "HIGH",
    category: "Marketing",
    startDate: FUTURE_START,
    dueDate: FUTURE_DUE,
    assignee: assignees[0],
    assignees,
    createdBy: ADMIN,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    archived: false,
  };
  ddb.seed(WORK, item);
  ddb.seed(WORK, {
    ...item,
    PK: `PROJECT#${PROJECT_ID}`,
    SK: `TASK#${TASK_ID}`,
  });
  for (const emailAddr of assignees) {
    ddb.seed(WORK, {
      PK: `TASK#${TASK_ID}`,
      SK: `ASSIGNMENT#${emailAddr}`,
      type: "ASSIGNMENT",
      taskId: TASK_ID,
      email: emailAddr,
      status,
      completionRemark: status === "REVIEW" ? "Uploaded all 50 products." : null,
      assignedAt: item.createdAt,
      assignedBy: ADMIN,
      removed: false,
    });
  }
  return item;
}

function setup(taskOpts) {
  const ddb = createMemoryDdb();
  seedBase(ddb);
  if (taskOpts !== false) seedExistingTask(ddb, taskOpts || {});
  setClientsForTests({ ddb });
  return { ddb };
}

function eventFor(method, body, emailAddr = ADMIN) {
  return {
    httpMethod: method,
    path: "/tasks",
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: {
          email: emailAddr,
          "cognito:groups": emailAddr === ADMIN ? ["Admin"] : ["Employee"],
        },
      },
    },
  };
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function createBody(extra = {}) {
  return {
    projectId: PROJECT_ID,
    title: "Homepage Update",
    description: "Update the banner.",
    priority: "HIGH",
    category: "Marketing",
    assignees: [PRIYA],
    startDate: FUTURE_START,
    dueDate: FUTURE_DUE,
    ...extra,
  };
}

function notifyItems(ddb, emailAddr) {
  return ddb
    .of(WORK)
    .filter(
      (item) =>
        item.PK === `USER#${emailAddr}` && String(item.SK).startsWith("NOTIFY#")
    );
}

function mailsTo(mails, emailAddr) {
  return mails.filter((mail) => mail.to === emailAddr);
}

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
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
  await test("normal POST task creation sends assignment email", async () => {
    await withMail(async (mails) => {
      const { ddb } = setup(false);
      const res = parse(await handler(eventFor("POST", createBody())));
      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(mails.length, 1);
      assert.strictEqual(mails[0].to, PRIYA);
      assert.strictEqual(mails[0].subject, "Task Assigned: Homepage Update");
      assert.ok(mails[0].html.includes("font-family:Arial,sans-serif"));
      assert.ok(mails[0].html.includes("VIEW TASK"));
      assert.ok(
        mails[0].html.includes(`/work/${encodeURIComponent(res.body.taskId)}`)
      );
      assert.ok(mails[0].html.includes("DGV Employee Portal"));
      assert.ok(mails[0].text.includes("Assigned By"));
      assert.ok(!mails[0].html.includes("priya@mydgv.com"));
      const bell = notifyItems(ddb, PRIYA).filter((n) => n.type === "TASK_ASSIGNED");
      assert.strictEqual(bell.length, 1);
      assert.ok(bell[0].title.includes("New task assigned"));
      assert.ok(!mails.some((mail) => mail.to === ADMIN));
    });
  });

  await test("multiple new assignees receive their own email", async () => {
    await withMail(async (mails) => {
      setup(false);
      const res = parse(
        await handler(
          eventFor("POST", createBody({ assignees: [PRIYA, RAHUL] }))
        )
      );
      assert.strictEqual(res.statusCode, 201);
      assert.deepStrictEqual(
        mails.map((mail) => mail.to).sort(),
        [PRIYA, RAHUL].sort()
      );
      assert.ok(mails.every((mail) => mail.subject === "Task Assigned: Homepage Update"));
    });
  });

  await test("existing assignees do not receive duplicate assignment email", async () => {
    await withMail(async (mails) => {
      setup({ assignees: [PRIYA] });
      const res = parse(
        await handler(
          eventFor("PUT", {
            taskId: TASK_ID,
            title: "Banner update",
            assignees: [PRIYA],
          })
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(mailsTo(mails, PRIYA).length, 0);
    });
  });

  await test("unrelated task update does not send assignment email", async () => {
    await withMail(async (mails) => {
      setup({ assignees: [PRIYA] });
      const res = parse(
        await handler(
          eventFor("PUT", {
            taskId: TASK_ID,
            description: "Updated copy only.",
          })
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(mails.length, 0);
    });
  });

  await test("manual add-assignee sends email to the new employee", async () => {
    await withMail(async (mails) => {
      const { ddb } = setup({ assignees: [PRIYA] });
      const res = parse(
        await handler(
          eventFor("PUT", {
            taskId: TASK_ID,
            assignees: [PRIYA, RAHUL],
          })
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(mails.length, 1);
      assert.strictEqual(mails[0].to, RAHUL);
      assert.ok(mails[0].subject.includes("Task Assigned:"));
      assert.strictEqual(mailsTo(mails, PRIYA).length, 0);
      const rahulBell = notifyItems(ddb, RAHUL).filter(
        (n) => n.type === "TASK_ASSIGNED"
      );
      assert.strictEqual(rahulBell.length, 1);
      const priyaBell = notifyItems(ddb, PRIYA).filter(
        (n) => n.type === "TASK_ASSIGNED"
      );
      assert.strictEqual(priyaBell.length, 0);
    });
  });

  await test("existing in-place reassignment emails the newly assigned employee", async () => {
    await withMail(async (mails) => {
      const { ddb } = setup({ assignees: [PRIYA] });
      const res = parse(
        await handler(
          eventFor("PUT", {
            taskId: TASK_ID,
            assignees: [RAHUL],
          })
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(mails.length, 1);
      assert.strictEqual(mails[0].to, RAHUL);
      assert.ok(mails[0].html.includes("/work/"));
      assert.ok(mails[0].html.includes(TASK_ID));
      assert.strictEqual(mailsTo(mails, PRIYA).length, 0);
      assert.ok(
        notifyItems(ddb, RAHUL).some((n) => n.type === "TASK_ASSIGNED")
      );
    });
  });

  await test("review reassignment emails the new task assignee", async () => {
    await withMail(async (mails) => {
      const { ddb } = setup({ assignees: [PRIYA], status: "REVIEW" });
      const res = parse(
        await handler(
          eventFor("POST", {
            sourceTaskId: TASK_ID,
            assignmentEmail: PRIYA,
            reassignmentReason: "CHANGES_REQUIRED",
            reassignmentRemark: "Please add alt text.",
            assignees: [RAHUL],
            assignee: RAHUL,
            startDate: NEW_START,
            dueDate: NEW_DUE,
          })
        )
      );
      assert.strictEqual(res.statusCode, 201);
      assert.notStrictEqual(res.body.taskId, TASK_ID);
      assert.strictEqual(mails.length, 1);
      assert.strictEqual(mails[0].to, RAHUL);
      assert.strictEqual(
        mails[0].subject,
        "Task Reassigned to You: Banner update"
      );
      assert.ok(mails[0].text.includes("Changes Required"));
      assert.ok(mails[0].text.includes("Please add alt text."));
      assert.ok(mails[0].html.includes("Please add alt text."));
      assert.ok(mails[0].html.includes("Changes Required"));
      assert.ok(mails[0].html.includes("31 December 2099"));
      assert.ok(/6:15|18:15/.test(mails[0].text));
      assert.ok(/7:45|19:45/.test(mails[0].text));
      assert.ok(!mails[0].html.includes("sourceTaskId"));
      assert.ok(!mails[0].text.includes("sourceTaskId"));
      assert.ok(!mails[0].html.includes(TASK_ID));
      assert.ok(
        mails[0].html.includes(`/work/${encodeURIComponent(res.body.taskId)}`)
      );
      assert.ok(
        notifyItems(ddb, RAHUL).some((n) => n.type === "TASK_ASSIGNED")
      );
    });
  });

  await test("review reassignment email escapes dynamic HTML", async () => {
    await withMail(async (mails) => {
      setup({ assignees: [PRIYA], status: "REVIEW" });
      const res = parse(
        await handler(
          eventFor("POST", {
            sourceTaskId: TASK_ID,
            assignmentEmail: PRIYA,
            reassignmentReason: "REJECTED",
            reassignmentRemark: '<script>alert("x")</script>',
            assignees: [RAHUL],
            startDate: NEW_START,
            dueDate: NEW_DUE,
          })
        )
      );
      assert.strictEqual(res.statusCode, 201);
      assert.ok(!mails[0].html.includes("<script>"));
      assert.ok(mails[0].html.includes("&lt;script&gt;"));
      assert.ok(mails[0].text.includes("Rejected"));
    });
  });

  await test("SES failure does not fail task creation", async () => {
    const orig = email.sendEmail;
    email.sendEmail = async () => ({ ok: false, error: "MessageRejected" });
    try {
      const { ddb } = setup(false);
      const res = parse(await handler(eventFor("POST", createBody())));
      assert.strictEqual(res.statusCode, 201);
      assert.ok(res.body.taskId);
      assert.ok(
        notifyItems(ddb, PRIYA).some((n) => n.type === "TASK_ASSIGNED")
      );
    } finally {
      email.sendEmail = orig;
    }
  });

  await test("Excel/scheduled assignment email path is unchanged", async () => {
    assert.strictEqual(TYPE_EMPLOYEE_EMAIL, "TASK_IMPORT_ASSIGNED_EMAIL");
    const src = fs.readFileSync(
      require.resolve("./taskImportAssignNotify.js"),
      "utf8"
    );
    assert.ok(src.includes("New task assigned:"));
    assert.ok(!src.includes("buildProfessionalEmail"));
    assert.ok(src.includes("TASK_IMPORT_ASSIGNED_EMAIL"));
    const handlerSrc = fs.readFileSync(require.resolve("./handler.js"), "utf8");
    const parts = handlerSrc.split("await notifyTaskEvent(").slice(1);
    const assignedCalls = parts
      .map((part) => part.slice(0, part.indexOf(");")))
      .filter((call) => call.includes('"TASK_ASSIGNED"'));
    assert.ok(assignedCalls.length >= 3);
    for (const call of assignedCalls) {
      assert.ok(
        call.includes('channel: "inapp"'),
        "TASK_ASSIGNED notifyTaskEvent must stay in-app only"
      );
    }
  });

  console.log(`handler assign email tests passed (${passed})`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

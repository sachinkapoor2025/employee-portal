process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.AWS_REGION = "ap-south-1";
process.env.WORK_TABLE = "work-table";
process.env.USER_ACCESS_TABLE = "access-table";
process.env.PORTAL_URL = "https://login.mydgv.com";
process.env.NOTIFICATION_FROM_EMAIL = "noreply@mydgv.com";
process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";

const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
const { handler, setClientsForTests } = require("./handler");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const PROJECT_ID = "proj-review-mail-1";
const REST_ID = "proj-review-mail-rest";
const TASK_ID = "task-review-mail-1";
const ADMIN = "admin@mydgv.com";
const SUPER = "super@mydgv.com";
const PA = "pa@mydgv.com";
const PRIYA = "priya@mydgv.com";
const RAHUL = "rahul@mydgv.com";
const ANKIT = "ankit@mydgv.com";
const FUTURE_START = "2099-12-31T18:00:00+05:30";
const FUTURE_DUE = "2099-12-31T19:00:00+05:30";

function failConditional() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  throw err;
}

function resolveAttrName(token, names = {}) {
  const key = String(token || "").trim();
  if (key.startsWith("#")) return names[key] || key.slice(1);
  return key;
}

function evalCondition(item, expr, names, values) {
  if (!expr) return true;
  const s = String(expr);
  let i = 0;
  function skip() {
    while (i < s.length && s[i] === " ") i += 1;
  }
  function parseOr() {
    let left = parseAnd();
    skip();
    while (/^OR\b/i.test(s.slice(i))) {
      i += 2;
      skip();
      left = parseAnd() || left;
      skip();
    }
    return left;
  }
  function parseAnd() {
    let left = parsePrimary();
    skip();
    while (/^AND\b/i.test(s.slice(i))) {
      i += 3;
      skip();
      left = parsePrimary() && left;
      skip();
    }
    return left;
  }
  function parsePrimary() {
    skip();
    if (s[i] === "(") {
      i += 1;
      const value = parseOr();
      skip();
      if (s[i] === ")") i += 1;
      return value;
    }
    const rest = s.slice(i);
    const notExists = rest.match(/^attribute_not_exists\(([^)]+)\)/i);
    if (notExists) {
      i += notExists[0].length;
      const attr = resolveAttrName(notExists[1], names);
      return item[attr] === undefined || item[attr] === null;
    }
    const cmp = rest.match(/^([#A-Za-z0-9_]+)\s*(<>|=|<=|<|>=|>)\s*(:[A-Za-z0-9_]+)/);
    if (!cmp) throw new Error(`unparsed condition: ${rest}`);
    i += cmp[0].length;
    const left = item[resolveAttrName(cmp[1], names)];
    const right = values[cmp[3]];
    if (cmp[2] === "=") return left === right;
    if (cmp[2] === "<>") return left !== right;
    if (cmp[2] === "<") return left < right;
    if (cmp[2] === "<=") return left <= right;
    if (cmp[2] === ">") return left > right;
    if (cmp[2] === ">=") return left >= right;
    return false;
  }
  return parseOr();
}

function applyUpdateExpression(item, updateExpression, names, values) {
  const next = { ...item };
  const raw = String(updateExpression || "");
  const setMatch = raw.match(/SET\s+(.+?)(?=\s+ADD\s+|$)/i);
  if (setMatch) {
    for (const part of setMatch[1].split(",")) {
      const [rawLeft, rawRight] = part.split("=").map((piece) => piece.trim());
      next[resolveAttrName(rawLeft, names)] = values[rawRight];
    }
  }
  const addMatch = raw.match(/ADD\s+(.+)/i);
  if (addMatch) {
    const tokens = addMatch[1].trim().split(/\s+/);
    const attr = resolveAttrName(tokens[0], names);
    next[attr] = Number(next[attr] || 0) + Number(values[tokens[1]] || 0);
  }
  return next;
}

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
      if (command instanceof ScanCommand) {
        const { TableName } = command.input;
        return {
          Items: items
            .filter((row) => row.TableName === TableName)
            .map((row) => ({ ...row.Item })),
        };
      }
      if (command instanceof UpdateCommand) {
        const {
          TableName,
          Key,
          ConditionExpression,
          UpdateExpression,
          ExpressionAttributeNames = {},
          ExpressionAttributeValues = {},
        } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        if (!found) failConditional();
        if (
          ConditionExpression &&
          !evalCondition(
            found.Item,
            ConditionExpression,
            ExpressionAttributeNames,
            ExpressionAttributeValues
          )
        ) {
          failConditional();
        }
        found.Item = applyUpdateExpression(
          found.Item,
          UpdateExpression,
          ExpressionAttributeNames,
          ExpressionAttributeValues
        );
        return { Attributes: { ...found.Item } };
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

function seedProject(ddb, projectId, extra = {}) {
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${projectId}`,
    projectId,
    name: extra.name || "DGV Employee Portal",
    status: "ACTIVE",
    accessMode: extra.accessMode || "OPEN",
  });
}

function seedTask(ddb, extra = {}) {
  const projectId = extra.projectId || PROJECT_ID;
  const taskId = extra.taskId || TASK_ID;
  const emails = extra.assignees || [PRIYA];
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
    taskId,
    projectId,
    title: extra.title || "Banner update",
    description: extra.description || "Original description",
    status: extra.status || "IN_PROGRESS",
    priority: "HIGH",
    category: "Marketing",
    startDate: FUTURE_START,
    dueDate: FUTURE_DUE,
    assignee: emails[0],
    assignees: emails,
    createdBy: ADMIN,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    archived: false,
  };
  ddb.seed(WORK, item);
  ddb.seed(WORK, { ...item, PK: `PROJECT#${projectId}`, SK: `TASK#${taskId}` });
  for (const emailAddr of emails) {
    ddb.seed(WORK, {
      PK: `TASK#${taskId}`,
      SK: `ASSIGNMENT#${emailAddr}`,
      type: "ASSIGNMENT",
      taskId,
      email: emailAddr,
      status: extra.assignmentStatuses?.[emailAddr] || extra.assignmentStatus || "IN_PROGRESS",
      completionRemark: extra.assignmentRemarks?.[emailAddr] || null,
      assignedAt: item.createdAt,
      assignedBy: ADMIN,
      removed: false,
    });
  }
  return item;
}

function setup(extra = {}) {
  const ddb = createMemoryDdb();
  seedProject(ddb, PROJECT_ID);
  seedAccess(ddb, ADMIN, "ADMIN");
  seedAccess(ddb, SUPER, "SUPER_ADMIN");
  seedAccess(ddb, PRIYA);
  seedAccess(ddb, RAHUL);
  seedAccess(ddb, ANKIT);
  seedShift(ddb, PRIYA);
  seedShift(ddb, RAHUL);
  seedShift(ddb, ANKIT);
  if (extra.task !== false) seedTask(ddb, extra);
  setClientsForTests({ ddb });
  return { ddb };
}

function eventFor(body, emailAddr = PRIYA) {
  return {
    httpMethod: "PUT",
    path: "/tasks",
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: {
          email: emailAddr,
          "cognito:groups": emailAddr === ADMIN || emailAddr === PA ? ["Admin"] : ["Employee"],
        },
      },
    },
  };
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function assignmentItem(ddb, emailAddr, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .find((item) => item.PK === `TASK#${taskId}` && item.SK === `ASSIGNMENT#${emailAddr}`);
}

function activityItems(ddb, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .filter(
      (item) => item.PK === `TASK#${taskId}` && String(item.SK).startsWith("ACTIVITY#")
    );
}

function entityTask(ddb, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .find((item) => item.PK === "ENTITY#TASK" && item.taskId === taskId);
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
  await test("employee DONE + remark sends review email", async () => {
    await withMail(async (mails) => {
      const { ddb } = setup({ assignmentStatus: "IN_PROGRESS" });
      const remark = "Completed the product upload.";
      const res = parse(
        await handler(
          eventFor({
            taskId: TASK_ID,
            status: "DONE",
            completionRemark: remark,
          })
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
      assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
      const reviewMails = mails.filter((mail) =>
        String(mail.subject || "").includes("Submitted for Review")
      );
      assert.ok(reviewMails.length >= 1);
      assert.ok(reviewMails.every((mail) => mail.to !== PRIYA));
      assert.ok(reviewMails.some((mail) => mail.to === ADMIN));
      assert.ok(reviewMails.some((mail) => mail.to === SUPER));
      assert.ok(reviewMails[0].html.includes("Banner update"));
      assert.ok(reviewMails[0].html.includes("Priya"));
      assert.ok(reviewMails[0].html.includes(remark));
      assert.ok(reviewMails[0].html.includes(`/admin/tasks/${TASK_ID}`));
      assert.ok(reviewMails[0].html.includes("REVIEW TASK"));
      assert.ok(!reviewMails[0].html.includes("priya@mydgv.com"));
    });
  });

  await test("direct REVIEW does not send review email", async () => {
    await withMail(async (mails) => {
      setup({ assignmentStatus: "IN_PROGRESS" });
      const res = parse(
        await handler(eventFor({ taskId: TASK_ID, status: "REVIEW" }))
      );
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(mails.filter((m) => /Submitted for Review/.test(m.subject)).length, 0);
    });
  });

  await test("already REVIEW does not send review email", async () => {
    await withMail(async (mails) => {
      setup({ assignmentStatus: "REVIEW" });
      const res = parse(
        await handler(
          eventFor({
            taskId: TASK_ID,
            status: "DONE",
            completionRemark: "Again",
          })
        )
      );
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(mails.filter((m) => /Submitted for Review/.test(m.subject)).length, 0);
    });
  });

  await test("admin status change does not send review email", async () => {
    await withMail(async (mails) => {
      setup({ assignmentStatus: "IN_PROGRESS" });
      const res = parse(
        await handler(
          eventFor({ taskId: TASK_ID, status: "TODO" }, ADMIN)
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(mails.filter((m) => /Submitted for Review/.test(m.subject)).length, 0);
    });
  });

  await test("review email failure does not fail REVIEW mutation", async () => {
    const orig = email.sendEmail;
    email.sendEmail = async () => ({ ok: false, error: "MessageRejected" });
    try {
      const { ddb } = setup({ assignmentStatus: "IN_PROGRESS" });
      const res = parse(
        await handler(
          eventFor({
            taskId: TASK_ID,
            status: "DONE",
            completionRemark: "Uploaded.",
          })
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
    } finally {
      email.sendEmail = orig;
    }
  });

  await test("multi-assignee review email uses submitting assignment", async () => {
    await withMail(async (mails) => {
      const { ddb } = setup({
        assignees: [PRIYA, ANKIT],
        assignmentStatuses: { [PRIYA]: "IN_PROGRESS", [ANKIT]: "IN_PROGRESS" },
        assignmentRemarks: { [PRIYA]: "Priya leftover" },
      });
      const res = parse(
        await handler(
          eventFor(
            {
              taskId: TASK_ID,
              status: "DONE",
              completionRemark: "Ankit finished research.",
            },
            ANKIT
          )
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(assignmentItem(ddb, ANKIT).status, "REVIEW");
      assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
      const reviewMails = mails.filter((mail) =>
        /Submitted for Review/.test(mail.subject)
      );
      assert.ok(reviewMails[0].html.includes("Ankit"));
      assert.ok(reviewMails[0].html.includes("Ankit finished research."));
      assert.ok(!reviewMails[0].html.includes("Priya leftover"));
    });
  });

  await test("admin REVIEW to DONE sends completion emails", async () => {
    await withMail(async (mails) => {
      const { ddb } = setup({
        assignmentStatus: "REVIEW",
        assignmentRemarks: { [PRIYA]: "Ready for review." },
      });
      const res = parse(
        await handler(
          eventFor(
            { taskId: TASK_ID, status: "DONE", assignmentEmail: PRIYA },
            ADMIN
          )
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(assignmentItem(ddb, PRIYA).status, "DONE");
      assert.ok(activityItems(ddb).some((a) => a.action === "task_completed"));
      const doneMails = mails.filter((mail) =>
        String(mail.subject || "").startsWith("Task Completed:")
      );
      const tos = doneMails.map((mail) => mail.to).sort();
      assert.ok(tos.includes(PRIYA));
      assert.ok(tos.includes(ADMIN));
      assert.ok(tos.includes(SUPER));
      const employeeMail = doneMails.find((mail) => mail.to === PRIYA);
      const adminMail = doneMails.find((mail) => mail.to === ADMIN);
      assert.ok(employeeMail.html.includes(`/work/${TASK_ID}`));
      assert.ok(adminMail.html.includes(`/admin/tasks/${TASK_ID}`));
      assert.ok(adminMail.html.includes("Ready for review."));
      assert.ok(adminMail.html.includes("background:#047857"));
      const completedAt = assignmentItem(ddb, PRIYA).completedAt;
      assert.ok(completedAt);
    });
  });

  await test("completion email failure does not fail DONE", async () => {
    const orig = email.sendEmail;
    email.sendEmail = async () => ({ ok: false, error: "MessageRejected" });
    try {
      const { ddb } = setup({
        assignmentStatus: "REVIEW",
        assignmentRemarks: { [PRIYA]: "Ready." },
      });
      const res = parse(
        await handler(
          eventFor(
            { taskId: TASK_ID, status: "DONE", assignmentEmail: PRIYA },
            ADMIN
          )
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(assignmentItem(ddb, PRIYA).status, "DONE");
      assert.ok(activityItems(ddb).some((a) => a.action === "task_completed"));
    } finally {
      email.sendEmail = orig;
    }
  });

  await test("restricted review and completion use project admins", async () => {
    await withMail(async (mails) => {
      const ddb = createMemoryDdb();
      seedProject(ddb, REST_ID, { accessMode: "RESTRICTED", name: "Secret" });
      seedAccess(ddb, ADMIN, "ADMIN");
      seedAccess(ddb, SUPER, "SUPER_ADMIN");
      seedAccess(ddb, PA, "ADMIN");
      seedAccess(ddb, PRIYA);
      seedShift(ddb, PRIYA);
      ddb.seed(WORK, {
        PK: `PROJECT#${REST_ID}`,
        SK: `PROJECT_ADMIN#${PA}`,
        type: "PROJECT_ADMIN",
        projectId: REST_ID,
        email: PA,
        status: "ACTIVE",
        taskVisibility: "ALL_PROJECT_TASKS",
      });
      ddb.seed(WORK, {
        PK: `PROJECT#${REST_ID}`,
        SK: `MEMBER#${PRIYA}`,
        type: "PROJECT_MEMBER",
        projectId: REST_ID,
        email: PRIYA,
        status: "ACTIVE",
      });
      seedTask(ddb, {
        projectId: REST_ID,
        taskId: "task-rest-mail",
        assignmentStatus: "IN_PROGRESS",
      });
      setClientsForTests({ ddb });
      const submit = parse(
        await handler(
          eventFor({
            taskId: "task-rest-mail",
            status: "DONE",
            completionRemark: "Restricted upload done.",
          })
        )
      );
      assert.strictEqual(submit.statusCode, 200);
      const reviewMails = mails.filter((mail) =>
        /Submitted for Review/.test(mail.subject)
      );
      assert.deepStrictEqual(
        reviewMails.map((mail) => mail.to).sort(),
        [PA]
      );
      mails.length = 0;
      const approve = parse(
        await handler(
          eventFor(
            {
              taskId: "task-rest-mail",
              status: "DONE",
              assignmentEmail: PRIYA,
            },
            PA
          )
        )
      );
      assert.strictEqual(approve.statusCode, 200);
      const doneMails = mails.filter((mail) =>
        String(mail.subject || "").startsWith("Task Completed:")
      );
      const tos = doneMails.map((mail) => mail.to).sort();
      assert.deepStrictEqual(tos, [PA, PRIYA].sort());
      assert.ok(!tos.includes(SUPER));
      assert.ok(!tos.includes(ADMIN));
    });
  });

  await test("second completion claim does not duplicate emails", async () => {
    await withMail(async (mails) => {
      setup({
        assignmentStatus: "REVIEW",
        assignmentRemarks: { [PRIYA]: "Ready." },
      });
      const first = parse(
        await handler(
          eventFor(
            { taskId: TASK_ID, status: "DONE", assignmentEmail: PRIYA },
            ADMIN
          )
        )
      );
      assert.strictEqual(first.statusCode, 200);
      const afterFirst = mails.filter((mail) =>
        String(mail.subject || "").startsWith("Task Completed:")
      ).length;
      const second = parse(
        await handler(
          eventFor(
            { taskId: TASK_ID, status: "DONE", assignmentEmail: PRIYA },
            ADMIN
          )
        )
      );
      assert.strictEqual(second.statusCode, 200);
      const afterSecond = mails.filter((mail) =>
        String(mail.subject || "").startsWith("Task Completed:")
      ).length;
      assert.strictEqual(afterSecond, afterFirst);
    });
  });

  console.log(`handler review/completion email tests passed (${passed})`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

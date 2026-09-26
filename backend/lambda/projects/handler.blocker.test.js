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
  ScanCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
email.sendEmail = async () => ({ ok: true, messageId: "ses-test" });
const { handler, setClientsForTests } = require("./handler");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const PROJECT_ID = "proj-blocker-1";
const REST_PROJECT_ID = "proj-blocker-restricted";
const TASK_ID = "task-blocker-1";
const REST_TASK_ID = "task-blocker-restricted";
const ADMIN = "admin@mydgv.com";
const SUPER = "super@mydgv.com";
const PA = "pa@mydgv.com";
const PRIYA = "priya@mydgv.com";
const ANKIT = "ankit@mydgv.com";
const NITIN = "nitin@mydgv.com";
const OUTSIDER = "outsider@mydgv.com";
const FUTURE_START = "2099-12-31T18:00:00+05:30";
const FUTURE_DUE = "2099-12-31T20:00:00+05:30";

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
      if (command instanceof TransactWriteCommand) {
        for (const op of command.input.TransactItems || []) {
          if (op.Put) this.seed(op.Put.TableName, op.Put.Item);
        }
        return {};
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
  ddb.seed(ACCESS, {
    PK: email,
    SK: email,
    email,
    role,
    status,
  });
}

function seedProject(ddb, projectId, extra = {}) {
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${projectId}`,
    projectId,
    name: extra.name || projectId,
    status: "ACTIVE",
    accessMode: extra.accessMode || "OPEN",
  });
}

function seedProjectAdmin(ddb, projectId, email) {
  ddb.seed(WORK, {
    PK: `PROJECT#${projectId}`,
    SK: `PROJECT_ADMIN#${email}`,
    type: "PROJECT_ADMIN",
    projectId,
    email,
    status: "ACTIVE",
    taskVisibility: "ALL_PROJECT_TASKS",
  });
}

function seedProjectMember(ddb, projectId, email) {
  ddb.seed(WORK, {
    PK: `PROJECT#${projectId}`,
    SK: `MEMBER#${email}`,
    type: "PROJECT_MEMBER",
    projectId,
    email,
    status: "ACTIVE",
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
    startDate: extra.startDate || FUTURE_START,
    dueDate: extra.dueDate || FUTURE_DUE,
    assignee: emails[0],
    assignees: emails,
    assignmentMode: extra.assignmentMode || "IMMEDIATE",
    assignmentState: extra.assignmentState || "ASSIGNED",
    createdBy: ADMIN,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    archived: false,
  };
  ddb.seed(WORK, item);
  ddb.seed(WORK, {
    ...item,
    PK: `PROJECT#${projectId}`,
    SK: `TASK#${taskId}`,
  });
  for (const email of emails) {
    ddb.seed(WORK, {
      PK: `TASK#${taskId}`,
      SK: `ASSIGNMENT#${email}`,
      type: "ASSIGNMENT",
      taskId,
      email,
      status: extra.assignmentStatuses?.[email] || extra.assignmentStatus || "IN_PROGRESS",
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
  seedAccess(ddb, PA, "EMPLOYEE");
  seedAccess(ddb, PRIYA);
  seedAccess(ddb, ANKIT);
  seedAccess(ddb, NITIN);
  seedAccess(ddb, OUTSIDER, "ADMIN");
  seedTask(ddb, extra);
  setClientsForTests({ ddb });
  return { ddb };
}

function setupRestricted(extra = {}) {
  const ddb = createMemoryDdb();
  seedProject(ddb, REST_PROJECT_ID, { accessMode: "RESTRICTED" });
  seedAccess(ddb, ADMIN, "ADMIN");
  seedAccess(ddb, PA, "EMPLOYEE");
  seedAccess(ddb, OUTSIDER, "ADMIN");
  seedAccess(ddb, ANKIT);
  seedProjectAdmin(ddb, REST_PROJECT_ID, PA);
  seedProjectMember(ddb, REST_PROJECT_ID, ANKIT);
  seedTask(ddb, {
    projectId: REST_PROJECT_ID,
    taskId: REST_TASK_ID,
    assignees: extra.assignees || [ANKIT],
    assignmentStatus: extra.assignmentStatus || "IN_PROGRESS",
    status: extra.status || "IN_PROGRESS",
  });
  setClientsForTests({ ddb });
  return { ddb };
}

function apiEvent({
  method = "POST",
  path,
  body = {},
  email,
  groups,
}) {
  return {
    httpMethod: method,
    path,
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: {
          email,
          "cognito:groups": groups || (email === ADMIN || email === OUTSIDER || email === SUPER
            ? ["Admin"]
            : ["Employee"]),
        },
      },
    },
  };
}

function reportEvent(email, body = {}, taskId = TASK_ID) {
  return apiEvent({
    path: `/tasks/${taskId}/blocker`,
    body,
    email,
  });
}

function resolveEvent(email, body = {}, taskId = TASK_ID) {
  return apiEvent({
    path: `/tasks/${taskId}/blocker/resolve`,
    body,
    email,
  });
}

function assignmentItem(ddb, email, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .find((item) => item.PK === `TASK#${taskId}` && item.SK === `ASSIGNMENT#${email}`);
}

function entityTask(ddb, taskId = TASK_ID) {
  return ddb.of(WORK).find((item) => item.PK === "ENTITY#TASK" && item.taskId === taskId);
}

function activityItems(ddb, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .filter(
      (item) =>
        item.PK === `TASK#${taskId}` && String(item.SK).startsWith("ACTIVITY#")
    );
}

function notifyItems(ddb, type = "TASK_BLOCKER_REPORTED") {
  return ddb
    .of(WORK)
    .filter(
      (item) =>
        String(item.SK || "").startsWith("NOTIFY#") &&
        (!type || item.type === type)
    );
}

function reminderItems(ddb) {
  return ddb
    .of(WORK)
    .filter(
      (item) =>
        String(item.SK || "").startsWith("REMINDER#") &&
        item.type === "TASK_BLOCKER_REPORTED_EMAIL"
    );
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
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
  await test("report blocker on IN_PROGRESS assignment succeeds", async () => {
    const { ddb } = setup({ assignees: [PRIYA], status: "IN_PROGRESS" });
    const parentBefore = entityTask(ddb).status;
    const res = parse(
      await handler(reportEvent(PRIYA, { remark: "  Waiting on legal copy  " }))
    );
    assert.strictEqual(res.statusCode, 200);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.status, "IN_PROGRESS");
    assert.strictEqual(mine.blockerStatus, "ACTIVE");
    assert.strictEqual(mine.blockerRemark, "Waiting on legal copy");
    assert.ok(mine.blockerReportedAt);
    assert.strictEqual(mine.blockerResolvedAt, null);
    assert.strictEqual(mine.blockerResolvedBy, null);
    assert.strictEqual(entityTask(ddb).status, parentBefore);
    assert.ok(!entityTask(ddb).blockerStatus);
    assert.strictEqual(res.body.status, "IN_PROGRESS");
    assert.strictEqual(res.body.myAssignment.blockerStatus, "ACTIVE");
    assert.strictEqual(res.body.myAssignment.blockerRemark, "Waiting on legal copy");
    assert.strictEqual(res.body.myAssignment.status, "IN_PROGRESS");
    const notified = notifyItems(ddb);
    assert.ok(notified.length > 0);
    assert.ok(notified.every((n) => n.type === "TASK_BLOCKER_REPORTED"));
    assert.ok(notified.some((n) => n.email === ADMIN));
    assert.ok(notified.some((n) => n.email === SUPER));
    assert.ok(!notified.some((n) => n.email === PRIYA));
    assert.ok(
      notified.every((n) =>
        String(n.message || "").includes("reported a blocker on")
      )
    );
    assert.ok(
      !notified.some((n) =>
        /entire task is blocked|task is blocked/i.test(n.message || "")
      )
    );
    assert.ok(notified.every((n) => n.taskId === TASK_ID));
    assert.ok(notified.every((n) => n.assignmentEmail === PRIYA));
    assert.ok(notified.every((n) => n.path === "/admin/blockers"));
    assert.ok(notified.every((n) => n.blockerRemark === "Waiting on legal copy"));
  });

  await test("missing remark is 400", async () => {
    const { ddb } = setup();
    const res = parse(await handler(reportEvent(PRIYA, {})));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!assignmentItem(ddb, PRIYA).blockerStatus);
    assert.strictEqual(activityItems(ddb).length, 0);
    assert.strictEqual(notifyItems(ddb).length, 0);
  });

  await test("whitespace remark is 400", async () => {
    const { ddb } = setup();
    const res = parse(await handler(reportEvent(PRIYA, { remark: "   " })));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!assignmentItem(ddb, PRIYA).blockerStatus);
    assert.strictEqual(notifyItems(ddb).length, 0);
  });

  for (const status of ["TODO", "REVIEW", "DONE", "CANCELLED"]) {
    await test(`${status} assignment cannot report blocker`, async () => {
      const { ddb } = setup({ assignmentStatus: status, status });
      const res = parse(
        await handler(reportEvent(PRIYA, { remark: "Blocked" }))
      );
      assert.strictEqual(res.statusCode, 400);
      assert.ok(!assignmentItem(ddb, PRIYA).blockerStatus);
      assert.strictEqual(entityTask(ddb).status, status);
      assert.strictEqual(activityItems(ddb).length, 0);
      assert.strictEqual(notifyItems(ddb).length, 0);
    });
  }

  await test("missing assignment is an error", async () => {
    const { ddb } = setup({ assignees: [PRIYA] });
    const res = parse(
      await handler(reportEvent(ADMIN, { remark: "I am not assigned" }))
    );
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!assignmentItem(ddb, PRIYA).blockerStatus);
    assert.strictEqual(activityItems(ddb).length, 0);
    assert.strictEqual(notifyItems(ddb).length, 0);
  });

  await test("duplicate ACTIVE blocker is 400", async () => {
    const { ddb } = setup();
    const first = parse(
      await handler(reportEvent(PRIYA, { remark: "First blocker" }))
    );
    assert.strictEqual(first.statusCode, 200);
    const reportedAt = assignmentItem(ddb, PRIYA).blockerReportedAt;
    const notifiedAfterFirst = notifyItems(ddb).length;
    assert.ok(notifiedAfterFirst > 0);
    const second = parse(
      await handler(reportEvent(PRIYA, { remark: "Second blocker" }))
    );
    assert.strictEqual(second.statusCode, 400);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.blockerStatus, "ACTIVE");
    assert.strictEqual(mine.blockerRemark, "First blocker");
    assert.strictEqual(mine.blockerReportedAt, reportedAt);
    assert.strictEqual(
      activityItems(ddb).filter((a) => a.action === "BLOCKER_REPORTED").length,
      1
    );
    assert.strictEqual(notifyItems(ddb).length, notifiedAfterFirst);
  });

  await test("employee cannot report blocker for another assignment", async () => {
    const { ddb } = setup({
      assignees: [ANKIT, PRIYA],
      assignmentStatuses: { [ANKIT]: "IN_PROGRESS", [PRIYA]: "IN_PROGRESS" },
    });
    const res = parse(
      await handler(
        reportEvent(ANKIT, {
          assignmentEmail: PRIYA,
          remark: "Ankit blocked",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, ANKIT).blockerStatus, "ACTIVE");
    assert.strictEqual(assignmentItem(ddb, ANKIT).blockerRemark, "Ankit blocked");
    assert.ok(!assignmentItem(ddb, PRIYA).blockerStatus);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    const notified = notifyItems(ddb);
    assert.ok(notified.length > 0);
    assert.ok(notified.every((n) => n.assignmentEmail === ANKIT));
    assert.ok(
      notified.every((n) =>
        String(n.message || "").includes("Ankit reported a blocker on")
      )
    );
    assert.ok(
      !notified.some((n) => /task is blocked/i.test(String(n.message || "")))
    );
    assert.ok(!notified.some((n) => n.email === ANKIT));
    assert.ok(!notified.some((n) => n.email === PRIYA));
  });

  await test("employee cannot resolve blocker", async () => {
    const { ddb } = setup();
    assert.strictEqual(
      parse(await handler(reportEvent(PRIYA, { remark: "Need asset" }))).statusCode,
      200
    );
    const res = parse(
      await handler(resolveEvent(PRIYA, { assignmentEmail: PRIYA }))
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(assignmentItem(ddb, PRIYA).blockerStatus, "ACTIVE");
    assert.strictEqual(
      activityItems(ddb).filter((a) => a.action === "BLOCKER_RESOLVED").length,
      0
    );
  });

  await test("resolve without assignmentEmail is 400", async () => {
    const { ddb } = setup();
    assert.strictEqual(
      parse(await handler(reportEvent(PRIYA, { remark: "Need legal" }))).statusCode,
      200
    );
    const res = parse(await handler(resolveEvent(ADMIN, {})));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(assignmentItem(ddb, PRIYA).blockerStatus, "ACTIVE");
  });

  await test("portal ADMIN resolves ACTIVE blocker without status change", async () => {
    const { ddb } = setup({ assignees: [PRIYA], status: "IN_PROGRESS" });
    assert.strictEqual(
      parse(await handler(reportEvent(PRIYA, { remark: "Need legal" }))).statusCode,
      200
    );
    const parentBefore = entityTask(ddb).status;
    const res = parse(
      await handler(resolveEvent(ADMIN, { assignmentEmail: PRIYA }))
    );
    assert.strictEqual(res.statusCode, 200);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.blockerStatus, "RESOLVED");
    assert.ok(mine.blockerResolvedAt);
    assert.strictEqual(mine.blockerResolvedBy, ADMIN);
    assert.strictEqual(mine.blockerRemark, "Need legal");
    assert.ok(mine.blockerReportedAt);
    assert.strictEqual(mine.status, "IN_PROGRESS");
    assert.strictEqual(entityTask(ddb).status, parentBefore);
    assert.strictEqual(res.body.status, "IN_PROGRESS");
    const resolved = activityItems(ddb).filter((a) => a.action === "BLOCKER_RESOLVED");
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].assignmentEmail, PRIYA);
    assert.strictEqual(resolved[0].blockerRemark, "Need legal");
    assert.strictEqual(resolved[0].blockerResolvedBy, ADMIN);
  });

  await test("resolve without ACTIVE blocker is 400", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(resolveEvent(ADMIN, { assignmentEmail: PRIYA }))
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(
      activityItems(ddb).filter((a) => a.action === "BLOCKER_RESOLVED").length,
      0
    );
    assert.strictEqual(entityTask(ddb).status, "IN_PROGRESS");
  });

  await test("SUPER_ADMIN can resolve blocker", async () => {
    const { ddb } = setup();
    assert.strictEqual(
      parse(await handler(reportEvent(PRIYA, { remark: "Need review" }))).statusCode,
      200
    );
    const res = parse(
      await handler(resolveEvent(SUPER, { assignmentEmail: PRIYA }))
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, PRIYA).blockerStatus, "RESOLVED");
    assert.strictEqual(assignmentItem(ddb, PRIYA).blockerResolvedBy, SUPER);
  });

  await test("eligible Project Admin can resolve on restricted project", async () => {
    const { ddb } = setupRestricted();
    assert.strictEqual(
      parse(
        await handler(
          reportEvent(ANKIT, { remark: "Waiting on client" }, REST_TASK_ID)
        )
      ).statusCode,
      200
    );
    const res = parse(
      await handler(
        resolveEvent(PA, { assignmentEmail: ANKIT }, REST_TASK_ID)
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      assignmentItem(ddb, ANKIT, REST_TASK_ID).blockerStatus,
      "RESOLVED"
    );
    assert.strictEqual(
      assignmentItem(ddb, ANKIT, REST_TASK_ID).blockerResolvedBy,
      PA
    );
  });

  await test("unauthorized Project Admin cannot resolve on restricted project", async () => {
    const { ddb } = setupRestricted();
    assert.strictEqual(
      parse(
        await handler(
          reportEvent(ANKIT, { remark: "Waiting on client" }, REST_TASK_ID)
        )
      ).statusCode,
      200
    );
    const res = parse(
      await handler(
        resolveEvent(OUTSIDER, { assignmentEmail: ANKIT }, REST_TASK_ID)
      )
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(
      assignmentItem(ddb, ANKIT, REST_TASK_ID).blockerStatus,
      "ACTIVE"
    );
  });

  await test("multi-assignee report and resolve stay isolated", async () => {
    const { ddb } = setup({
      assignees: [ANKIT, PRIYA, NITIN],
      assignmentStatuses: {
        [ANKIT]: "IN_PROGRESS",
        [PRIYA]: "IN_PROGRESS",
        [NITIN]: "IN_PROGRESS",
      },
    });
    assert.strictEqual(
      parse(await handler(reportEvent(ANKIT, { remark: "Ankit blocked" }))).statusCode,
      200
    );
    assert.strictEqual(assignmentItem(ddb, ANKIT).blockerStatus, "ACTIVE");
    assert.ok(!assignmentItem(ddb, PRIYA).blockerStatus);
    assert.ok(!assignmentItem(ddb, NITIN).blockerStatus);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.strictEqual(assignmentItem(ddb, NITIN).status, "IN_PROGRESS");
    assert.strictEqual(entityTask(ddb).status, "IN_PROGRESS");

    const resolved = parse(
      await handler(resolveEvent(ADMIN, { assignmentEmail: ANKIT }))
    );
    assert.strictEqual(resolved.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, ANKIT).blockerStatus, "RESOLVED");
    assert.ok(!assignmentItem(ddb, PRIYA).blockerStatus);
    assert.ok(!assignmentItem(ddb, NITIN).blockerStatus);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
  });

  await test("BLOCKER_REPORTED activity includes assignmentEmail and remark", async () => {
    const { ddb } = setup();
    assert.strictEqual(
      parse(await handler(reportEvent(PRIYA, { remark: "Need Figma" }))).statusCode,
      200
    );
    const reported = activityItems(ddb).filter((a) => a.action === "BLOCKER_REPORTED");
    assert.strictEqual(reported.length, 1);
    assert.strictEqual(reported[0].taskId, TASK_ID);
    assert.strictEqual(reported[0].assignmentEmail, PRIYA);
    assert.strictEqual(reported[0].actorEmail, PRIYA);
    assert.strictEqual(reported[0].blockerRemark, "Need Figma");
    assert.ok(reported[0].detail);
    assert.ok(reported[0].timestamp);
  });

  await test("repeat blocker cycles overwrite current fields and keep activity history", async () => {
    const { ddb } = setup();
    assert.strictEqual(
      parse(await handler(reportEvent(PRIYA, { remark: "Cycle A" }))).statusCode,
      200
    );
    assert.strictEqual(
      parse(await handler(resolveEvent(ADMIN, { assignmentEmail: PRIYA }))).statusCode,
      200
    );
    assert.strictEqual(
      parse(await handler(reportEvent(PRIYA, { remark: "Cycle B" }))).statusCode,
      200
    );
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.blockerStatus, "ACTIVE");
    assert.strictEqual(mine.blockerRemark, "Cycle B");
    assert.ok(mine.blockerReportedAt);
    assert.strictEqual(mine.blockerResolvedAt, null);
    assert.strictEqual(mine.blockerResolvedBy, null);
    assert.strictEqual(mine.status, "IN_PROGRESS");
    const reported = activityItems(ddb).filter((a) => a.action === "BLOCKER_REPORTED");
    const resolved = activityItems(ddb).filter((a) => a.action === "BLOCKER_RESOLVED");
    assert.strictEqual(reported.length, 2);
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(reported[0].blockerRemark, "Cycle A");
    assert.strictEqual(reported[1].blockerRemark, "Cycle B");
    const cycleNotifies = notifyItems(ddb);
    const cycleA = cycleNotifies.filter((n) => n.blockerRemark === "Cycle A");
    const cycleB = cycleNotifies.filter((n) => n.blockerRemark === "Cycle B");
    assert.ok(cycleA.length > 0);
    assert.ok(cycleB.length > 0);
    assert.notStrictEqual(
      cycleA[0].SK,
      cycleB.find((n) => n.email === cycleA[0].email)?.SK
    );
  });

  await test("GET task returns blocker fields on myAssignment and assignments", async () => {
    const { ddb } = setup({ assignees: [ANKIT, PRIYA] });
    assert.strictEqual(
      parse(await handler(reportEvent(ANKIT, { remark: "Need asset" }))).statusCode,
      200
    );
    const employeeGet = parse(
      await handler(
        apiEvent({
          method: "GET",
          path: `/tasks/${TASK_ID}`,
          email: ANKIT,
        })
      )
    );
    assert.strictEqual(employeeGet.statusCode, 200);
    assert.strictEqual(employeeGet.body.myAssignment.blockerStatus, "ACTIVE");
    assert.strictEqual(employeeGet.body.myAssignment.blockerRemark, "Need asset");
    assert.ok(!employeeGet.body.blockerStatus);
    const notifiedAfterReport = notifyItems(ddb).length;
    assert.ok(notifiedAfterReport > 0);

    const adminGet = parse(
      await handler(
        apiEvent({
          method: "GET",
          path: `/tasks/${TASK_ID}`,
          email: ADMIN,
        })
      )
    );
    assert.strictEqual(adminGet.statusCode, 200);
    const byEmail = Object.fromEntries(
      adminGet.body.assignments.map((a) => [a.email, a])
    );
    assert.strictEqual(byEmail[ANKIT].blockerStatus, "ACTIVE");
    assert.strictEqual(byEmail[PRIYA].blockerStatus, null);
    assert.strictEqual(notifyItems(ddb).length, notifiedAfterReport);
  });

  await test("safe assignment write preserves blocker fields", async () => {
    const { ddb } = setup({ assignees: [PRIYA], status: "IN_PROGRESS" });
    assert.strictEqual(
      parse(await handler(reportEvent(PRIYA, { remark: "Need legal" }))).statusCode,
      200
    );
    const reportedAt = assignmentItem(ddb, PRIYA).blockerReportedAt;
    const put = parse(
      await handler(
        apiEvent({
          method: "PUT",
          path: "/tasks",
          email: PRIYA,
          body: {
            taskId: TASK_ID,
            projectId: PROJECT_ID,
            status: "DONE",
            assignmentEmail: PRIYA,
            completionRemark: "Ready for admin review.",
          },
        })
      )
    );
    assert.strictEqual(put.statusCode, 200);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.status, "REVIEW");
    assert.strictEqual(mine.blockerStatus, "ACTIVE");
    assert.strictEqual(mine.blockerRemark, "Need legal");
    assert.strictEqual(mine.blockerReportedAt, reportedAt);
    assert.strictEqual(entityTask(ddb).status, "REVIEW");
  });

  await test("notification failure does not roll back blocker report", async () => {
    const { ddb } = setup();
    const orig = ddb.send.bind(ddb);
    ddb.send = async (command) => {
      if (command instanceof ScanCommand) {
        throw new Error("access scan down");
      }
      return orig(command);
    };
    const res = parse(
      await handler(reportEvent(PRIYA, { remark: "VPN down" }))
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, PRIYA).blockerStatus, "ACTIVE");
    assert.strictEqual(assignmentItem(ddb, PRIYA).blockerRemark, "VPN down");
    assert.strictEqual(
      activityItems(ddb).filter((a) => a.action === "BLOCKER_REPORTED").length,
      1
    );
    assert.strictEqual(notifyItems(ddb).length, 0);
  });

  await test("RESTRICTED project notifies project admins via existing recipient lookup", async () => {
    const { ddb } = setupRestricted();
    const res = parse(
      await handler(
        reportEvent(ANKIT, { remark: "Waiting on client" }, REST_TASK_ID)
      )
    );
    assert.strictEqual(res.statusCode, 200);
    const notified = notifyItems(ddb);
    assert.ok(notified.some((n) => n.email === PA));
    assert.ok(!notified.some((n) => n.email === ADMIN));
    assert.ok(!notified.some((n) => n.email === OUTSIDER));
    assert.ok(!notified.some((n) => n.email === ANKIT));
    assert.ok(notified.every((n) => n.path === "/admin/blockers"));
    assert.ok(notified.every((n) => n.assignmentEmail === ANKIT));
  });

  await test("resolve does not send TASK_BLOCKER_REPORTED or BLOCKER_RESOLVED notify", async () => {
    const { ddb } = setup();
    assert.strictEqual(
      parse(await handler(reportEvent(PRIYA, { remark: "Need legal" }))).statusCode,
      200
    );
    const afterReport = notifyItems(ddb).length;
    assert.ok(afterReport > 0);
    assert.strictEqual(
      parse(await handler(resolveEvent(ADMIN, { assignmentEmail: PRIYA }))).statusCode,
      200
    );
    assert.strictEqual(notifyItems(ddb).length, afterReport);
    assert.strictEqual(
      notifyItems(ddb, "TASK_BLOCKER_RESOLVED").length,
      0
    );
  });

  await test("task status enum does not include BLOCKED", async () => {
    const src = fs.readFileSync(require.resolve("./handler.js"), "utf8");
    const statuses = src.match(/const STATUSES = \[([\s\S]*?)\];/);
    assert.ok(statuses);
    assert.ok(!statuses[1].includes("BLOCKED"));
    assert.ok(src.includes('sub === "blocker"'));
  });

  await test("successful blocker report triggers blocker email to OPEN admins", async () => {
    await withMail(async (mails) => {
      const { ddb } = setup({ assignees: [PRIYA], status: "IN_PROGRESS" });
      const res = parse(
        await handler(reportEvent(PRIYA, { remark: "Waiting on legal copy" }))
      );
      assert.strictEqual(res.statusCode, 200);
      assert.ok(mails.length > 0);
      assert.ok(mails.some((mail) => mail.to === ADMIN));
      assert.ok(mails.some((mail) => mail.to === SUPER));
      assert.ok(!mails.some((mail) => mail.to === PRIYA));
      for (const mail of mails) {
        assert.strictEqual(mail.subject, "Task Blocker Reported: Banner update");
        assert.ok(mail.html.includes("Priya"));
        assert.ok(mail.html.includes("Waiting on legal copy"));
        assert.ok(mail.html.includes("Admin action may be required"));
        assert.ok(mail.html.includes(`/admin/tasks/${TASK_ID}`));
        assert.ok(mail.html.includes("VIEW TASK"));
        assert.ok(mail.html.includes("background:#991b1b"));
        assert.ok(!mail.html.includes("/admin/blockers"));
        assert.ok(!mail.html.includes("ENTITY#TASK"));
        assert.ok(!mail.html.includes("ASSIGNMENT#"));
      }
      const inApp = notifyItems(ddb);
      assert.ok(inApp.length > 0);
      assert.ok(inApp.every((n) => n.type === "TASK_BLOCKER_REPORTED"));
      assert.ok(inApp.every((n) => n.path === "/admin/blockers"));
      assert.ok(inApp.every((n) => n.assignmentEmail === PRIYA));
      assert.ok(reminderItems(ddb).length > 0);
    });
  });

  await test("RESTRICTED project blocker email goes to project admins", async () => {
    await withMail(async (mails) => {
      setupRestricted();
      const res = parse(
        await handler(
          reportEvent(ANKIT, { remark: "Waiting on client" }, REST_TASK_ID)
        )
      );
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(
        mails.map((mail) => mail.to).sort(),
        [PA]
      );
      assert.ok(!mails.some((mail) => mail.to === ADMIN));
      assert.ok(!mails.some((mail) => mail.to === OUTSIDER));
      assert.ok(!mails.some((mail) => mail.to === ANKIT));
      assert.ok(mails[0].html.includes(`/admin/tasks/${REST_TASK_ID}`));
      assert.ok(mails[0].html.includes("Ankit"));
      assert.ok(mails[0].html.includes("Waiting on client"));
    });
  });

  await test("multi-assignee blocker email uses the reporting assignment", async () => {
    await withMail(async (mails) => {
      const { ddb } = setup({
        assignees: [ANKIT, PRIYA],
        assignmentStatuses: { [ANKIT]: "IN_PROGRESS", [PRIYA]: "IN_PROGRESS" },
      });
      const res = parse(
        await handler(reportEvent(PRIYA, { remark: "Priya needs assets" }))
      );
      assert.strictEqual(res.statusCode, 200);
      assert.ok(mails.length > 0);
      for (const mail of mails) {
        assert.ok(mail.html.includes("Priya"));
        assert.ok(mail.html.includes("Priya needs assets"));
        assert.ok(!/Ankit reported/i.test(mail.html));
      }
      const inApp = notifyItems(ddb);
      assert.ok(inApp.every((n) => n.assignmentEmail === PRIYA));
      assert.ok(inApp.every((n) => n.blockerRemark === "Priya needs assets"));
    });
  });

  await test("duplicate ACTIVE blocker does not send another email", async () => {
    await withMail(async (mails) => {
      setup();
      const first = parse(
        await handler(reportEvent(PRIYA, { remark: "First blocker" }))
      );
      assert.strictEqual(first.statusCode, 200);
      const afterFirst = mails.length;
      assert.ok(afterFirst > 0);
      const second = parse(
        await handler(reportEvent(PRIYA, { remark: "Second blocker" }))
      );
      assert.strictEqual(second.statusCode, 400);
      assert.strictEqual(mails.length, afterFirst);
    });
  });

  await test("invalid blocker report does not send email", async () => {
    await withMail(async (mails) => {
      const { ddb } = setup();
      const res = parse(await handler(reportEvent(PRIYA, { remark: "   " })));
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(mails.length, 0);
      assert.strictEqual(notifyItems(ddb).length, 0);
      assert.strictEqual(reminderItems(ddb).length, 0);
    });
  });

  await test("email failure is nonfatal and in-app blocker notify remains", async () => {
    const orig = email.sendEmail;
    email.sendEmail = async () => ({ ok: false, error: "MessageRejected" });
    try {
      const { ddb } = setup();
      const res = parse(
        await handler(reportEvent(PRIYA, { remark: "VPN down" }))
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(assignmentItem(ddb, PRIYA).blockerStatus, "ACTIVE");
      const inApp = notifyItems(ddb);
      assert.ok(inApp.length > 0);
      assert.ok(inApp.every((n) => n.type === "TASK_BLOCKER_REPORTED"));
      assert.ok(inApp.every((n) => n.path === "/admin/blockers"));
      assert.strictEqual(
        activityItems(ddb).filter((a) => a.action === "BLOCKER_REPORTED").length,
        1
      );
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

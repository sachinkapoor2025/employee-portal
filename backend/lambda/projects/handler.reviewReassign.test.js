process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.AWS_REGION = "ap-south-1";
process.env.WORK_TABLE = "work-table";
process.env.USER_ACCESS_TABLE = "access-table";

const assert = require("assert");
const email = require("../common/email");
email.sendEmail = async () => ({ ok: true, messageId: "ses-test" });
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { handler, setClientsForTests } = require("./handler");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const PROJECT_ID = "proj-review-1";
const TASK_ID = "task-review-1";
const ADMIN = "admin@mydgv.com";
const PRIYA = "priya@mydgv.com";
const RAHUL = "rahul@mydgv.com";
const ANKIT = "ankit@mydgv.com";
const OUTSIDER = "outsider@mydgv.com";
const FUTURE_START = "2099-12-31T18:00:00+05:30";
const FUTURE_DUE = "2099-12-31T19:00:00+05:30";
const NEW_START = "2099-12-31T18:15:00+05:30";
const NEW_DUE = "2099-12-31T19:45:00+05:30";
const ORIGINAL_REMARK = "Uploaded all 50 products.";

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

function seedAccess(ddb, email, role = "EMPLOYEE", status = "ACTIVE") {
  ddb.seed(ACCESS, {
    PK: email,
    SK: email,
    email,
    role,
    status,
  });
}

function seedShift(ddb, email) {
  ddb.seed(WORK, {
    PK: `USER#${email}`,
    SK: "SHIFT#CURRENT",
    shiftId: "morning",
    name: "Morning Shift",
    startTime: "11:00",
    endTime: "20:00",
    graceMinutes: 15,
    crossesMidnight: false,
  });
}

function setup({
  assignees = [PRIYA],
  assignmentStatuses,
  assignmentStatus = "REVIEW",
} = {}) {
  const ddb = createMemoryDdb();
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
  seedAccess(ddb, OUTSIDER);
  seedShift(ddb, PRIYA);
  seedShift(ddb, RAHUL);
  seedShift(ddb, ANKIT);
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${TASK_ID}`,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    title: "Banner update",
    description: "Original description",
    status: "REVIEW",
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
  for (const email of assignees) {
    ddb.seed(WORK, {
      PK: `TASK#${TASK_ID}`,
      SK: `ASSIGNMENT#${email}`,
      type: "ASSIGNMENT",
      taskId: TASK_ID,
      email,
      status: assignmentStatuses?.[email] || assignmentStatus,
      completionRemark:
        (assignmentStatuses?.[email] || assignmentStatus) === "REVIEW"
          ? ORIGINAL_REMARK
          : null,
      assignedAt: item.createdAt,
      assignedBy: ADMIN,
      removed: false,
    });
  }
  setClientsForTests({ ddb });
  return { ddb };
}

function eventFor(method, body, email = ADMIN) {
  return {
    httpMethod: method,
    path: "/tasks",
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: {
          email,
          "cognito:groups": email === ADMIN ? ["Admin"] : ["Employee"],
        },
      },
    },
  };
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function entityTask(ddb, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .find((item) => item.PK === "ENTITY#TASK" && item.taskId === taskId);
}

function assignmentItem(ddb, email, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .find(
      (item) =>
        item.PK === `TASK#${taskId}` && item.SK === `ASSIGNMENT#${email}`
    );
}

function activityItems(ddb, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .filter(
      (item) =>
        item.PK === `TASK#${taskId}` && String(item.SK).startsWith("ACTIVITY#")
    );
}

function createdFollowUps(ddb) {
  return ddb
    .of(WORK)
    .filter(
      (item) => item.PK === "ENTITY#TASK" && item.sourceTaskId === TASK_ID
    );
}

function reassignBody(extra = {}) {
  return {
    sourceTaskId: TASK_ID,
    assignmentEmail: PRIYA,
    reassignmentReason: "CHANGES_REQUIRED",
    reassignmentRemark: "Please add alt text.",
    assignees: [PRIYA],
    assignee: PRIYA,
    startDate: NEW_START,
    dueDate: NEW_DUE,
    ...extra,
  };
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

async function run() {
  await test("admin REVIEW to DONE via Approve & Complete", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        eventFor("PUT", {
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.status, "DONE");
    assert.ok(mine.completedAt);
    assert.strictEqual(mine.completionRemark, ORIGINAL_REMARK);
    assert.ok(activityItems(ddb).some((a) => a.action === "task_completed"));
    assert.strictEqual(createdFollowUps(ddb).length, 0);
  });

  await test("Changes Required creates a NEW task", async () => {
    const { ddb } = setup();
    const original = JSON.parse(JSON.stringify(entityTask(ddb)));
    const originalAssignment = JSON.parse(
      JSON.stringify(assignmentItem(ddb, PRIYA))
    );
    const res = parse(await handler(eventFor("POST", reassignBody())));
    assert.strictEqual(res.statusCode, 201);
    assert.ok(res.body.taskId);
    assert.notStrictEqual(res.body.taskId, TASK_ID);
    assert.strictEqual(res.body.sourceTaskId, TASK_ID);
    assert.strictEqual(res.body.reassignmentReason, "CHANGES_REQUIRED");
    assert.strictEqual(res.body.reassignmentRemark, "Please add alt text.");
    assert.strictEqual(res.body.reassignedBy, ADMIN);
    assert.ok(res.body.reassignedAt);
    assert.strictEqual(res.body.status, "TODO");
    assert.strictEqual(res.body.startDate, NEW_START);
    assert.strictEqual(res.body.dueDate, NEW_DUE);

    const created = entityTask(ddb, res.body.taskId);
    assert.strictEqual(created.sourceTaskId, TASK_ID);
    assert.strictEqual(created.title, "Banner update");
    assert.strictEqual(created.description, "Original description");
    assert.strictEqual(created.priority, "HIGH");
    assert.strictEqual(created.category, "Marketing");
    assert.strictEqual(assignmentItem(ddb, PRIYA, res.body.taskId).status, "TODO");

    const after = entityTask(ddb);
    assert.strictEqual(after.status, original.status);
    assert.strictEqual(after.description, original.description);
    assert.strictEqual(after.startDate, original.startDate);
    assert.strictEqual(after.dueDate, original.dueDate);
    const still = assignmentItem(ddb, PRIYA);
    assert.strictEqual(still.status, "REVIEW");
    assert.strictEqual(still.completionRemark, originalAssignment.completionRemark);
    assert.ok(
      activityItems(ddb).some(
        (a) => a.action === "task_reassigned" && /Please add alt text/.test(a.detail)
      )
    );
  });

  await test("Rejected creates a NEW task", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        eventFor(
          "POST",
          reassignBody({
            reassignmentReason: "REJECTED",
            reassignmentRemark: "Does not meet the brief.",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.reassignmentReason, "REJECTED");
    assert.notStrictEqual(res.body.taskId, TASK_ID);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
    assert.strictEqual(assignmentItem(ddb, PRIYA).completionRemark, ORIGINAL_REMARK);
  });

  await test("Same Employee uses the submitting employee", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        eventFor("POST", {
          sourceTaskId: TASK_ID,
          assignmentEmail: PRIYA,
          reassignmentReason: "CHANGES_REQUIRED",
          reassignmentRemark: "Please revise.",
          startDate: NEW_START,
          dueDate: NEW_DUE,
        })
      )
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(assignmentItem(ddb, PRIYA, res.body.taskId).email, PRIYA);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
  });

  await test("Another Employee uses selected employee", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        eventFor(
          "POST",
          reassignBody({
            assignees: [RAHUL],
            assignee: RAHUL,
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 201);
    assert.ok(assignmentItem(ddb, RAHUL, res.body.taskId));
    assert.ok(!assignmentItem(ddb, PRIYA, res.body.taskId));
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
    assert.strictEqual(assignmentItem(ddb, PRIYA).completionRemark, ORIGINAL_REMARK);
  });

  await test("Admin remark is required", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        eventFor(
          "POST",
          reassignBody({ reassignmentRemark: "   " })
        )
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error || "", /remark/i);
    assert.strictEqual(createdFollowUps(ddb).length, 0);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
  });

  await test("invalid reason is rejected", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        eventFor("POST", reassignBody({ reassignmentReason: "RETURNED" }))
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error || "", /reason/i);
    assert.strictEqual(createdFollowUps(ddb).length, 0);
  });

  await test("invalid schedule is rejected", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        eventFor(
          "POST",
          reassignBody({
            startDate: NEW_DUE,
            dueDate: NEW_START,
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(createdFollowUps(ddb).length, 0);
  });

  await test("non-admin cannot reassign a review", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(eventFor("POST", reassignBody(), PRIYA))
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(createdFollowUps(ddb).length, 0);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
  });

  await test("multi-assignee reassignment does not change other assignments", async () => {
    const { ddb } = setup({
      assignees: [PRIYA, ANKIT],
      assignmentStatuses: {
        [PRIYA]: "REVIEW",
        [ANKIT]: "IN_PROGRESS",
      },
    });
    const res = parse(await handler(eventFor("POST", reassignBody())));
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
    assert.strictEqual(assignmentItem(ddb, ANKIT).status, "IN_PROGRESS");
    assert.ok(!assignmentItem(ddb, ANKIT, res.body.taskId));
    assert.strictEqual(assignmentItem(ddb, PRIYA, res.body.taskId).status, "TODO");
  });

  await test("non-REVIEW assignment cannot be reassigned this way", async () => {
    const { ddb } = setup({ assignmentStatus: "IN_PROGRESS" });
    const res = parse(await handler(eventFor("POST", reassignBody())));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(createdFollowUps(ddb).length, 0);
  });

  await test("description override is applied only to the new task", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        eventFor(
          "POST",
          reassignBody({ description: "Revised banner copy." })
        )
      )
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(entityTask(ddb, res.body.taskId).description, "Revised banner copy.");
    assert.strictEqual(entityTask(ddb).description, "Original description");
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

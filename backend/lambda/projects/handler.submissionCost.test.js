process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.AWS_REGION = "ap-south-1";
process.env.WORK_TABLE = "work-table";
process.env.USER_ACCESS_TABLE = "access-table";
process.env.ATTENDANCE_TABLE = "attendance-table";
process.env.USER_PROFILE_TABLE = "profile-table";

const assert = require("assert");
const email = require("../common/email");
email.sendEmail = async () => ({ ok: true, messageId: "ses-test" });
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { handler, setClientsForTests } = require("./handler");
const { handlePutEmployee } = require("./costRates");
const { handleGetProjectCosting } = require("./costingReports");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const PROJECT_ID = "proj-cost-1";
const TASK_ID = "task-cost-1";
const ADMIN = "admin@mydgv.com";
const PRIYA = "priya@mydgv.com";
const SUPER = "boss@mydgv.com";
const FUTURE_START = "2099-12-31T18:00:00+05:30";
const FUTURE_DUE = "2099-12-31T19:00:00+05:30";
const NEXT_START = "2099-12-31T18:15:00+05:30";
const NEXT_DUE = "2099-12-31T19:45:00+05:30";

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
      if (command instanceof QueryCommand || command instanceof ScanCommand) {
        const { TableName, ExpressionAttributeValues = {} } = command.input;
        const pk = ExpressionAttributeValues[":pk"];
        const skPrefix = ExpressionAttributeValues[":sk"];
        const found = items
          .filter((row) => row.TableName === TableName)
          .filter((row) => (pk ? row.Item.PK === pk : true))
          .filter((row) =>
            skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true
          )
          .map((row) => ({ ...row.Item }));
        return { Items: found };
      }
      if (command instanceof TransactWriteCommand) {
        for (const op of command.input.TransactItems || []) {
          if (op.Put) this.seed(op.Put.TableName, op.Put.Item);
          if (op.Delete) {
            const key = op.Delete.Key;
            const idx = items.findIndex(
              (row) =>
                row.TableName === op.Delete.TableName &&
                row.Item.PK === key.PK &&
                row.Item.SK === key.SK
            );
            if (idx >= 0) items.splice(idx, 1);
          }
        }
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function eventFor(method, body, actor = PRIYA) {
  return {
    httpMethod: method,
    path: method === "POST" ? "/tasks" : "/tasks",
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: {
          email: actor,
          "cognito:groups": actor === ADMIN || actor === SUPER ? ["Admin"] : ["Employee"],
        },
      },
    },
  };
}

function parse(res) {
  return {
    statusCode: res.statusCode,
    body: typeof res.body === "string" ? JSON.parse(res.body) : res.body,
  };
}

function costItem(ddb, taskId, employee = PRIYA) {
  return ddb
    .of(WORK)
    .find((item) => item.PK === `TASK#${taskId}` && item.SK === `COST#${employee}`);
}

function assignmentItem(ddb, taskId, employee = PRIYA) {
  return ddb
    .of(WORK)
    .find(
      (item) => item.PK === `TASK#${taskId}` && item.SK === `ASSIGNMENT#${employee}`
    );
}

function setup() {
  const ddb = createMemoryDdb();
  ddb.seed(ACCESS, {
    PK: ADMIN,
    SK: ADMIN,
    email: ADMIN,
    role: "ADMIN",
    status: "ACTIVE",
  });
  ddb.seed(ACCESS, {
    PK: SUPER,
    SK: SUPER,
    email: SUPER,
    role: "SUPER_ADMIN",
    status: "ACTIVE",
  });
  ddb.seed(ACCESS, {
    PK: PRIYA,
    SK: PRIYA,
    email: PRIYA,
    role: "EMPLOYEE",
    status: "ACTIVE",
  });
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${PROJECT_ID}`,
    projectId: PROJECT_ID,
    name: "Portal",
    status: "ACTIVE",
    projectType: "INTERNAL",
  });
  ddb.seed(WORK, {
    PK: `USER#${PRIYA}`,
    SK: "SHIFT#CURRENT",
    shiftId: "morning",
    name: "Morning Shift",
    startTime: "11:00",
    endTime: "20:00",
    graceMinutes: 15,
    crossesMidnight: false,
  });
  ddb.seed(WORK, {
    PK: "ENTITY#DESIGNATION",
    SK: "DESIGNATION#seo",
    type: "DESIGNATION",
    designationId: "seo",
    name: "SEO",
    status: "ACTIVE",
    internalHourlyRate: 4,
    externalHourlyRate: 6,
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  ddb.seed(WORK, {
    PK: `USER#${PRIYA}`,
    SK: "COST_RATES",
    type: "EMPLOYEE_COST_RATES",
    email: PRIYA,
    designationId: "seo",
    status: "ACTIVE",
    internalHourlyRate: 10,
    externalHourlyRate: null,
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  const task = {
    PK: "ENTITY#TASK",
    SK: `TASK#${TASK_ID}`,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    title: "Costed submission",
    description: "",
    priority: "MEDIUM",
    status: "TODO",
    estimatedHours: 4,
    startDate: FUTURE_START,
    dueDate: FUTURE_DUE,
    assignee: PRIYA,
    assignees: [PRIYA],
    createdBy: ADMIN,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    archived: false,
  };
  ddb.seed(WORK, task);
  ddb.seed(WORK, { ...task, PK: `PROJECT#${PROJECT_ID}`, SK: `TASK#${TASK_ID}` });
  ddb.seed(WORK, {
    PK: `TASK#${TASK_ID}`,
    SK: `ASSIGNMENT#${PRIYA}`,
    type: "ASSIGNMENT",
    taskId: TASK_ID,
    email: PRIYA,
    status: "TODO",
    assignedAt: "2026-09-20T10:00:00.000Z",
    assignedBy: ADMIN,
    removed: false,
  });
  ddb.seed(WORK, {
    PK: `TASK#${TASK_ID}`,
    SK: "ATTACHMENT#proof-1",
    attachmentId: "proof-1",
    taskId: TASK_ID,
    s3Key: `tasks/${TASK_ID}/proof.pdf`,
    uploadedBy: PRIYA,
    uploadedAt: "2026-09-20T10:00:00.000Z",
  });
  setClientsForTests({ ddb });
  return ddb;
}

(async () => {
  const ddb = setup();

  const started = parse(
    await handler(
      eventFor("PUT", {
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        status: "IN_PROGRESS",
        assignmentEmail: PRIYA,
        plannedHours: 6,
      })
    )
  );
  assert.strictEqual(started.statusCode, 200);
  assert.strictEqual(assignmentItem(ddb, TASK_ID).plannedHours, 6);
  assert.strictEqual(
    ddb.of(WORK).find((item) => item.PK === "ENTITY#TASK" && item.taskId === TASK_ID)
      .estimatedHours,
    4
  );

  const submitted = parse(
    await handler(
      eventFor("PUT", {
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        status: "DONE",
        assignmentEmail: PRIYA,
        completionRemark: "Finished the first attempt.",
        actualHours: 7,
      })
    )
  );
  assert.strictEqual(submitted.statusCode, 200);
  const firstAssignment = assignmentItem(ddb, TASK_ID);
  assert.strictEqual(firstAssignment.status, "REVIEW");
  assert.strictEqual(firstAssignment.actualHours, 7);
  assert.ok(firstAssignment.submittedAt);
  assert.ok(firstAssignment.attemptId);
  const firstCost = costItem(ddb, TASK_ID);
  assert.strictEqual(firstCost.status, "COSTED");
  assert.strictEqual(firstCost.actualHours, 7);
  assert.strictEqual(firstCost.hourlyRateUsd, 10);
  assert.strictEqual(firstCost.amountUsd, 70);
  assert.strictEqual(firstCost.rateSource, "EMPLOYEE");
  assert.strictEqual(firstCost.submittedAt, firstAssignment.submittedAt);
  assert.strictEqual(firstCost.attemptId, firstAssignment.attemptId);
  assert.strictEqual(firstCost.projectType, "INTERNAL");

  const reassigned = parse(
    await handler(
      eventFor(
        "POST",
        {
          sourceTaskId: TASK_ID,
          assignmentEmail: PRIYA,
          reassignmentReason: "CHANGES_REQUIRED",
          reassignmentRemark: "Need another pass.",
          assignees: [PRIYA],
          assignee: PRIYA,
          startDate: NEXT_START,
          dueDate: NEXT_DUE,
          estimatedHours: 4,
        },
        ADMIN
      )
    )
  );
  assert.strictEqual(reassigned.statusCode, 201);
  const followId = reassigned.body.taskId;
  assert.strictEqual(costItem(ddb, TASK_ID).amountUsd, 70);
  assert.strictEqual(assignmentItem(ddb, TASK_ID).actualHours, 7);
  assert.strictEqual(assignmentItem(ddb, TASK_ID).completionRemark, "Finished the first attempt.");

  const followAssignment = assignmentItem(ddb, followId);
  ddb.seed(WORK, {
    PK: `TASK#${followId}`,
    SK: "ATTACHMENT#proof-2",
    attachmentId: "proof-2",
    taskId: followId,
    s3Key: `tasks/${followId}/proof.pdf`,
    uploadedBy: PRIYA,
    uploadedAt: followAssignment.assignedAt,
  });
  const second = parse(
    await handler(
      eventFor("PUT", {
        taskId: followId,
        projectId: PROJECT_ID,
        status: "DONE",
        assignmentEmail: PRIYA,
        completionRemark: "Second attempt.",
        actualHours: 3,
      })
    )
  );
  assert.strictEqual(second.statusCode, 200);
  const secondCost = costItem(ddb, followId);
  assert.strictEqual(secondCost.actualHours, 3);
  assert.strictEqual(secondCost.hourlyRateUsd, 10);
  assert.strictEqual(secondCost.amountUsd, 30);
  assert.notStrictEqual(secondCost.attemptId, firstCost.attemptId);
  assert.strictEqual(costItem(ddb, TASK_ID).amountUsd, 70);
  assert.strictEqual(costItem(ddb, TASK_ID).hourlyRateUsd, 10);

  const retry = parse(
    await handler(
      eventFor("PUT", {
        taskId: followId,
        projectId: PROJECT_ID,
        status: "DONE",
        assignmentEmail: PRIYA,
        completionRemark: "Second attempt again.",
        actualHours: 9,
      })
    )
  );
  assert.strictEqual(retry.statusCode, 200);
  assert.strictEqual(
    assignmentItem(ddb, followId).completionRemark,
    "Second attempt."
  );
  assert.strictEqual(costItem(ddb, followId).amountUsd, 30);
  assert.strictEqual(assignmentItem(ddb, followId).actualHours, 3);

  await handlePutEmployee({
    user: { email: SUPER },
    email: PRIYA,
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: new Date().toISOString(),
    body: { designationId: "seo", internalHourlyRate: 99, externalHourlyRate: null },
  });
  assert.strictEqual(costItem(ddb, TASK_ID).amountUsd, 70);
  assert.strictEqual(costItem(ddb, TASK_ID).hourlyRateUsd, 10);
  assert.strictEqual(costItem(ddb, followId).amountUsd, 30);
  assert.strictEqual(costItem(ddb, followId).hourlyRateUsd, 10);

  const blocked = parse(
    await handler(
      eventFor(
        "PUT",
        {
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
        },
        ADMIN
      )
    )
  );
  assert.strictEqual(blocked.statusCode, 409);
  assert.strictEqual(costItem(ddb, TASK_ID).amountUsd, 70);

  const approved = parse(
    await handler(
      eventFor(
        "PUT",
        {
          taskId: followId,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
        },
        ADMIN
      )
    )
  );
  assert.strictEqual(approved.statusCode, 200);
  assert.strictEqual(assignmentItem(ddb, followId).status, "DONE");
  assert.strictEqual(costItem(ddb, followId).amountUsd, 30);
  assert.strictEqual(costItem(ddb, followId).hourlyRateUsd, 10);

  const report = await handleGetProjectCosting({
    user: { email: ADMIN },
    projectId: PROJECT_ID,
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    profileTable: process.env.USER_PROFILE_TABLE,
    query: {},
  });
  assert.strictEqual(report.statusCode, 200);
  assert.strictEqual(report.body.summary.confirmedCostUsd, 100);

  const bare = createMemoryDdb();
  bare.seed(ACCESS, {
    PK: ADMIN,
    SK: ADMIN,
    email: ADMIN,
    role: "ADMIN",
    status: "ACTIVE",
  });
  bare.seed(ACCESS, {
    PK: PRIYA,
    SK: PRIYA,
    email: PRIYA,
    role: "EMPLOYEE",
    status: "ACTIVE",
  });
  bare.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${PROJECT_ID}`,
    projectId: PROJECT_ID,
    name: "Portal",
    status: "ACTIVE",
  });
  bare.seed(WORK, {
    PK: `USER#${PRIYA}`,
    SK: "SHIFT#CURRENT",
    shiftId: "morning",
    name: "Morning Shift",
    startTime: "11:00",
    endTime: "20:00",
    graceMinutes: 15,
    crossesMidnight: false,
  });
  const bareTask = {
    PK: "ENTITY#TASK",
    SK: `TASK#${TASK_ID}`,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    title: "No rate",
    status: "IN_PROGRESS",
    estimatedHours: 4,
    startDate: FUTURE_START,
    dueDate: FUTURE_DUE,
    assignee: PRIYA,
    assignees: [PRIYA],
    createdBy: ADMIN,
    createdAt: "2026-09-20T10:00:00.000Z",
    archived: false,
  };
  bare.seed(WORK, bareTask);
  bare.seed(WORK, { ...bareTask, PK: `PROJECT#${PROJECT_ID}` });
  bare.seed(WORK, {
    PK: `TASK#${TASK_ID}`,
    SK: `ASSIGNMENT#${PRIYA}`,
    type: "ASSIGNMENT",
    taskId: TASK_ID,
    email: PRIYA,
    status: "IN_PROGRESS",
    plannedHours: 6,
    assignedAt: "2026-09-20T10:00:00.000Z",
    assignedBy: ADMIN,
  });
  bare.seed(WORK, {
    PK: `TASK#${TASK_ID}`,
    SK: "ATTACHMENT#proof-1",
    attachmentId: "proof-1",
    taskId: TASK_ID,
    s3Key: "tasks/proof.pdf",
    uploadedBy: PRIYA,
    uploadedAt: "2026-09-20T10:00:00.000Z",
  });
  setClientsForTests({ ddb: bare });
  const missing = parse(
    await handler(
      eventFor("PUT", {
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        status: "DONE",
        assignmentEmail: PRIYA,
        completionRemark: "No rate on file.",
        actualHours: 7,
      })
    )
  );
  assert.strictEqual(missing.statusCode, 200);
  assert.strictEqual(assignmentItem(bare, TASK_ID).status, "REVIEW");
  assert.strictEqual(costItem(bare, TASK_ID).status, "MISSING_RATE");
  assert.strictEqual(costItem(bare, TASK_ID).amountUsd, null);
  assert.strictEqual(costItem(bare, TASK_ID).actualHours, 7);

  console.log("submission cost tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

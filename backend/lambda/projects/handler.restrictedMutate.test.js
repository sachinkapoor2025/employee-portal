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
} = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
email.sendEmail = async () => ({ ok: true, messageId: "ses-test" });
const { handler, setClientsForTests } = require("./handler");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const PROJECT_ID = "proj-vis-1";
const OTHER_TASK = "task-other";
const OWN_TASK = "task-own";
const OTHER_TITLE = "Vault other title";
const OWN_TITLE = "Own visible title";
const PA_ONLY = "assigned-only@mydgv.com";
const PA_ALL = "all-tasks@mydgv.com";
const MEMBER = "member@mydgv.com";
const WORKER = "worker@mydgv.com";

function createMemoryDdb() {
  const items = [];
  return {
    items,
    seed(tableName, item) {
      const idx = items.findIndex(
        (row) =>
          row.TableName === tableName &&
          row.Item.PK === item.PK &&
          row.Item.SK === item.SK
      );
      const entry = { TableName: tableName, Item: { ...item } };
      if (idx >= 0) items[idx] = entry;
      else items.push(entry);
    },
    of(tableName) {
      return items.filter((row) => row.TableName === tableName).map((row) => row.Item);
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

function seedAccess(ddb, email, role = "EMPLOYEE") {
  ddb.seed(ACCESS, {
    PK: email,
    SK: email,
    email,
    role,
    status: "ACTIVE",
  });
}

function seedProject(ddb) {
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${PROJECT_ID}`,
    projectId: PROJECT_ID,
    name: "Restricted vault",
    status: "ACTIVE",
    accessMode: "RESTRICTED",
  });
}

function seedAdmin(ddb, email, taskVisibility) {
  ddb.seed(WORK, {
    PK: `PROJECT#${PROJECT_ID}`,
    SK: `PROJECT_ADMIN#${email}`,
    type: "PROJECT_ADMIN",
    projectId: PROJECT_ID,
    email,
    status: "ACTIVE",
    taskVisibility,
  });
}

function seedMember(ddb, email) {
  ddb.seed(WORK, {
    PK: `PROJECT#${PROJECT_ID}`,
    SK: `MEMBER#${email}`,
    type: "PROJECT_MEMBER",
    projectId: PROJECT_ID,
    email,
    status: "ACTIVE",
  });
}

function seedTask(ddb, taskId, title, assignee) {
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
    taskId,
    projectId: PROJECT_ID,
    title,
    description: "Original description",
    status: "IN_PROGRESS",
    priority: "HIGH",
    assignee,
    assignees: [assignee],
    assignmentMode: "IMMEDIATE",
    assignmentState: "ASSIGNED",
    archived: false,
    createdBy: PA_ALL,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
  };
  ddb.seed(WORK, item);
  ddb.seed(WORK, {
    ...item,
    PK: `PROJECT#${PROJECT_ID}`,
    SK: `TASK#${taskId}`,
  });
  ddb.seed(WORK, {
    PK: `TASK#${taskId}`,
    SK: `ASSIGNMENT#${assignee}`,
    type: "ASSIGNMENT",
    taskId,
    email: assignee,
    status: "IN_PROGRESS",
    blockerStatus: "ACTIVE",
    blockerRemark: "Need a decision",
    assignedAt: item.createdAt,
    removed: false,
  });
}

function setup() {
  const ddb = createMemoryDdb();
  seedProject(ddb);
  seedAccess(ddb, PA_ONLY, "ADMIN");
  seedAccess(ddb, PA_ALL, "ADMIN");
  seedAccess(ddb, MEMBER, "EMPLOYEE");
  seedAccess(ddb, WORKER, "EMPLOYEE");
  seedAdmin(ddb, PA_ONLY, "ASSIGNED_ONLY");
  seedAdmin(ddb, PA_ALL, "ALL_PROJECT_TASKS");
  seedMember(ddb, MEMBER);
  seedMember(ddb, WORKER);
  seedMember(ddb, PA_ONLY);
  seedTask(ddb, OTHER_TASK, OTHER_TITLE, WORKER);
  seedTask(ddb, OWN_TASK, OWN_TITLE, PA_ONLY);
  setClientsForTests({ ddb });
  return ddb;
}

function eventFor(method, path, body, email) {
  return {
    httpMethod: method,
    path,
    body: JSON.stringify(body || {}),
    requestContext: {
      authorizer: {
        claims: {
          email,
          "cognito:groups": email === MEMBER || email === WORKER ? ["Employee"] : ["Admin"],
        },
      },
    },
  };
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function entityTask(ddb, taskId) {
  return ddb.of(WORK).find((item) => item.PK === "ENTITY#TASK" && item.taskId === taskId);
}

function assignment(ddb, taskId, email) {
  return ddb.of(WORK).find((item) => item.PK === `TASK#${taskId}` && item.SK === `ASSIGNMENT#${email}`);
}

(async () => {
  const ddb = setup();

  {
    const res = parse(
      await handler(eventFor("PUT", "/tasks", { taskId: OTHER_TASK, title: "Renamed" }, PA_ONLY))
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "Forbidden");
    assert.ok(!JSON.stringify(res.body).includes(OTHER_TITLE));
    assert.strictEqual(entityTask(ddb, OTHER_TASK).title, OTHER_TITLE);
  }

  {
    const res = parse(
      await handler(eventFor("DELETE", "/tasks", { taskId: OTHER_TASK }, PA_ONLY))
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "Forbidden");
    assert.ok(!JSON.stringify(res.body).includes(OTHER_TITLE));
    assert.strictEqual(entityTask(ddb, OTHER_TASK).archived, false);
  }

  {
    const before = ddb.of(WORK).filter((item) => item.PK === "ENTITY#TASK").length;
    const res = parse(
      await handler(
        eventFor(
          "POST",
          "/tasks",
          {
            sourceTaskId: OTHER_TASK,
            assignmentEmail: WORKER,
            reassignmentReason: "CHANGES_REQUIRED",
          },
          PA_ONLY
        )
      )
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "Forbidden");
    assert.ok(!JSON.stringify(res.body).includes(OTHER_TITLE));
    assert.strictEqual(ddb.of(WORK).filter((item) => item.PK === "ENTITY#TASK").length, before);
    assert.strictEqual(entityTask(ddb, OTHER_TASK).title, OTHER_TITLE);
  }

  {
    const res = parse(
      await handler(
        eventFor(
          "POST",
          `/tasks/${OTHER_TASK}/blocker/resolve`,
          { assignmentEmail: WORKER },
          PA_ONLY
        )
      )
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "Forbidden");
    assert.ok(!JSON.stringify(res.body).includes(OTHER_TITLE));
    assert.strictEqual(assignment(ddb, OTHER_TASK, WORKER).blockerStatus, "ACTIVE");
  }

  {
    const res = parse(
      await handler(eventFor("PUT", "/tasks", { taskId: OWN_TASK, title: "Own renamed" }, PA_ONLY))
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(entityTask(ddb, OWN_TASK).title, "Own renamed");
  }

  {
    const res = parse(
      await handler(
        eventFor(
          "POST",
          `/tasks/${OWN_TASK}/blocker/resolve`,
          { assignmentEmail: PA_ONLY },
          PA_ONLY
        )
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(assignment(ddb, OWN_TASK, PA_ONLY).blockerStatus, "RESOLVED");
  }

  {
    const res = parse(
      await handler(eventFor("PUT", "/tasks", { taskId: OTHER_TASK, title: "Member rename" }, MEMBER))
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "Forbidden");
    assert.strictEqual(entityTask(ddb, OTHER_TASK).title, OTHER_TITLE);
  }

  {
    const res = parse(
      await handler(eventFor("PUT", "/tasks", { taskId: OTHER_TASK, title: "Admin renamed" }, PA_ALL))
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(entityTask(ddb, OTHER_TASK).title, "Admin renamed");
  }

  {
    const res = parse(
      await handler(eventFor("DELETE", "/tasks", { taskId: OTHER_TASK }, PA_ALL))
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(entityTask(ddb, OTHER_TASK).archived, true);
  }

  console.log("restricted task mutation tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

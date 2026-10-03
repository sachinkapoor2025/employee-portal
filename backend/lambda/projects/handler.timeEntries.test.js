process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.AWS_REGION = "ap-south-1";
process.env.WORK_TABLE = "work-table";
process.env.USER_ACCESS_TABLE = "access-table";
process.env.ATTENDANCE_TABLE = "attendance-table";

const assert = require("assert");
const email = require("../common/email");
email.sendEmail = async () => ({ ok: true, messageId: "ses-test" });
const { GetCommand, PutCommand, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { handler, setClientsForTests } = require("./handler");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const PROJECT_ID = "proj-time-1";
const TASK_ID = "task-time-1";
const ADMIN = "admin@mydgv.com";
const PRIYA = "priya@mydgv.com";
const RAHUL = "rahul@mydgv.com";

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
        return {
          Items: items
            .filter((row) => row.TableName === command.input.TableName)
            .map((row) => ({ ...row.Item })),
        };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function seedAccess(ddb, emailAddr, role = "EMPLOYEE") {
  ddb.seed(ACCESS, {
    PK: emailAddr,
    SK: emailAddr,
    email: emailAddr,
    role,
    status: "ACTIVE",
  });
}

function setup() {
  const ddb = createMemoryDdb();
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${PROJECT_ID}`,
    projectId: PROJECT_ID,
    name: "Portal",
    status: "ACTIVE",
  });
  seedAccess(ddb, ADMIN, "ADMIN");
  seedAccess(ddb, PRIYA);
  seedAccess(ddb, RAHUL);
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${TASK_ID}`,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    title: "Banner",
    status: "TODO",
    estimatedHours: 4,
    assignee: PRIYA,
    assignees: [PRIYA],
    createdBy: ADMIN,
  };
  ddb.seed(WORK, item);
  ddb.seed(WORK, { ...item, PK: `PROJECT#${PROJECT_ID}` });
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
  setClientsForTests({ ddb });
  return { ddb };
}

function eventFor({ method, path, body, email }) {
  return {
    httpMethod: method,
    path,
    body: body ? JSON.stringify(body) : undefined,
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
  return {
    statusCode: res.statusCode,
    body: typeof res.body === "string" ? JSON.parse(res.body) : res.body,
  };
}

function assignment(ddb) {
  return ddb.items.find(
    (row) =>
      row.TableName === WORK &&
      row.Item.PK === `TASK#${TASK_ID}` &&
      row.Item.SK === `ASSIGNMENT#${PRIYA}`
  )?.Item;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function run() {
  await test("saves planned hours on the assignment", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        eventFor({
          method: "PUT",
          path: `/tasks/${TASK_ID}/planned-hours`,
          body: { hours: "2.25" },
          email: PRIYA,
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(assignment(ddb).plannedHours, 2.25);
    assert.strictEqual(res.body.assignments[0].plannedHours, 2.25);
    assert.strictEqual(res.body.estimatedHours, 4);
  });

  await test("rejects invalid planned hours", async () => {
    setup();
    for (const hours of [0, -1, "abc", ""]) {
      const res = parse(
        await handler(
          eventFor({
            method: "PUT",
            path: `/tasks/${TASK_ID}/planned-hours`,
            body: { hours },
            email: PRIYA,
          })
        )
      );
      assert.strictEqual(res.statusCode, 400);
    }
  });

  await test("another employee cannot set planned hours", async () => {
    setup();
    const res = parse(
      await handler(
        eventFor({
          method: "PUT",
          path: `/tasks/${TASK_ID}/planned-hours`,
          body: { hours: 2 },
          email: RAHUL,
        })
      )
    );
    assert.strictEqual(res.statusCode, 403);
  });

  await test("planned hours lock after start", async () => {
    const { ddb } = setup();
    assignment(ddb).status = "IN_PROGRESS";
    const res = parse(
      await handler(
        eventFor({
          method: "PUT",
          path: `/tasks/${TASK_ID}/planned-hours`,
          body: { hours: 5 },
          email: PRIYA,
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
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

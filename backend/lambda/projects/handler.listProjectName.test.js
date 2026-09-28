process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.AWS_REGION = "ap-south-1";
process.env.WORK_TABLE = "work-table";
process.env.USER_ACCESS_TABLE = "access-table";

const assert = require("assert");
const { GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { handler, setClientsForTests } = require("./handler");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const ADMIN = "admin@mydgv.com";
const PRIYA = "priya@mydgv.com";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_PROJECT = "33333333-3333-4333-8333-333333333333";
const START = "2099-12-01T09:00:00+05:30";
const DUE = "2099-12-31T18:00:00+05:30";

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

function seedProject(ddb, projectId, name) {
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${projectId}`,
    projectId,
    name,
    status: "ACTIVE",
    accessMode: "OPEN",
  });
}

function seedAssignedTask(ddb, extra = {}) {
  const taskId = extra.taskId;
  const projectId = extra.projectId;
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
    taskId,
    projectId,
    title: extra.title,
    description: extra.description || "",
    status: "TODO",
    priority: "MEDIUM",
    startDate: START,
    dueDate: DUE,
    assignee: PRIYA,
    assignees: [PRIYA],
    assignmentMode: "IMMEDIATE",
    assignmentState: "ASSIGNED",
    archived: false,
    createdBy: ADMIN,
    createdAt: extra.createdAt || "2026-09-20T10:00:00.000Z",
  };
  ddb.seed(WORK, item);
  ddb.seed(WORK, {
    ...item,
    PK: `PROJECT#${projectId}`,
    SK: `TASK#${taskId}`,
  });
  ddb.seed(WORK, {
    PK: `TASK#${taskId}`,
    SK: `ASSIGNMENT#${PRIYA}`,
    type: "ASSIGNMENT",
    taskId,
    email: PRIYA,
    status: "TODO",
    assignedAt: item.createdAt,
    assignedBy: ADMIN,
    removed: false,
  });
  return item;
}

function setup() {
  const ddb = createMemoryDdb();
  seedAccess(ddb, ADMIN, "ADMIN");
  seedAccess(ddb, PRIYA);
  setClientsForTests({ ddb });
  return ddb;
}

function eventFor(email, groups, query = {}) {
  return {
    httpMethod: "GET",
    path: "/tasks",
    queryStringParameters: query,
    requestContext: {
      authorizer: {
        claims: {
          email,
          "cognito:groups": groups,
        },
      },
    },
  };
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
    })
    .catch((err) => {
      console.error(`FAIL ${name}`);
      throw err;
    });
}

async function run() {
  await test("GET /tasks resolves project names from catalog records", async () => {
    const ddb = setup();
    seedProject(ddb, PROJECT_A, "Alpha Project");
    seedProject(ddb, PROJECT_B, "Beta Project");
    seedAssignedTask(ddb, {
      taskId: "task-a",
      projectId: PROJECT_A,
      title: "Task A",
    });
    seedAssignedTask(ddb, {
      taskId: "task-b",
      projectId: PROJECT_B,
      title: "Task B",
      createdAt: "2026-09-21T10:00:00.000Z",
    });
    const res = parse(
      await handler(eventFor(PRIYA, [], { mine: "true" }))
    );
    assert.strictEqual(res.statusCode, 200);
    const byId = Object.fromEntries(
      res.body.tasks.map((task) => [task.taskId, task])
    );
    assert.strictEqual(byId["task-a"].projectName, "Alpha Project");
    assert.strictEqual(byId["task-b"].projectName, "Beta Project");
    assert.notStrictEqual(byId["task-a"].projectName, PROJECT_A);
    assert.notStrictEqual(byId["task-b"].projectName, PROJECT_B);
  });

  await test("GET /tasks keeps an existing task projectName", async () => {
    const ddb = setup();
    seedProject(ddb, PROJECT_A, "Catalog Name");
    const item = seedAssignedTask(ddb, {
      taskId: "task-named",
      projectId: PROJECT_A,
      title: "Named task",
    });
    ddb.seed(WORK, { ...item, projectName: "Existing Task Name" });
    const res = parse(
      await handler(eventFor(PRIYA, [], { mine: "true" }))
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.tasks[0].projectName, "Existing Task Name");
  });

  await test("GET /tasks does not use projectId when the catalog name is missing", async () => {
    const ddb = setup();
    seedProject(ddb, UNKNOWN_PROJECT, "");
    seedAssignedTask(ddb, {
      taskId: "task-unknown",
      projectId: UNKNOWN_PROJECT,
      title: "Unknown project task",
    });
    const res = parse(
      await handler(eventFor(PRIYA, [], { mine: "true" }))
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.tasks.length, 1);
    assert.strictEqual(res.body.tasks[0].projectName, "");
    assert.notStrictEqual(res.body.tasks[0].projectName, UNKNOWN_PROJECT);
  });

  await test("GET /tasks zone filter still returns only matching tasks", async () => {
    const ddb = setup();
    seedProject(ddb, PROJECT_A, "Alpha Project");
    seedAssignedTask(ddb, {
      taskId: "task-green",
      projectId: PROJECT_A,
      title: "Open task",
    });
    const res = parse(
      await handler(
        eventFor(PRIYA, [], { mine: "true", zone: "COMPLETED" })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.tasks.map((task) => task.taskId), []);
  });

  console.log(`handler list projectName tests passed (${passed})`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

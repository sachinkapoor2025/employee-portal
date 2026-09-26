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
const PROJECT_ID = "proj-conflict-1";
const ADMIN = "admin@mydgv.com";
const SUPER = "super@mydgv.com";
const PRIYA = "priya@mydgv.com";
const RAHUL = "rahul@mydgv.com";
const START = "2026-09-25T22:00:00+05:30";
const DUE = "2026-09-26T07:00:00+05:30";

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

function seedPendingTask(ddb, extra = {}) {
  const taskId = extra.taskId || "task-conflict";
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
    taskId,
    projectId: PROJECT_ID,
    title: extra.title || "Night banner",
    status: extra.status || "TODO",
    startDate: extra.startDate || START,
    dueDate: extra.dueDate || DUE,
    assignee: "",
    assignees: [],
    assignments: [],
    assignmentMode: "SCHEDULED",
    assignmentState: extra.assignmentState || "PENDING",
    pendingAssignees: extra.pendingAssignees || [PRIYA],
    lastShiftFitByEmail: extra.lastShiftFitByEmail || {
      [PRIYA]: "SHIFT_CONFLICT",
    },
    archived: extra.archived === true,
    createdBy: ADMIN,
  };
  ddb.seed(WORK, item);
  ddb.seed(WORK, {
    ...item,
    PK: `PROJECT#${PROJECT_ID}`,
    SK: `TASK#${taskId}`,
  });
  return item;
}

function seedAssignedTask(ddb) {
  const taskId = "task-assigned";
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
    taskId,
    projectId: PROJECT_ID,
    title: "Assigned banner",
    status: "TODO",
    startDate: START,
    dueDate: DUE,
    assignee: PRIYA,
    assignees: [PRIYA],
    assignmentMode: "IMMEDIATE",
    assignmentState: "ASSIGNED",
    archived: false,
    createdBy: ADMIN,
  };
  ddb.seed(WORK, item);
  ddb.seed(WORK, {
    PK: `TASK#${taskId}`,
    SK: `ASSIGNMENT#${PRIYA}`,
    type: "ASSIGNMENT",
    taskId,
    email: PRIYA,
    status: "TODO",
    assignedAt: "2026-09-20T10:00:00.000Z",
    assignedBy: ADMIN,
    removed: false,
  });
  return item;
}

function setup() {
  const ddb = createMemoryDdb();
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: `PROJECT#${PROJECT_ID}`,
    projectId: PROJECT_ID,
    name: "Portal",
    status: "ACTIVE",
    accessMode: "OPEN",
  });
  seedAccess(ddb, ADMIN, "ADMIN");
  seedAccess(ddb, SUPER, "SUPER_ADMIN");
  seedAccess(ddb, PRIYA);
  seedAccess(ddb, RAHUL);
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

function ids(body) {
  return (body.tasks || []).map((t) => t.taskId).sort();
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
  await test("admin SHIFT_CONFLICT read returns pending conflict for assignee", async () => {
    const ddb = setup();
    seedPendingTask(ddb);
    seedAssignedTask(ddb);
    const res = parse(
      await handler(
        eventFor(ADMIN, ["Admin"], {
          assignee: PRIYA,
          includePendingShiftConflicts: "true",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(ids(res.body), ["task-assigned", "task-conflict"]);
    const conflict = res.body.tasks.find((t) => t.taskId === "task-conflict");
    assert.strictEqual(conflict.lastShiftFitByEmail[PRIYA], "SHIFT_CONFLICT");
    assert.deepStrictEqual(conflict.pendingAssignees, [PRIYA]);
  });

  await test("admin NO_SHIFT read returns pending no-shift for assignee", async () => {
    const ddb = setup();
    seedPendingTask(ddb, {
      taskId: "task-noshift",
      title: "Uncovered evening job",
      lastShiftFitByEmail: { [PRIYA]: "NO_SHIFT" },
    });
    const res = parse(
      await handler(
        eventFor(ADMIN, ["Admin"], {
          assignee: PRIYA,
          includePendingShiftConflicts: "true",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(ids(res.body), ["task-noshift"]);
    assert.strictEqual(
      res.body.tasks[0].lastShiftFitByEmail[PRIYA],
      "NO_SHIFT"
    );
  });

  await test("default GET /tasks still hides pending conflicts", async () => {
    const ddb = setup();
    seedPendingTask(ddb);
    seedAssignedTask(ddb);
    const res = parse(
      await handler(eventFor(ADMIN, ["Admin"], { assignee: PRIYA }))
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(ids(res.body), ["task-assigned"]);
  });

  await test("pendingAssignees membership is required", async () => {
    const ddb = setup();
    seedPendingTask(ddb, {
      pendingAssignees: [RAHUL],
      lastShiftFitByEmail: {
        [RAHUL]: "SHIFT_CONFLICT",
        [PRIYA]: "SHIFT_CONFLICT",
      },
    });
    const res = parse(
      await handler(
        eventFor(ADMIN, ["Admin"], {
          assignee: PRIYA,
          includePendingShiftConflicts: "true",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(ids(res.body), []);
  });

  await test("unrelated employee conflict is excluded", async () => {
    const ddb = setup();
    seedPendingTask(ddb, {
      pendingAssignees: [RAHUL],
      lastShiftFitByEmail: { [RAHUL]: "SHIFT_CONFLICT" },
    });
    const res = parse(
      await handler(
        eventFor(ADMIN, ["Admin"], {
          assignee: PRIYA,
          includePendingShiftConflicts: "true",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(ids(res.body), []);
  });

  await test("archived pending conflict is excluded", async () => {
    const ddb = setup();
    seedPendingTask(ddb, { archived: true });
    const res = parse(
      await handler(
        eventFor(ADMIN, ["Admin"], {
          assignee: PRIYA,
          includePendingShiftConflicts: "true",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(ids(res.body), []);
  });

  await test("already assigned task is not returned only as a conflict", async () => {
    const ddb = setup();
    seedAssignedTask(ddb);
    const res = parse(
      await handler(
        eventFor(ADMIN, ["Admin"], {
          assignee: PRIYA,
          includePendingShiftConflicts: "true",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(ids(res.body), ["task-assigned"]);
    assert.strictEqual(res.body.tasks[0].assignmentState, "ASSIGNED");
  });

  await test("Super Admin can read pending conflicts", async () => {
    const ddb = setup();
    seedPendingTask(ddb);
    const res = parse(
      await handler(
        eventFor(SUPER, ["Admin"], {
          assignee: PRIYA,
          includePendingShiftConflicts: "true",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(ids(res.body), ["task-conflict"]);
  });

  await test("employee cannot access the conflict read", async () => {
    setup();
    const res = parse(
      await handler(
        eventFor(PRIYA, ["Employee"], {
          assignee: PRIYA,
          includePendingShiftConflicts: "true",
        })
      )
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "Admin required");
  });

  await test("Cognito Admin without UserAccess cannot access the conflict read", async () => {
    const ddb = setup();
    seedAccess(ddb, ADMIN, "EMPLOYEE");
    const res = parse(
      await handler(
        eventFor(ADMIN, ["Admin"], {
          assignee: PRIYA,
          includePendingShiftConflicts: "true",
        })
      )
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "Admin required");
  });

  console.log(`handler.pendingShiftConflicts tests passed (${passed})`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

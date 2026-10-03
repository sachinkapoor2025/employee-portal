process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";
process.env.AWS_REGION = "ap-south-1";
process.env.WORK_TABLE = "work-table";
process.env.USER_ACCESS_TABLE = "access-table";
process.env.ATTENDANCE_TABLE = "attendance-table";

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
const { ASSIGNED_SHIFT_FIT } = require("./assignedShiftFit");
const { handler, setClientsForTests } = require("./handler");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const ATTENDANCE = process.env.ATTENDANCE_TABLE;
const PROJECT_ID = "proj-post-1";
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
        const { TableName } = command.input;
        return {
          Items: items
            .filter((row) => row.TableName === TableName)
            .map((row) => ({ ...row.Item })),
        };
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

function seedShift(ddb, emailAddr, extra = {}) {
  ddb.seed(WORK, {
    PK: `USER#${emailAddr}`,
    SK: "SHIFT#CURRENT",
    shiftId: extra.shiftId || "afternoon",
    name: extra.name || "Afternoon Shift",
    startTime: extra.startTime || "14:00",
    endTime: extra.endTime || "19:00",
    graceMinutes: extra.graceMinutes ?? 15,
    crossesMidnight: extra.crossesMidnight === true,
    ...extra,
  });
}

function seedAttendance(ddb, emailAddr, date, extra = {}) {
  ddb.seed(ATTENDANCE, {
    PK: emailAddr,
    SK: date,
    email: emailAddr,
    date,
    ...extra,
  });
}

function setup({ shifts } = {}) {
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
  if (shifts === undefined) {
    seedShift(ddb, PRIYA);
    seedShift(ddb, RAHUL);
  } else {
    for (const [emailAddr, extra] of Object.entries(shifts || {})) {
      if (extra) seedShift(ddb, emailAddr, extra);
    }
  }
  setClientsForTests({ ddb });
  return { ddb };
}

function adminPost(body, emailAddr = ADMIN) {
  return {
    httpMethod: "POST",
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

function sameInstant(actual, expected) {
  assert.strictEqual(Date.parse(actual), Date.parse(expected));
}

function entityTasks(ddb) {
  return ddb.of(WORK).filter((item) => item.PK === "ENTITY#TASK");
}

function assignmentRows(ddb) {
  return ddb
    .of(WORK)
    .filter((item) => String(item.SK || "").startsWith("ASSIGNMENT#"));
}

function activityRows(ddb) {
  return ddb
    .of(WORK)
    .filter((item) => String(item.SK || "").startsWith("ACTIVITY#"));
}

function createBody(extra = {}) {
  return {
    projectId: PROJECT_ID,
    title: "Halloween: Complete Halloween website testing",
    description: "Complete Halloween website testing.",
    priority: "HIGH",
    assignees: [PRIYA],
    startDate: "2026-09-28T16:00:00+05:30",
    dueDate: "2026-09-30T19:00:00+05:30",
    ...extra,
  };
}

function assertNothingPersisted(ddb) {
  assert.strictEqual(entityTasks(ddb).length, 0);
  assert.strictEqual(assignmentRows(ddb).length, 0);
  assert.strictEqual(activityRows(ddb).length, 0);
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
  await test("afternoon 11:00 to later 20:00 is SHIFT_CONFLICT and does not persist", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        adminPost(
          createBody({
            startDate: "2026-09-28T11:00:00+05:30",
            dueDate: "2026-10-03T20:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assert.ok(/priya@mydgv.com/.test(res.body.error));
    assertNothingPersisted(ddb);
  });

  await test("afternoon 16:00 to next-day 19:00 succeeds and assigns", async () => {
    const { ddb } = setup();
    const res = parse(await handler(adminPost(createBody())));
    assert.strictEqual(res.statusCode, 201);
    const task = entityTasks(ddb)[0];
    assert.ok(task);
    assert.strictEqual(task.startDate, "2026-09-28T16:00:00+05:30");
    assert.strictEqual(task.dueDate, "2026-09-30T19:00:00+05:30");
    const assignments = assignmentRows(ddb);
    assert.strictEqual(assignments.length, 1);
    assert.strictEqual(assignments[0].email, PRIYA);
    assert.strictEqual(assignments[0].status, "TODO");
    assert.strictEqual(task.estimatedHours, null);
    assert.strictEqual(task.durationHours, null);
  });

  await test("estimatedHours 2.25 persists on canonical and project copy", async () => {
    const { ddb } = setup();
    const res = parse(await handler(adminPost(createBody({ estimatedHours: "2.25" }))));
    assert.strictEqual(res.statusCode, 201);
    const task = entityTasks(ddb)[0];
    assert.strictEqual(task.estimatedHours, 2.25);
    assert.strictEqual(task.durationType, null);
    const copy = ddb.of(WORK).find(
      (item) => item.PK === `PROJECT#${PROJECT_ID}` && item.SK === `TASK#${task.taskId}`
    );
    assert.ok(copy);
    assert.strictEqual(copy.estimatedHours, 2.25);
  });

  await test("invalid estimatedHours is rejected and does not persist", async () => {
    const { ddb } = setup();
    const res = parse(await handler(adminPost(createBody({ estimatedHours: 0 }))));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.errors.estimatedHours);
    assertNothingPersisted(ddb);
  });

  await test("afternoon 16:00 to next-day 18:00 succeeds", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        adminPost(
          createBody({
            startDate: "2026-09-28T16:00:00+05:30",
            dueDate: "2026-09-30T18:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(entityTasks(ddb)[0].dueDate, "2026-09-30T18:00:00+05:30");
    assert.strictEqual(assignmentRows(ddb).length, 1);
  });

  await test("afternoon 11:00 to next-day 20:00 is SHIFT_CONFLICT", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        adminPost(
          createBody({
            startDate: "2026-09-28T11:00:00+05:30",
            dueDate: "2026-09-30T20:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assertNothingPersisted(ddb);
  });

  await test("afternoon 16:00 to next-day 20:00 is SHIFT_CONFLICT", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        adminPost(
          createBody({
            startDate: "2026-09-28T16:00:00+05:30",
            dueDate: "2026-09-30T20:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assertNothingPersisted(ddb);
  });

  await test("afternoon 13:00 to next-day 19:00 is SHIFT_CONFLICT", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        adminPost(
          createBody({
            startDate: "2026-09-28T13:00:00+05:30",
            dueDate: "2026-09-30T19:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assertNothingPersisted(ddb);
  });

  await test("same-day 18:00 to 20:00 is SHIFT_CONFLICT", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        adminPost(
          createBody({
            startDate: "2026-09-28T18:00:00+05:30",
            dueDate: "2026-09-28T20:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assertNothingPersisted(ddb);
  });

  await test("overnight valid interval succeeds", async () => {
    const { ddb } = setup({
      shifts: {
        [PRIYA]: {
          shiftId: "night",
          name: "Night Shift",
          startTime: "22:00",
          endTime: "06:00",
          crossesMidnight: true,
        },
      },
    });
    const res = parse(
      await handler(
        adminPost(
          createBody({
            startDate: "2026-09-23T23:00:00+05:30",
            dueDate: "2026-09-24T02:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(entityTasks(ddb)[0].dueDate, "2026-09-24T02:00:00+05:30");
    assert.strictEqual(assignmentRows(ddb).length, 1);
  });

  await test("overnight invalid interval is SHIFT_CONFLICT", async () => {
    const { ddb } = setup({
      shifts: {
        [PRIYA]: {
          shiftId: "night",
          name: "Night Shift",
          startTime: "22:00",
          endTime: "06:00",
          crossesMidnight: true,
        },
      },
    });
    const res = parse(
      await handler(
        adminPost(
          createBody({
            startDate: "2026-09-24T05:00:00+05:30",
            dueDate: "2026-09-24T07:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assertNothingPersisted(ddb);
  });

  await test("NO_SHIFT remains NO_SHIFT and does not persist", async () => {
    const { ddb } = setup({
      shifts: {
        [PRIYA]: { startTime: "14:00", endTime: "19:00" },
      },
    });
    const res = parse(
      await handler(
        adminPost(
          createBody({
            assignees: [RAHUL],
            startDate: "2026-09-28T16:00:00+05:30",
            dueDate: "2026-09-28T18:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.NO_SHIFT);
    assert.ok(/rahul@mydgv.com/.test(res.body.error));
    assertNothingPersisted(ddb);
  });

  await test("Week Off postpones +24h then assigns", async () => {
    const { ddb } = setup();
    seedAttendance(ddb, PRIYA, "2026-09-28", { status: "Week Off" });
    const res = parse(await handler(adminPost(createBody())));
    assert.strictEqual(res.statusCode, 201);
    sameInstant(entityTasks(ddb)[0].startDate, "2026-09-29T16:00:00+05:30");
    sameInstant(entityTasks(ddb)[0].dueDate, "2026-10-01T19:00:00+05:30");
    assert.strictEqual(assignmentRows(ddb).length, 1);
  });

  await test("Leave postpones +24h then assigns", async () => {
    const { ddb } = setup();
    seedAttendance(ddb, PRIYA, "2026-09-28", { status: "Leave" });
    const res = parse(await handler(adminPost(createBody())));
    assert.strictEqual(res.statusCode, 201);
    sameInstant(entityTasks(ddb)[0].startDate, "2026-09-29T16:00:00+05:30");
    assert.strictEqual(assignmentRows(ddb).length, 1);
  });

  await test("mixed Week Off and Leave postpone through to a working day", async () => {
    const { ddb } = setup();
    seedAttendance(ddb, PRIYA, "2026-09-29", { status: "Week Off" });
    seedAttendance(ddb, PRIYA, "2026-09-30", { status: "Leave" });
    seedAttendance(ddb, PRIYA, "2026-10-01", { status: "WeeklyOff" });
    const res = parse(
      await handler(
        adminPost(
          createBody({
            startDate: "2026-09-29T16:00:00+05:30",
            dueDate: "2026-10-02T19:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 201);
    sameInstant(entityTasks(ddb)[0].startDate, "2026-10-02T16:00:00+05:30");
    sameInstant(entityTasks(ddb)[0].dueDate, "2026-10-05T19:00:00+05:30");
    assert.strictEqual(assignmentRows(ddb).length, 1);
  });

  await test("Week Off postponement still SHIFT_CONFLICT if times do not fit", async () => {
    const { ddb } = setup();
    seedAttendance(ddb, PRIYA, "2026-09-28", { status: "Week Off" });
    const res = parse(
      await handler(
        adminPost(
          createBody({
            startDate: "2026-09-28T18:00:00+05:30",
            dueDate: "2026-09-28T20:00:00+05:30",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assertNothingPersisted(ddb);
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

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
  ScanCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  putChangesAssignedShiftFit,
  ASSIGNED_SHIFT_FIT,
} = require("./assignedShiftFit");
const { handler, setClientsForTests } = require("./handler");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const PROJECT_ID = "proj-put-1";
const TASK_ID = "task-put-1";
const ADMIN = "admin@mydgv.com";
const PRIYA = "priya@mydgv.com";
const RAHUL = "rahul@mydgv.com";
const ANKIT = "ankit@mydgv.com";
const OUTSIDER = "outsider@mydgv.com";

const START = "2026-09-22T18:00:00+05:30";
const DUE = "2026-09-22T20:00:00+05:30";
const FUTURE_START = "2099-12-31T18:00:00+05:30";
const FUTURE_DUE = "2099-12-31T20:00:00+05:30";
const PAST_DUE = "2020-01-01T18:00:00+05:30";

assert.strictEqual(
  putChangesAssignedShiftFit({
    currentEmails: [PRIYA],
    nextEmails: [PRIYA],
    currentStart: START,
    nextStart: START,
    currentDue: DUE,
    nextDue: DUE,
  }),
  false
);
assert.strictEqual(
  putChangesAssignedShiftFit({
    currentEmails: [PRIYA],
    nextEmails: [RAHUL],
    currentStart: START,
    nextStart: START,
    currentDue: DUE,
    nextDue: DUE,
  }),
  true
);
assert.strictEqual(
  putChangesAssignedShiftFit({
    currentEmails: [PRIYA],
    nextEmails: [PRIYA],
    currentStart: START,
    nextStart: "2026-09-22T18:15:00+05:30",
    currentDue: DUE,
    nextDue: DUE,
  }),
  true
);

function createMemoryDdb() {
  const items = [];
  function keyOf(tableName, item) {
    return `${tableName}|${item.PK}|${item.SK}`;
  }
  return {
    items,
    shiftGets: 0,
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
        if (Key?.SK === "SHIFT#CURRENT") this.shiftGets += 1;
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

function seedAccess(ddb, email, role = "EMPLOYEE", status = "ACTIVE") {
  ddb.seed(ACCESS, {
    PK: email,
    SK: email,
    email,
    role,
    status,
  });
}

function seedShift(ddb, email, extra = {}) {
  ddb.seed(WORK, {
    PK: `USER#${email}`,
    SK: "SHIFT#CURRENT",
    shiftId: extra.shiftId || "morning",
    name: extra.name || "Morning Shift",
    startTime: extra.startTime || "11:00",
    endTime: extra.endTime || "20:00",
    graceMinutes: extra.graceMinutes ?? 15,
    crossesMidnight: extra.crossesMidnight === true,
    ...extra,
  });
}

function seedTask(ddb, extra = {}) {
  const emails = extra.assignees || [PRIYA];
  const item = {
    PK: "ENTITY#TASK",
    SK: `TASK#${TASK_ID}`,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    title: extra.title || "Banner update",
    description: extra.description || "Original description",
    status: extra.status || "TODO",
    priority: "HIGH",
    startDate: extra.startDate || START,
    dueDate: extra.dueDate || DUE,
    assignee: emails[0],
    assignees: emails,
    assignmentMode: extra.assignmentMode || "IMMEDIATE",
    assignmentState: extra.assignmentState || "ASSIGNED",
    createdBy: ADMIN,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    archived: false,
  };
  item.SK = `TASK#${item.taskId}`;
  ddb.seed(WORK, item);
  ddb.seed(WORK, {
    ...item,
    PK: `PROJECT#${PROJECT_ID}`,
    SK: `TASK#${item.taskId}`,
  });
  for (const email of emails) {
    ddb.seed(WORK, {
      PK: `TASK#${item.taskId}`,
      SK: `ASSIGNMENT#${email}`,
      type: "ASSIGNMENT",
      taskId: item.taskId,
      email,
      status: extra.assignmentStatuses?.[email] || extra.assignmentStatus || "TODO",
      assignedAt: item.createdAt,
      assignedBy: ADMIN,
      removed: false,
    });
  }
  return item;
}

function setup({ assignees, startDate, dueDate, title, shifts, assignmentStatuses, assignmentStatus } = {}) {
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
  const emails = assignees || [PRIYA];
  if (shifts === undefined) {
    seedShift(ddb, PRIYA);
    seedShift(ddb, RAHUL);
    seedShift(ddb, ANKIT);
  } else {
    for (const [email, extra] of Object.entries(shifts || {})) {
      if (extra) seedShift(ddb, email, extra);
    }
  }
  const task = seedTask(ddb, {
    assignees: emails,
    startDate,
    dueDate,
    title,
    assignmentStatuses,
    assignmentStatus,
  });
  setClientsForTests({ ddb });
  return { ddb, task };
}

function adminEvent(body, email = ADMIN) {
  return {
    httpMethod: "PUT",
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

function employeeEvent(body, email = PRIYA) {
  return {
    httpMethod: "PUT",
    path: "/tasks",
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: {
          email,
          "cognito:groups": ["Employee"],
        },
      },
    },
  };
}

function assignmentItem(ddb, email, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .find((item) => item.PK === `TASK#${taskId}` && item.SK === `ASSIGNMENT#${email}`);
}

function liveAssignment(ddb, email, taskId = TASK_ID) {
  const row = ddb.items.find(
    (entry) =>
      entry.TableName === WORK &&
      entry.Item.PK === `TASK#${taskId}` &&
      entry.Item.SK === `ASSIGNMENT#${email}`
  );
  return row ? row.Item : null;
}

function activityItems(ddb, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .filter(
      (item) =>
        item.PK === `TASK#${taskId}` && String(item.SK).startsWith("ACTIVITY#")
    );
}

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function entityTask(ddb) {
  return ddb.of(WORK).find((item) => item.PK === "ENTITY#TASK" && item.taskId === TASK_ID);
}

function assignmentEmails(ddb) {
  return ddb
    .of(WORK)
    .filter(
      (item) =>
        item.PK === `TASK#${TASK_ID}` &&
        String(item.SK).startsWith("ASSIGNMENT#") &&
        !item.removed
    )
    .map((item) => item.email)
    .sort();
}

function activityCount(ddb) {
  return ddb
    .of(WORK)
    .filter(
      (item) =>
        item.PK === `TASK#${TASK_ID}` && String(item.SK).startsWith("ACTIVITY#")
    ).length;
}

function snapshot(ddb) {
  return {
    task: { ...entityTask(ddb) },
    assignments: assignmentEmails(ddb),
    activities: activityCount(ddb),
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
  await test("valid same-shift edit succeeds", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          startDate: "2026-09-22T18:15:00+05:30",
          dueDate: "2026-09-22T19:45:00+05:30",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(entityTask(ddb).startDate, "2026-09-22T18:15:00+05:30");
    assert.strictEqual(entityTask(ddb).dueDate, "2026-09-22T19:45:00+05:30");
    assert.deepStrictEqual(assignmentEmails(ddb), [PRIYA]);
    assert.ok(ddb.shiftGets >= 1);
  });

  await test("valid reassignment succeeds", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          assignees: [RAHUL],
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(assignmentEmails(ddb), [RAHUL]);
    assert.ok(ddb.shiftGets >= 1);
  });

  await test("start/end change into shift conflict is rejected", async () => {
    const { ddb } = setup();
    const before = snapshot(ddb);
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          startDate: "2026-09-22T18:00:00+05:30",
          dueDate: "2026-09-22T21:00:00+05:30",
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assert.ok(/priya@mydgv.com/.test(res.body.error));
    const after = snapshot(ddb);
    assert.deepStrictEqual(after.task, before.task);
    assert.deepStrictEqual(after.assignments, before.assignments);
    assert.strictEqual(after.activities, before.activities);
  });

  await test("reassignment to employee with conflicting shift is rejected", async () => {
    const { ddb } = setup({
      shifts: {
        [PRIYA]: { startTime: "11:00", endTime: "20:00" },
        [RAHUL]: { startTime: "09:00", endTime: "17:00" },
      },
    });
    const before = snapshot(ddb);
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          assignees: [RAHUL],
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assert.strictEqual(res.body.email, RAHUL);
    const after = snapshot(ddb);
    assert.deepStrictEqual(after.task, before.task);
    assert.deepStrictEqual(after.assignments, [PRIYA]);
    assert.strictEqual(after.activities, 0);
  });

  await test("reassignment to employee with NO_SHIFT is rejected", async () => {
    const { ddb } = setup({
      shifts: {
        [PRIYA]: { startTime: "11:00", endTime: "20:00" },
      },
    });
    const before = snapshot(ddb);
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          assignees: [RAHUL],
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.NO_SHIFT);
    assert.ok(/rahul@mydgv.com/.test(res.body.error));
    const after = snapshot(ddb);
    assert.deepStrictEqual(after.task, before.task);
    assert.deepStrictEqual(after.assignments, before.assignments);
    assert.strictEqual(after.activities, 0);
  });

  await test("multi-assignee all fit succeeds", async () => {
    const { ddb } = setup();
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          assignees: [PRIYA, RAHUL],
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(assignmentEmails(ddb), [PRIYA, RAHUL].sort());
  });

  await test("multi-assignee one conflict rejects entire PUT and leaves task unchanged", async () => {
    const { ddb } = setup({
      shifts: {
        [PRIYA]: { startTime: "11:00", endTime: "20:00" },
        [RAHUL]: { startTime: "09:00", endTime: "17:00" },
      },
    });
    const before = snapshot(ddb);
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          assignees: [PRIYA, RAHUL],
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    const after = snapshot(ddb);
    assert.deepStrictEqual(after.task, before.task);
    assert.deepStrictEqual(after.assignments, [PRIYA]);
    assert.strictEqual(after.activities, 0);
  });

  await test("overnight shift valid interval succeeds", async () => {
    const { ddb } = setup({
      startDate: "2026-09-23T23:00:00+05:30",
      dueDate: "2026-09-24T02:00:00+05:30",
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
        adminEvent({
          taskId: TASK_ID,
          startDate: "2026-09-23T23:00:00+05:30",
          dueDate: "2026-09-24T05:00:00+05:30",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(entityTask(ddb).dueDate, "2026-09-24T05:00:00+05:30");
  });

  await test("overnight shift invalid interval rejected", async () => {
    const { ddb } = setup({
      startDate: "2026-09-23T23:00:00+05:30",
      dueDate: "2026-09-24T02:00:00+05:30",
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
    const before = snapshot(ddb);
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          startDate: "2026-09-24T05:00:00+05:30",
          dueDate: "2026-09-24T07:00:00+05:30",
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assert.deepStrictEqual(snapshot(ddb).task, before.task);
  });

  await test("unrelated task edit does not invoke shift-fit", async () => {
    const { ddb } = setup();
    ddb.shiftGets = 0;
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          title: "Renamed banner",
          description: "Copy only",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(entityTask(ddb).title, "Renamed banner");
    assert.strictEqual(ddb.shiftGets, 0);
  });

  await test("existing authorization and validation remain intact", async () => {
    setup();
    const missing = parse(await handler(adminEvent({ title: "x" })));
    assert.strictEqual(missing.statusCode, 400);
    assert.match(missing.body.error, /taskId required/);

    const unauth = parse(
      await handler({
        httpMethod: "PUT",
        path: "/tasks",
        body: JSON.stringify({ taskId: TASK_ID, title: "x" }),
        requestContext: { authorizer: { claims: {} } },
      })
    );
    assert.strictEqual(unauth.statusCode, 401);

    const { ddb } = setup();
    const forbidden = parse(
      await handler(
        adminEvent(
          { taskId: TASK_ID, title: "Hacked" },
          OUTSIDER
        )
      )
    );
    assert.strictEqual(forbidden.statusCode, 403);
    assert.strictEqual(entityTask(ddb).title, "Banner update");

    const sameAssignees = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          assignees: [PRIYA],
          title: "Same people",
        })
      )
    );
    assert.strictEqual(sameAssignees.statusCode, 200);
  });

  await test("employee DONE without completionRemark is 400", async () => {
    const { ddb } = setup({ startDate: FUTURE_START, dueDate: FUTURE_DUE });
    const before = snapshot(ddb);
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error || "", /Completion Remark/i);
    const after = snapshot(ddb);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "TODO");
    assert.ok(!assignmentItem(ddb, PRIYA).completionRemark);
    assert.deepStrictEqual(after.task.status, before.task.status);
    assert.strictEqual(after.activities, before.activities);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("employee DONE with empty completionRemark is 400", async () => {
    const { ddb } = setup({ startDate: FUTURE_START, dueDate: FUTURE_DUE });
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "",
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "TODO");
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("employee DONE with whitespace-only completionRemark is 400", async () => {
    const { ddb } = setup({ startDate: FUTURE_START, dueDate: FUTURE_DUE });
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "   ",
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "TODO");
    assert.ok(!assignmentItem(ddb, PRIYA).completionRemark);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("employee DONE with valid remark submits assignment for review", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
    });
    const remark = "Completed the product upload and verified all 50 items.";
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: `  ${remark}  `,
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.status, "REVIEW");
    assert.strictEqual(mine.completionRemark, remark);
    assert.ok(!mine.completedAt);
    assert.ok(!mine.completedDate);
    assert.ok(!mine.completedZone);
    assert.strictEqual(entityTask(ddb).status, "REVIEW");
    assert.ok(!entityTask(ddb).completionRemark);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
    const changed = activityItems(ddb).filter((a) => a.action === "status_changed");
    assert.strictEqual(changed.length, 1);
    assert.strictEqual(changed[0].assignmentEmail, PRIYA);
    assert.match(changed[0].detail || "", /IN PROGRESS → IN REVIEW/);
  });

  await test("employee TODO IN_PROGRESS remain unchanged without remark", async () => {
    const { ddb } = setup({ startDate: FUTURE_START, dueDate: FUTURE_DUE });
    const toProgress = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "IN_PROGRESS",
          assignmentEmail: PRIYA,
        })
      )
    );
    assert.strictEqual(toProgress.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(!assignmentItem(ddb, PRIYA).completionRemark);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("employee cannot set REVIEW directly", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
    });
    const before = snapshot(ddb);
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "REVIEW",
          assignmentEmail: PRIYA,
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error || "", /REVIEW/i);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(!assignmentItem(ddb, PRIYA).completionRemark);
    assert.strictEqual(snapshot(ddb).activities, before.activities);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("employee cannot submit DONE while already in REVIEW", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "REVIEW",
    });
    liveAssignment(ddb, PRIYA).completionRemark = "Original review remark.";
    const beforeActivities = activityCount(ddb);
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Trying to resubmit.",
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.status, "REVIEW");
    assert.strictEqual(mine.completionRemark, "Original review remark.");
    assert.ok(!mine.completedAt);
    assert.strictEqual(activityCount(ddb), beforeActivities);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("employee cannot complete RED task even with remark", async () => {
    const { ddb } = setup({ startDate: PAST_DUE, dueDate: PAST_DUE });
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Trying to complete a red task.",
        })
      )
    );
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error || "", /Red Zone/i);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "TODO");
    assert.ok(!assignmentItem(ddb, PRIYA).completionRemark);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("employee cannot reopen DONE", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "DONE",
    });
    const stored = ddb.items.find(
      (row) =>
        row.TableName === WORK &&
        row.Item.PK === `TASK#${TASK_ID}` &&
        row.Item.SK === `ASSIGNMENT#${PRIYA}`
    );
    Object.assign(stored.Item, {
      completedAt: "2026-09-20T10:00:00.000Z",
      completedDate: "2026-09-20",
      completedZone: "GREEN",
      completionRemark: "Already done.",
    });
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "IN_PROGRESS",
          assignmentEmail: PRIYA,
        })
      )
    );
    assert.ok(res.statusCode === 200 || res.statusCode === 403);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.status, "DONE");
    assert.strictEqual(mine.completionRemark, "Already done.");
  });

  await test("employee cannot set CANCELLED", async () => {
    const { ddb } = setup({ startDate: FUTURE_START, dueDate: FUTURE_DUE });
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "CANCELLED",
          assignmentEmail: PRIYA,
        })
      )
    );
    assert.ok(res.statusCode === 200 || res.statusCode === 400 || res.statusCode === 403);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "TODO");
  });

  await test("multi-assignee completion remark stays on one assignment", async () => {
    const { ddb } = setup({
      assignees: [ANKIT, PRIYA, RAHUL],
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatuses: {
        [ANKIT]: "TODO",
        [PRIYA]: "IN_PROGRESS",
        [RAHUL]: "DONE",
      },
    });
    const res = parse(
      await handler(
        employeeEvent(
          {
            taskId: TASK_ID,
            projectId: PROJECT_ID,
            status: "DONE",
            assignmentEmail: ANKIT,
            completionRemark: "Completed product research.",
          },
          ANKIT
        )
      )
    );
    assert.strictEqual(res.statusCode, 200);
    const ankit = assignmentItem(ddb, ANKIT);
    const priya = assignmentItem(ddb, PRIYA);
    const rahul = assignmentItem(ddb, RAHUL);
    assert.strictEqual(ankit.status, "REVIEW");
    assert.strictEqual(ankit.completionRemark, "Completed product research.");
    assert.ok(!ankit.completedAt);
    assert.strictEqual(priya.status, "IN_PROGRESS");
    assert.ok(!priya.completionRemark);
    assert.strictEqual(rahul.status, "DONE");
    assert.strictEqual(entityTask(ddb).status, "REVIEW");
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
    const changed = activityItems(ddb).filter((a) => a.action === "status_changed");
    assert.strictEqual(changed.length, 1);
    assert.strictEqual(changed[0].assignmentEmail, ANKIT);
  });

  await test("admin REVIEW to DONE uses existing completion behavior", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "REVIEW",
    });
    liveAssignment(ddb, PRIYA).completionRemark = "Ready for review.";
    const res = parse(
      await handler(
        adminEvent({
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
    assert.ok(mine.completedDate);
    assert.ok(mine.completedZone);
    assert.strictEqual(mine.completionRemark, "Ready for review.");
    const completed = activityItems(ddb).filter((a) => a.action === "task_completed");
    assert.strictEqual(completed.length, 1);
    assert.strictEqual(completed[0].assignmentEmail, PRIYA);
  });

  await test("admin REVIEW to IN_PROGRESS preserves existing fields", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "REVIEW",
    });
    liveAssignment(ddb, PRIYA).completionRemark = "Ready for review.";
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "IN_PROGRESS",
          assignmentEmail: PRIYA,
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.status, "IN_PROGRESS");
    assert.strictEqual(mine.completionRemark, "Ready for review.");
    assert.ok(!mine.completedAt);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
    const changed = activityItems(ddb).filter((a) => a.action === "status_changed");
    assert.ok(changed.some((a) => /IN REVIEW → IN PROGRESS/.test(a.detail || "")));
  });

  await test("admin DONE does not require completionRemark", async () => {
    const { ddb } = setup({ startDate: FUTURE_START, dueDate: FUTURE_DUE });
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "DONE");
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

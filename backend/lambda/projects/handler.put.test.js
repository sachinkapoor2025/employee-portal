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
const {
  putChangesAssignedShiftFit,
  ASSIGNED_SHIFT_FIT,
} = require("./assignedShiftFit");
const { handler, setClientsForTests } = require("./handler");

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;
const ATTENDANCE = process.env.ATTENDANCE_TABLE;
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
    failCostTransact: 0,
    failHeaderPuts: 0,
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
        const item = command.input.Item;
        if (
          this.failHeaderPuts > 0 &&
          item?.PK === "ENTITY#TASK" &&
          String(item?.SK || "").startsWith("TASK#")
        ) {
          this.failHeaderPuts -= 1;
          const err = new Error("header write failed");
          err.name = "InternalError";
          throw err;
        }
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
        const ops = command.input.TransactItems || [];
        const hasCost = ops.some((op) =>
          String(op.Put?.Item?.SK || "").startsWith("COST#")
        );
        if (hasCost && this.failCostTransact > 0) {
          this.failCostTransact -= 1;
          const err = new Error("cancelled");
          err.name = "TransactionCanceledException";
          throw err;
        }
        for (const op of ops) {
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

function seedAttendance(ddb, email, date, extra = {}) {
  ddb.seed(ATTENDANCE, {
    PK: email,
    SK: date,
    email,
    date,
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
      ...(function assignmentHours() {
        const status =
          extra.assignmentStatuses?.[email] || extra.assignmentStatus || "TODO";
        if (extra.actualHours === null) return {};
        if (extra.actualHours !== undefined) {
          return { actualHours: extra.actualHours };
        }
        if (status === "REVIEW" || status === "DONE") {
          return { actualHours: 2 };
        }
        return {};
      })(),
    });
  }
  return item;
}

function setup({ assignees, startDate, dueDate, title, shifts, assignmentStatuses, assignmentStatus, proof = false, actualHours } = {}) {
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
    actualHours,
  });
  if (proof) seedProof(ddb, TASK_ID, emails[0]);
  setClientsForTests({ ddb });
  return { ddb, task };
}

function seedProof(ddb, taskId = TASK_ID, uploadedBy = PRIYA, extra = {}) {
  const attachmentId = extra.attachmentId || "att-proof-1";
  ddb.seed(WORK, {
    PK: `TASK#${taskId}`,
    SK: `ATTACHMENT#${attachmentId}`,
    attachmentId,
    taskId,
    fileName: extra.fileName || "brief.pdf",
    contentType: "application/pdf",
    s3Key: extra.s3Key || `tasks/${taskId}/brief.pdf`,
    uploadedBy,
    uploadedAt: extra.uploadedAt || "2026-09-20T10:00:00.000Z",
  });
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

function costItem(ddb, email, taskId = TASK_ID) {
  return ddb
    .of(WORK)
    .find((item) => item.PK === `TASK#${taskId}` && item.SK === `COST#${email}`);
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

  await test("assigned multi-day afternoon edit 16:00 to next-day 19:00 succeeds", async () => {
    const { ddb } = setup({
      startDate: "2026-09-28T16:00:00+05:30",
      dueDate: "2026-09-28T18:00:00+05:30",
      shifts: {
        [PRIYA]: {
          shiftId: "afternoon",
          name: "Afternoon Shift",
          startTime: "14:00",
          endTime: "19:00",
        },
      },
    });
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          startDate: "2026-09-28T16:00:00+05:30",
          dueDate: "2026-09-30T19:00:00+05:30",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(entityTask(ddb).startDate, "2026-09-28T16:00:00+05:30");
    assert.strictEqual(entityTask(ddb).dueDate, "2026-09-30T19:00:00+05:30");
    assert.strictEqual(entityTask(ddb).assignmentState, "ASSIGNED");
  });

  await test("assigned multi-day afternoon edit Week Off postpones then succeeds", async () => {
    const { ddb } = setup({
      startDate: "2026-09-28T16:00:00+05:30",
      dueDate: "2026-09-28T18:00:00+05:30",
      shifts: {
        [PRIYA]: {
          shiftId: "afternoon",
          name: "Afternoon Shift",
          startTime: "14:00",
          endTime: "19:00",
        },
      },
    });
    seedAttendance(ddb, PRIYA, "2026-09-28", { status: "Week Off" });
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          startDate: "2026-09-28T16:00:00+05:30",
          dueDate: "2026-09-30T19:00:00+05:30",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(Date.parse(entityTask(ddb).startDate), Date.parse("2026-09-29T16:00:00+05:30"));
    assert.strictEqual(Date.parse(entityTask(ddb).dueDate), Date.parse("2026-10-01T19:00:00+05:30"));
  });

  await test("assigned description-only PUT does not revalidate Week Off", async () => {
    const { ddb } = setup({
      startDate: "2026-09-28T16:00:00+05:30",
      dueDate: "2026-09-30T19:00:00+05:30",
      shifts: {
        [PRIYA]: {
          shiftId: "afternoon",
          name: "Afternoon Shift",
          startTime: "14:00",
          endTime: "19:00",
        },
      },
    });
    seedAttendance(ddb, PRIYA, "2026-09-28", { status: "Week Off" });
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          description: "Copy tweak only.",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(entityTask(ddb).startDate, "2026-09-28T16:00:00+05:30");
    assert.strictEqual(entityTask(ddb).dueDate, "2026-09-30T19:00:00+05:30");
  });

  await test("assigned multi-day afternoon edit due after shift is SHIFT_CONFLICT", async () => {
    const { ddb } = setup({
      startDate: "2026-09-28T16:00:00+05:30",
      dueDate: "2026-09-28T18:00:00+05:30",
      shifts: {
        [PRIYA]: {
          shiftId: "afternoon",
          name: "Afternoon Shift",
          startTime: "14:00",
          endTime: "19:00",
        },
      },
    });
    const before = snapshot(ddb);
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          startDate: "2026-09-28T16:00:00+05:30",
          dueDate: "2026-09-30T20:00:00+05:30",
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assert.deepStrictEqual(snapshot(ddb).task, before.task);
  });

  await test("assigned multi-day afternoon edit start before shift is SHIFT_CONFLICT", async () => {
    const { ddb } = setup({
      startDate: "2026-09-28T16:00:00+05:30",
      dueDate: "2026-09-28T18:00:00+05:30",
      shifts: {
        [PRIYA]: {
          shiftId: "afternoon",
          name: "Afternoon Shift",
          startTime: "14:00",
          endTime: "19:00",
        },
      },
    });
    const before = snapshot(ddb);
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          startDate: "2026-09-28T13:00:00+05:30",
          dueDate: "2026-09-30T19:00:00+05:30",
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, ASSIGNED_SHIFT_FIT.SHIFT_CONFLICT);
    assert.deepStrictEqual(snapshot(ddb).task, before.task);
  });

  await test("assigned same-day afternoon overrun remains SHIFT_CONFLICT", async () => {
    const { ddb } = setup({
      startDate: "2026-09-28T16:00:00+05:30",
      dueDate: "2026-09-28T18:00:00+05:30",
      shifts: {
        [PRIYA]: {
          shiftId: "afternoon",
          name: "Afternoon Shift",
          startTime: "14:00",
          endTime: "19:00",
        },
      },
    });
    const before = snapshot(ddb);
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          startDate: "2026-09-28T18:00:00+05:30",
          dueDate: "2026-09-28T20:00:00+05:30",
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

  await test("employee TODO DONE with valid remark submits assignment for review", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      proof: true,
    });
    const remark = "Finished from the employee portal.";
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: remark,
          actualHours: 2.5,
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.status, "REVIEW");
    assert.strictEqual(entityTask(ddb).status, "REVIEW");
    assert.strictEqual(mine.completionRemark, remark);
    assert.ok(!mine.completedAt);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("employee DONE with valid remark submits assignment for review", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
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
          actualHours: 3,
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
    assert.strictEqual(mine.recordedZone, "GREEN");
    assert.strictEqual(entityTask(ddb).status, "REVIEW");
    assert.ok(!entityTask(ddb).completionRemark);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
    const changed = activityItems(ddb).filter((a) => a.action === "status_changed");
    assert.strictEqual(changed.length, 1);
    assert.strictEqual(changed[0].assignmentEmail, PRIYA);
    assert.match(changed[0].detail || "", /IN PROGRESS → IN REVIEW/);
  });

  await test("employee DONE with remark but no proof is 400", async () => {
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
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Completed without uploading proof.",
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "Please upload at least one proof file.");
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(!assignmentItem(ddb, PRIYA).completionRemark);
    assert.strictEqual(snapshot(ddb).activities, before.activities);
    assert.ok(!activityItems(ddb).some((a) => a.action === "status_changed"));
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("employee DONE with only another user's attachment is 400", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
    });
    seedProof(ddb, TASK_ID, ADMIN);
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Completed using the existing brief.",
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "Please upload at least one proof file.");
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(!activityItems(ddb).some((a) => a.action === "status_changed"));
  });

  await test("employee DONE with attachment from before assignment is 400", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
    });
    seedProof(ddb, TASK_ID, PRIYA, { uploadedAt: "2026-09-01T08:00:00.000Z" });
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Completed using an older file.",
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "Please upload at least one proof file.");
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(!activityItems(ddb).some((a) => a.action === "status_changed"));
  });

  await test("employee DONE with multiple existing proofs submits for review", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
    });
    seedProof(ddb, TASK_ID, PRIYA);
    seedProof(ddb, TASK_ID, PRIYA, {
      attachmentId: "att-proof-2",
      fileName: "sheet.pdf",
      s3Key: `tasks/${TASK_ID}/sheet.pdf`,
    });
    const remark = "Completed with two existing files.";
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: remark,
          actualHours: 3,
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.status, "REVIEW");
    assert.strictEqual(mine.completionRemark, remark);
    assert.strictEqual(mine.actualHours, 3);
    const proofs = ddb
      .of(WORK)
      .filter((item) => String(item.SK || "").startsWith("ATTACHMENT#"));
    assert.strictEqual(proofs.length, 2);
  });

  await test("employee DONE without proof and without remark is 400", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
    });
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
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(!activityItems(ddb).some((a) => a.action === "status_changed"));
  });

  await test("employee DONE with proof and missing remark is 400", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
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
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(!activityItems(ddb).some((a) => a.action === "status_changed"));
  });

  await test("employee TODO IN_PROGRESS remain unchanged without remark", async () => {
    const { ddb } = setup({ startDate: FUTURE_START, dueDate: FUTURE_DUE });
    liveAssignment(ddb, PRIYA).plannedHours = 2;
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

  await test("employee cannot start without planned hours", async () => {
    const { ddb } = setup({ startDate: FUTURE_START, dueDate: FUTURE_DUE });
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
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error || "", /planned hours/i);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "TODO");
  });

  await test("employee starts with planned hours and does not change admin estimate", async () => {
    const { ddb } = setup({ startDate: FUTURE_START, dueDate: FUTURE_DUE });
    const taskRow = ddb.items.find(
      (row) =>
        row.TableName === WORK &&
        row.Item.PK === "ENTITY#TASK" &&
        row.Item.taskId === TASK_ID
    );
    taskRow.Item.estimatedHours = 8;
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "IN_PROGRESS",
          assignmentEmail: PRIYA,
          plannedHours: "2.25",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.strictEqual(assignmentItem(ddb, PRIYA).plannedHours, 2.25);
    assert.strictEqual(entityTask(ddb).estimatedHours, 8);
    assert.ok(entityTask(ddb).plannedHours == null);
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
      proof: true,
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
            actualHours: 4,
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
    assert.strictEqual(entityTask(ddb).status, "DONE");
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

  await test("admin TODO DONE without remark is 400", async () => {
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
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error || "", /Completion Remark/i);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "TODO");
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("dual-role ADMIN assignee TODO DONE submits for review", async () => {
    const { ddb } = setup({
      assignees: [ADMIN],
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      proof: true,
    });
    const remark = "Completed";
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: ADMIN,
          completionRemark: remark,
          actualHours: 2,
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    const mine = assignmentItem(ddb, ADMIN);
    assert.strictEqual(mine.status, "REVIEW");
    assert.strictEqual(entityTask(ddb).status, "REVIEW");
    assert.strictEqual(mine.completionRemark, remark);
    assert.ok(!mine.completedAt);
    assert.ok(!mine.completedDate);
    assert.ok(!mine.completedZone);
    assert.strictEqual(mine.recordedZone, "GREEN");
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
    const changed = activityItems(ddb).filter((a) => a.action === "status_changed");
    assert.ok(changed.some((a) => /TODO → IN REVIEW/.test(a.detail || "")));
  });

  await test("dual-role ADMIN assignee IN_PROGRESS DONE submits for review", async () => {
    const { ddb } = setup({
      assignees: [ADMIN],
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    const res = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: ADMIN,
          completionRemark: "Work finished for review.",
          actualHours: 2.5,
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    const mine = assignmentItem(ddb, ADMIN);
    assert.strictEqual(mine.status, "REVIEW");
    assert.notStrictEqual(mine.status, "DONE");
    assert.ok(!mine.completedAt);
    assert.ok(!activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("approve after deadline keeps submit-time GREEN zone", async () => {
    const { ddb } = setup({
      startDate: PAST_DUE,
      dueDate: PAST_DUE,
      assignmentStatus: "REVIEW",
    });
    const row = liveAssignment(ddb, PRIYA);
    row.completionRemark = "Submitted on time.";
    row.recordedZone = "GREEN";
    row.highestZone = "GREEN";
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
    assert.strictEqual(mine.completedZone, "GREEN");
    assert.notStrictEqual(mine.completedZone, "RED");
    assert.notStrictEqual(mine.completedZone, "ORANGE");
    assert.ok(activityItems(ddb).some((a) => a.action === "task_completed"));
  });

  await test("employee review submit requires actual hours", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    const missing = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Legacy completion.",
        })
      )
    );
    assert.strictEqual(missing.statusCode, 400);
    assert.match(missing.body.error || "", /actual hours/i);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
  });

  await test("admin cannot complete a review assignment without actual hours", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "REVIEW",
      actualHours: null,
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
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error || "", /actual hours/i);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
    assert.ok(!assignmentItem(ddb, PRIYA).completedAt);
  });

  await test("employee actual hours are saved when provided and invalid values are rejected", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    for (const actualHours of [0, -1, "abc", Infinity, NaN]) {
      const bad = parse(
        await handler(
          employeeEvent({
            taskId: TASK_ID,
            projectId: PROJECT_ID,
            status: "DONE",
            assignmentEmail: PRIYA,
            completionRemark: "Done.",
            actualHours,
          })
        )
      );
      assert.strictEqual(bad.statusCode, 400);
    }
    const ok = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 6,
        })
      )
    );
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, PRIYA).actualHours, 6);
    assert.strictEqual(ok.body.assignments[0].actualHours, 6);
  });

  await test("employee can submit actual hours of 2.5 and 24.5", async () => {
    const first = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    const twoThirty = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 2.5,
        })
      )
    );
    assert.strictEqual(twoThirty.statusCode, 200);
    assert.strictEqual(assignmentItem(first.ddb, PRIYA).actualHours, 2.5);

    const second = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    const twentyFour = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 24.5,
        })
      )
    );
    assert.strictEqual(twentyFour.statusCode, 200);
    assert.strictEqual(assignmentItem(second.ddb, PRIYA).actualHours, 24.5);
  });

  await test("employee review submit persists a submission cost snapshot", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    const res = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 6,
        })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    const mine = assignmentItem(ddb, PRIYA);
    assert.strictEqual(mine.status, "REVIEW");
    assert.ok(mine.submittedAt);
    assert.ok(mine.attemptId);
    const snap = costItem(ddb, PRIYA);
    assert.strictEqual(snap.status, "MISSING_RATE");
    assert.strictEqual(snap.reason, "UNCLASSIFIED_PROJECT");
    assert.strictEqual(snap.amountUsd, null);
    assert.strictEqual(snap.actualHours, 6);
    assert.strictEqual(snap.submittedAt, mine.submittedAt);
    assert.strictEqual(snap.attemptId, mine.attemptId);
  });

  await test("admin complete does not create or replace a submission snapshot", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "REVIEW",
    });
    ddb.seed(WORK, {
      PK: `TASK#${TASK_ID}`,
      SK: `COST#${PRIYA}`,
      type: "ASSIGNMENT_COST",
      status: "COSTED",
      taskId: TASK_ID,
      email: PRIYA,
      actualHours: 2,
      hourlyRateUsd: 2.25,
      amountUsd: 4.5,
      submittedAt: "2026-09-20T10:00:00.000Z",
      attemptId: "attempt-legacy",
    });
    const first = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
        })
      )
    );
    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "DONE");
    const snap = costItem(ddb, PRIYA);
    assert.strictEqual(snap.amountUsd, 4.5);
    assert.strictEqual(snap.hourlyRateUsd, 2.25);
    assert.strictEqual(snap.attemptId, "attempt-legacy");
    const costs = ddb
      .of(WORK)
      .filter((item) => item.PK === `TASK#${TASK_ID}` && item.SK === `COST#${PRIYA}`);
    assert.strictEqual(costs.length, 1);
  });

  await test("submission cost failure leaves the assignment unsubmitted", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    ddb.failCostTransact = 1;
    const failed = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 4,
        })
      )
    );
    assert.strictEqual(failed.statusCode, 500);
    assert.match(failed.body.error || "", /cost record/i);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(!costItem(ddb, PRIYA));
    assert.ok(!activityItems(ddb).some((item) => item.action === "status_changed"));
    const afterRefresh = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 4,
        })
      )
    );
    assert.strictEqual(afterRefresh.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
    const snap = costItem(ddb, PRIYA);
    assert.ok(snap);
    assert.strictEqual(snap.status, "MISSING_RATE");
    const secondRetry = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done again.",
          actualHours: 9,
        })
      )
    );
    assert.strictEqual(secondRetry.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, PRIYA).completionRemark, "Done.");
    const costs = ddb
      .of(WORK)
      .filter(
        (item) => item.PK === `TASK#${TASK_ID}` && item.SK === `COST#${PRIYA}`
      );
    assert.strictEqual(costs.length, 1);
    assert.strictEqual(costs[0].actualHours, 4);
    const submissionActivity = activityItems(ddb).filter(
      (item) => item.action === "status_changed"
    );
    assert.strictEqual(submissionActivity.length, 1);
    assert.strictEqual(submissionActivity[0].SK, `ACTIVITY#SUBMISSION#${PRIYA}`);
  });

  await test("red-zone submission writes nothing and a reassigned attempt can be submitted", async () => {
    const red = setup({
      startDate: PAST_DUE,
      dueDate: PAST_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    const rejected = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Trying to submit a red task.",
          actualHours: 6,
        })
      )
    );
    assert.strictEqual(rejected.statusCode, 403);
    assert.match(rejected.body.error || "", /Red Zone/i);
    const blocked = assignmentItem(red.ddb, PRIYA);
    assert.strictEqual(blocked.status, "IN_PROGRESS");
    assert.ok(blocked.actualHours == null);
    assert.ok(!blocked.completionRemark);
    assert.ok(!blocked.submittedAt);
    assert.ok(!blocked.attemptId);
    assert.ok(!costItem(red.ddb, PRIYA));
    assert.ok(!activityItems(red.ddb).some((item) => item.action === "status_changed"));
    assert.strictEqual(entityTask(red.ddb).status, "TODO");

    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    const taskRow = ddb.of(WORK).find((item) => item.PK === "ENTITY#TASK");
    taskRow.estimatedHours = 4;
    const submitted = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "First attempt.",
          actualHours: 7,
        })
      )
    );
    assert.strictEqual(submitted.statusCode, 200);
    const reassigned = parse(
      await handler({
        httpMethod: "POST",
        path: "/tasks",
        body: JSON.stringify({
          sourceTaskId: TASK_ID,
          projectId: PROJECT_ID,
          assignmentEmail: PRIYA,
          reassignmentReason: "CHANGES_REQUIRED",
          reassignmentRemark: "Need another pass.",
          assignees: [PRIYA],
          assignee: PRIYA,
          startDate: FUTURE_START,
          dueDate: FUTURE_DUE,
          estimatedHours: 4,
        }),
        requestContext: {
          authorizer: {
            claims: { email: ADMIN, "cognito:groups": ["Admin"] },
          },
        },
      })
    );
    assert.strictEqual(reassigned.statusCode, 201);
    const followId = reassigned.body.taskId;
    const follow = assignmentItem(ddb, PRIYA, followId);
    seedProof(ddb, followId, PRIYA, { uploadedAt: follow.assignedAt });
    const second = parse(
      await handler(
        employeeEvent({
          taskId: followId,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Eligible follow-up.",
          actualHours: 3,
        })
      )
    );
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(assignmentItem(ddb, PRIYA, followId).status, "REVIEW");
    assert.strictEqual(assignmentItem(ddb, PRIYA, followId).actualHours, 3);
    assert.ok(costItem(ddb, PRIYA, followId));
    assert.notStrictEqual(
      costItem(ddb, PRIYA, followId).attemptId,
      costItem(ddb, PRIYA, TASK_ID).attemptId
    );
    assert.strictEqual(costItem(ddb, PRIYA, TASK_ID).actualHours, 7);
  });

  await test("header write failure is repaired without a second snapshot", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    ddb.failHeaderPuts = 1;
    const failed = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 4,
        })
      )
    );
    assert.strictEqual(failed.statusCode, 500);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "REVIEW");
    assert.strictEqual(assignmentItem(ddb, PRIYA).actualHours, 4);
    assert.ok(costItem(ddb, PRIYA));
    assert.strictEqual(entityTask(ddb).status, "TODO");
    assert.strictEqual(
      activityItems(ddb).filter((item) => item.action === "status_changed").length,
      1
    );
    const repaired = parse(
      await handler(
        employeeEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Retry.",
          actualHours: 9,
        })
      )
    );
    assert.strictEqual(repaired.statusCode, 200);
    assert.strictEqual(entityTask(ddb).status, "REVIEW");
    assert.strictEqual(
      ddb.of(WORK).find((item) => item.PK === `PROJECT#${PROJECT_ID}` && item.taskId === TASK_ID)
        .status,
      "REVIEW"
    );
    assert.strictEqual(assignmentItem(ddb, PRIYA).actualHours, 4);
    assert.strictEqual(assignmentItem(ddb, PRIYA).completionRemark, "Done.");
    assert.strictEqual(
      ddb.of(WORK).filter((item) => item.PK === `TASK#${TASK_ID}` && item.SK === `COST#${PRIYA}`).length,
      1
    );
    assert.strictEqual(
      activityItems(ddb).filter((item) => item.action === "status_changed").length,
      1
    );
  });

  await test("detail activity is not kept when the submission cost write fails", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    ddb.failCostTransact = 1;
    const failed = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 4,
          title: "Renamed during submit",
          priority: "LOW",
          dueDate: "2099-12-31T19:00:00+05:30",
        })
      )
    );
    assert.strictEqual(failed.statusCode, 500);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(assignmentItem(ddb, PRIYA).actualHours == null);
    assert.ok(!costItem(ddb, PRIYA));
    assert.strictEqual(entityTask(ddb).title, "Banner update");
    assert.strictEqual(entityTask(ddb).priority, "HIGH");
    assert.strictEqual(entityTask(ddb).dueDate, FUTURE_DUE);
    assert.ok(!activityItems(ddb).some((item) => item.action === "task_updated"));
    assert.ok(!activityItems(ddb).some((item) => item.action === "priority_changed"));
    assert.ok(!activityItems(ddb).some((item) => item.action === "deadline_changed"));
    assert.ok(!activityItems(ddb).some((item) => item.action === "status_changed"));
  });

  await test("submission plus assignee change does not keep assignee activity when cost fails", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    ddb.failCostTransact = 1;
    const failed = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 4,
          assignees: [PRIYA, RAHUL],
        })
      )
    );
    assert.strictEqual(failed.statusCode, 500);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(!costItem(ddb, PRIYA));
    assert.deepStrictEqual(assignmentEmails(ddb), [PRIYA]);
    assert.ok(!activityItems(ddb).some((item) => item.action === "task_assigned"));
    assert.ok(!activityItems(ddb).some((item) => item.action === "task_reassigned"));
    assert.ok(!activityItems(ddb).some((item) => item.action === "status_changed"));
  });

  await test("submission plus archive does not keep archive activity when cost fails", async () => {
    const { ddb } = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    ddb.failCostTransact = 1;
    const failed = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 4,
          archived: true,
        })
      )
    );
    assert.strictEqual(failed.statusCode, 500);
    assert.strictEqual(assignmentItem(ddb, PRIYA).status, "IN_PROGRESS");
    assert.ok(!costItem(ddb, PRIYA));
    assert.ok(!entityTask(ddb).archived);
    assert.ok(!activityItems(ddb).some((item) => item.action === "task_archived"));
    assert.ok(!activityItems(ddb).some((item) => item.action === "status_changed"));
  });

  await test("successful submission with assignee change or archive writes each activity once", async () => {
    const assigned = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    const assignedResult = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 4,
          assignees: [PRIYA, RAHUL],
        })
      )
    );
    assert.strictEqual(assignedResult.statusCode, 200);
    assert.strictEqual(assignmentItem(assigned.ddb, PRIYA).status, "REVIEW");
    assert.ok(costItem(assigned.ddb, PRIYA));
    assert.deepStrictEqual(assignmentEmails(assigned.ddb).sort(), [PRIYA, RAHUL].sort());
    assert.strictEqual(
      activityItems(assigned.ddb).filter((item) => item.action === "task_assigned").length,
      1
    );
    assert.strictEqual(
      activityItems(assigned.ddb).filter((item) => item.action === "task_reassigned").length,
      1
    );
    assert.strictEqual(
      activityItems(assigned.ddb).filter((item) => item.action === "status_changed").length,
      1
    );

    const archived = setup({
      startDate: FUTURE_START,
      dueDate: FUTURE_DUE,
      assignmentStatus: "IN_PROGRESS",
      proof: true,
    });
    const archivedResult = parse(
      await handler(
        adminEvent({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          status: "DONE",
          assignmentEmail: PRIYA,
          completionRemark: "Done.",
          actualHours: 4,
          archived: true,
        })
      )
    );
    assert.strictEqual(archivedResult.statusCode, 200);
    assert.strictEqual(entityTask(archived.ddb).archived, true);
    assert.ok(costItem(archived.ddb, PRIYA));
    assert.strictEqual(
      activityItems(archived.ddb).filter((item) => item.action === "task_archived").length,
      1
    );
    assert.strictEqual(
      activityItems(archived.ddb).filter((item) => item.action === "status_changed").length,
      1
    );
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

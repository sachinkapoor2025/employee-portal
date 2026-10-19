const assert = require("assert");
const {
  GetCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  STATUS_MISSING_COST_RECORD,
  STATUS_PENDING_REVIEW,
  costingProjectPathMatch,
  costingEmployeePathMatch,
  classifyAssignment,
  summarizeRows,
  inCompletedDateRange,
  handleGetProjectCosting,
  handleGetEmployeeCosting,
  setCostingCapsForTest,
  collectEmployeeTaskIds,
  parseCursor,
  encodeCursor,
  paginateRows,
  sortCostingRows,
  compareRowsDesc,
} = require("./costingReports");
const { STATUS_COSTED, STATUS_MISSING_RATE } = require("./taskCosting");

function keyOf(table, pk, sk) {
  return `${table}\0${pk}\0${sk}`;
}

function memoryDdb(seed = {}) {
  const items = { ...seed };
  return {
    items,
    async send(command) {
      if (command instanceof GetCommand) {
        const k = keyOf(
          command.input.TableName,
          command.input.Key.PK,
          command.input.Key.SK
        );
        return items[k] ? { Item: { ...items[k] } } : {};
      }
      if (command instanceof QueryCommand) {
        const table = command.input.TableName;
        const pk = command.input.ExpressionAttributeValues[":pk"];
        const skPrefix = command.input.ExpressionAttributeValues[":sk"];
        const found = Object.values(items).filter((item) => {
          if (item.PK !== pk) return false;
          if (!skPrefix) return true;
          return String(item.SK || "").startsWith(skPrefix);
        });
        return { Items: found.map((item) => ({ ...item })) };
      }
      throw new Error(command.constructor.name);
    },
  };
}

const WORK = "WorkTasks";
const ACCESS = "UserAccess";
const PROFILE = "UserProfile";
const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };
const SUPER = { email: "boss@mydgv.com", groups: ["Admin"], isAdmin: true };
const MANAGER = { email: "lead@mydgv.com", groups: ["Admin"], isAdmin: true };
const EMP = { email: "rahul@mydgv.com", groups: ["Employee"], isAdmin: false };

function seedPeople() {
  return {
    [keyOf(ACCESS, "admin@mydgv.com", "admin@mydgv.com")]: {
      PK: "admin@mydgv.com",
      SK: "admin@mydgv.com",
      email: "admin@mydgv.com",
      role: "ADMIN",
      status: "ACTIVE",
    },
    [keyOf(ACCESS, "boss@mydgv.com", "boss@mydgv.com")]: {
      PK: "boss@mydgv.com",
      SK: "boss@mydgv.com",
      email: "boss@mydgv.com",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    },
    [keyOf(ACCESS, "lead@mydgv.com", "lead@mydgv.com")]: {
      PK: "lead@mydgv.com",
      SK: "lead@mydgv.com",
      email: "lead@mydgv.com",
      role: "MANAGER",
      status: "ACTIVE",
    },
    [keyOf(ACCESS, "rahul@mydgv.com", "rahul@mydgv.com")]: {
      PK: "rahul@mydgv.com",
      SK: "rahul@mydgv.com",
      email: "rahul@mydgv.com",
      role: "EMPLOYEE",
      status: "ACTIVE",
    },
    [keyOf(PROFILE, "USER#rahul@mydgv.com", "PROFILE")]: {
      PK: "USER#rahul@mydgv.com",
      SK: "PROFILE",
      email: "rahul@mydgv.com",
      name: "Rahul",
    },
  };
}

function seedTask(items, {
  taskId,
  projectId,
  title,
  status,
  estimatedHours,
  sourceTaskId,
  assignedAt,
  assignmentStatus,
  actualHours,
  plannedHours,
  email = "rahul@mydgv.com",
  completedAt,
  completedDate,
  supersededByTaskId,
  cost,
}) {
  const task = {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
    taskId,
    projectId,
    title,
    status,
    estimatedHours,
    sourceTaskId: sourceTaskId || null,
    assignees: [email],
    assignee: email,
    archived: false,
  };
  items[keyOf(WORK, task.PK, task.SK)] = task;
  items[keyOf(WORK, `PROJECT#${projectId}`, `TASK#${taskId}`)] = {
    ...task,
    PK: `PROJECT#${projectId}`,
    SK: `TASK#${taskId}`,
  };
  items[keyOf(WORK, `TASK#${taskId}`, `ASSIGNMENT#${email}`)] = {
    PK: `TASK#${taskId}`,
    SK: `ASSIGNMENT#${email}`,
    type: "ASSIGNMENT",
    taskId,
    email,
    status: assignmentStatus,
    assignedAt,
    actualHours,
    plannedHours,
    completedAt,
    completedDate,
    supersededByTaskId: supersededByTaskId || null,
    removed: false,
  };
  items[keyOf(WORK, `USER#${email}`, `ASSIGNMENT#${taskId}`)] = {
    PK: `USER#${email}`,
    SK: `ASSIGNMENT#${taskId}`,
    type: "USER_ASSIGNMENT",
    taskId,
    email,
  };
  if (cost) {
    items[keyOf(WORK, `TASK#${taskId}`, `COST#${email}`)] = {
      PK: `TASK#${taskId}`,
      SK: `COST#${email}`,
      ...cost,
      email,
      taskId,
    };
    items[keyOf(WORK, `USER#${email}`, `ASSIGNMENT_COST#${taskId}`)] = {
      PK: `USER#${email}`,
      SK: `ASSIGNMENT_COST#${taskId}`,
      ...cost,
      email,
      taskId,
    };
  }
}

assert.strictEqual(
  costingProjectPathMatch("/prod/admin/costing/projects/p1").projectId,
  "p1"
);
assert.strictEqual(
  costingEmployeePathMatch("/prod/admin/costing/employees/Rahul%40mydgv.com").email,
  "rahul@mydgv.com"
);

{
  const tied = sortCostingRows([
    {
      completedDate: "2026-02-11",
      assignedAt: "2026-02-01T00:00:00.000Z",
      taskId: "t-b",
      email: "rahul@mydgv.com",
    },
    {
      completedDate: "2026-02-11",
      assignedAt: "2026-02-01T00:00:00.000Z",
      taskId: "t-a",
      email: "rahul@mydgv.com",
    },
    {
      completedDate: "2026-02-11",
      assignedAt: "2026-02-01T00:00:00.000Z",
      taskId: "t-a",
      email: "ria@mydgv.com",
    },
  ]);
  assert.strictEqual(tied[0].taskId, "t-b");
  assert.strictEqual(tied[1].email, "ria@mydgv.com");
  assert.strictEqual(tied[2].email, "rahul@mydgv.com");
  assert.strictEqual(compareRowsDesc(tied[1], tied[1]), 0);
}

{
  const rows = [
    { taskId: "t1", email: "a@mydgv.com", completedDate: "2026-03-01", assignedAt: "a" },
    { taskId: "t2", email: "a@mydgv.com", completedDate: "2026-02-01", assignedAt: "a" },
    { taskId: "t3", email: "a@mydgv.com", completedDate: "2026-01-01", assignedAt: "a" },
  ];
  const sorted = sortCostingRows(rows);
  const page1 = paginateRows(sorted, null, 2);
  assert.deepStrictEqual(
    page1.assignments.map((row) => row.taskId),
    ["t1", "t2"]
  );
  const page2 = paginateRows(sorted, parseCursor(page1.nextCursor).after, 2);
  assert.deepStrictEqual(
    page2.assignments.map((row) => row.taskId),
    ["t3"]
  );
  assert.strictEqual(page2.nextCursor, null);
  const ids = [...page1.assignments, ...page2.assignments].map(
    (row) => `${row.taskId}:${row.email}`
  );
  assert.strictEqual(new Set(ids).size, ids.length);
}

{
  const offset = Buffer.from(JSON.stringify({ o: 2 }), "utf8").toString("base64");
  assert.strictEqual(parseCursor(offset).ok, false);
  assert.strictEqual(parseCursor("%%%").ok, false);
  assert.strictEqual(
    parseCursor(
      Buffer.from(JSON.stringify({ t: "t1", e: 12 }), "utf8").toString("base64")
    ).ok,
    false
  );
  const encoded = encodeCursor({
    completedDate: "2026-02-11",
    assignedAt: "2026-02-01T00:00:00.000Z",
    taskId: "t1",
    email: "Rahul@mydgv.com",
  });
  const parsed = parseCursor(encoded);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.after.taskId, "t1");
  assert.strictEqual(parsed.after.email, "rahul@mydgv.com");
  assert.strictEqual(parsed.after.completedDate, "2026-02-11");
}

{
  const review = {
    taskId: "t-review",
    email: "rahul@mydgv.com",
    completedDate: "",
    assignedAt: "2026-02-01T00:00:00.000Z",
    costStatus: STATUS_PENDING_REVIEW,
  };
  const older = {
    taskId: "t-old",
    email: "rahul@mydgv.com",
    completedDate: "2026-01-01",
    assignedAt: "2026-01-01T00:00:00.000Z",
    costStatus: STATUS_COSTED,
    amountUsd: 1,
  };
  const firstPage = paginateRows(sortCostingRows([older, review]), null, 1);
  assert.strictEqual(firstPage.assignments[0].taskId, "t-old");
  const done = {
    ...review,
    completedDate: "2026-03-01",
    costStatus: STATUS_COSTED,
    amountUsd: 4,
  };
  const afterComplete = sortCostingRows([older, done]);
  const page2 = paginateRows(
    afterComplete,
    parseCursor(firstPage.nextCursor).after,
    1
  );
  assert.ok(!page2.assignments.some((row) => row.taskId === "t-review"));
  const refreshed = paginateRows(afterComplete, null, 2);
  assert.strictEqual(refreshed.assignments[0].taskId, "t-review");
}

assert.strictEqual(
  classifyAssignment({ status: "REVIEW", supersededByTaskId: "t2" }).costStatus,
  "SUPERSEDED"
);
assert.strictEqual(
  classifyAssignment({ status: "REVIEW" }).costStatus,
  STATUS_PENDING_REVIEW
);
assert.strictEqual(
  classifyAssignment({ status: "DONE" }, { status: STATUS_COSTED, amountUsd: 4 }).costStatus,
  STATUS_COSTED
);
assert.strictEqual(
  classifyAssignment({ status: "DONE" }, { status: STATUS_MISSING_RATE }).costStatus,
  STATUS_MISSING_RATE
);
assert.strictEqual(
  classifyAssignment({ status: "DONE" }).costStatus,
  STATUS_MISSING_COST_RECORD
);

assert.strictEqual(
  inCompletedDateRange(
    { costStatus: STATUS_COSTED, completedDate: "2026-02-10" },
    "2026-02-01",
    "2026-02-28"
  ),
  true
);
assert.strictEqual(
  inCompletedDateRange(
    { costStatus: STATUS_COSTED, completedDate: "2026-03-01" },
    "2026-02-01",
    "2026-02-28"
  ),
  false
);
assert.strictEqual(
  inCompletedDateRange(
    { costStatus: STATUS_PENDING_REVIEW, completedDate: null },
    "2026-02-01",
    "2026-02-28"
  ),
  true
);

(async () => {
  const items = seedPeople();
  items[keyOf(WORK, "ENTITY#PROJECT", "PROJECT#p1")] = {
    PK: "ENTITY#PROJECT",
    SK: "PROJECT#p1",
    projectId: "p1",
    name: "Portal",
    projectCode: "INT-001",
    projectType: "INTERNAL",
    status: "ACTIVE",
  };
  seedTask(items, {
    taskId: "t-costed",
    projectId: "p1",
    title: "Done work",
    status: "DONE",
    estimatedHours: 4,
    assignedAt: "2026-02-01T00:00:00.000Z",
    assignmentStatus: "DONE",
    actualHours: 3,
    plannedHours: 3.5,
    completedAt: "2026-02-10T18:40:00.000Z",
    completedDate: "2026-02-11",
    cost: {
      status: STATUS_COSTED,
      amountUsd: 6.75,
      hourlyRateUsd: 2.25,
      rateSource: "EMPLOYEE",
      rateVersionId: "v1",
      completedDate: "2026-02-11",
      reason: "EMPLOYEE_OVERRIDE",
    },
  });
  seedTask(items, {
    taskId: "t-missing-rate",
    projectId: "p1",
    title: "No rate",
    status: "DONE",
    estimatedHours: 2,
    assignedAt: "2026-02-02T00:00:00.000Z",
    assignmentStatus: "DONE",
    actualHours: 2,
    completedAt: "2026-02-12T10:00:00.000Z",
    completedDate: "2026-02-12",
    cost: {
      status: STATUS_MISSING_RATE,
      amountUsd: null,
      hourlyRateUsd: null,
      completedDate: "2026-02-12",
      reason: "HISTORICAL_DESIGNATION_UNKNOWN",
    },
  });
  seedTask(items, {
    taskId: "t-legacy",
    projectId: "p1",
    title: "Legacy complete",
    status: "DONE",
    estimatedHours: 1,
    assignedAt: "2026-01-15T00:00:00.000Z",
    assignmentStatus: "DONE",
    actualHours: 1,
    completedAt: "2026-01-16T10:00:00.000Z",
    completedDate: "2026-01-16",
  });
  seedTask(items, {
    taskId: "t-review",
    projectId: "p1",
    title: "In review",
    status: "REVIEW",
    estimatedHours: 5,
    assignedAt: "2026-03-01T00:00:00.000Z",
    assignmentStatus: "REVIEW",
    actualHours: 4,
  });
  seedTask(items, {
    taskId: "t-source",
    projectId: "p1",
    title: "Superseded",
    status: "REVIEW",
    estimatedHours: 2,
    assignedAt: "2026-02-01T00:00:00.000Z",
    assignmentStatus: "REVIEW",
    actualHours: 2,
    supersededByTaskId: "t-follow",
  });
  seedTask(items, {
    taskId: "t-other-catalog",
    projectId: "p-other",
    title: "Other employee work",
    status: "DONE",
    estimatedHours: 9,
    email: "ria@mydgv.com",
    assignedAt: "2026-02-01T00:00:00.000Z",
    assignmentStatus: "DONE",
    actualHours: 9,
    completedAt: "2026-02-11T10:00:00.000Z",
    completedDate: "2026-02-11",
    cost: {
      status: STATUS_COSTED,
      amountUsd: 99,
      hourlyRateUsd: 11,
      completedDate: "2026-02-11",
    },
  });
  seedTask(items, {
    taskId: "t-follow",
    projectId: "p1",
    title: "Follow-up",
    status: "DONE",
    estimatedHours: 2,
    sourceTaskId: "t-source",
    assignedAt: "2026-02-20T00:00:00.000Z",
    assignmentStatus: "DONE",
    actualHours: 2,
    completedAt: "2026-02-21T10:00:00.000Z",
    completedDate: "2026-02-21",
    cost: {
      status: STATUS_COSTED,
      amountUsd: 4.5,
      hourlyRateUsd: 2.25,
      rateSource: "EMPLOYEE",
      rateVersionId: "v1",
      completedDate: "2026-02-21",
    },
  });

  const ddb = memoryDdb(items);
  const ctx = {
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    profileTable: PROFILE,
    query: {},
  };

  const denied = await handleGetProjectCosting({
    ...ctx,
    user: EMP,
    projectId: "p1",
  });
  assert.strictEqual(denied.statusCode, 403);

  const managerDenied = await handleGetProjectCosting({
    ...ctx,
    user: MANAGER,
    projectId: "p1",
  });
  assert.strictEqual(managerDenied.statusCode, 403);

  const project = await handleGetProjectCosting({
    ...ctx,
    user: ADMIN,
    projectId: "p1",
  });
  assert.strictEqual(project.statusCode, 200);
  assert.strictEqual(project.body.project.projectCode, "INT-001");
  assert.strictEqual(project.body.summary.confirmedCostUsd, 11.25);
  assert.strictEqual(project.body.summary.completedActualHours, 8);
  assert.strictEqual(project.body.summary.pendingReviewHours, 4);
  assert.strictEqual(project.body.summary.missingRateCount, 1);
  assert.strictEqual(project.body.summary.missingCostRecordCount, 1);
  assert.strictEqual(project.body.summary.taskCount, 6);
  assert.strictEqual(project.body.summary.completedTaskCount, 4);
  const statuses = project.body.assignments.map((row) => row.costStatus);
  assert.ok(statuses.includes(STATUS_COSTED));
  assert.ok(statuses.includes(STATUS_MISSING_RATE));
  assert.ok(statuses.includes(STATUS_MISSING_COST_RECORD));
  assert.ok(statuses.includes(STATUS_PENDING_REVIEW));
  assert.ok(statuses.includes("SUPERSEDED"));
  const superseded = project.body.assignments.find((row) => row.taskId === "t-source");
  assert.strictEqual(superseded.includeInTotals, false);

  const paged = await handleGetProjectCosting({
    ...ctx,
    user: ADMIN,
    projectId: "p1",
    query: { limit: "2" },
  });
  assert.strictEqual(paged.body.assignments.length, 2);
  assert.ok(paged.body.nextCursor);
  const page2 = await handleGetProjectCosting({
    ...ctx,
    user: ADMIN,
    projectId: "p1",
    query: { limit: "2", cursor: paged.body.nextCursor },
  });
  assert.ok(page2.body.assignments.length >= 1);
  const page1Ids = paged.body.assignments.map((row) => `${row.taskId}:${row.email}`);
  const page2Ids = page2.body.assignments.map((row) => `${row.taskId}:${row.email}`);
  assert.ok(page2Ids.every((id) => !page1Ids.includes(id)));
  assert.strictEqual(page2.body.summary.confirmedCostUsd, 11.25);
  const offsetCursor = Buffer.from(JSON.stringify({ o: 2 }), "utf8").toString(
    "base64"
  );
  const badCursor = await handleGetProjectCosting({
    ...ctx,
    user: ADMIN,
    projectId: "p1",
    query: { cursor: offsetCursor },
  });
  assert.strictEqual(badCursor.statusCode, 400);

  const employee = await handleGetEmployeeCosting({
    ...ctx,
    user: SUPER,
    email: "rahul@mydgv.com",
  });
  assert.strictEqual(employee.statusCode, 200);
  assert.strictEqual(employee.body.employee.name, "Rahul");
  assert.strictEqual(employee.body.summary.confirmedCostUsd, 11.25);
  assert.strictEqual(employee.body.summary.pendingReviewHours, 4);
  assert.strictEqual(employee.body.summary.taskCount, 6);
  assert.strictEqual(employee.body.summary.completedTaskCount, 4);
  assert.strictEqual(employee.body.truncated, false);
  assert.strictEqual(employee.body.projects[0].confirmedCostUsd, 11.25);
  assert.strictEqual(employee.body.coverage.indexedOnly, true);
  assert.strictEqual(
    employee.body.coverage.omitsAssignmentsWithoutPointerOrCostSnapshot,
    true
  );
  assert.strictEqual(employee.body.assignments.filter((row) => row.taskId === "t-costed").length, 1);

  const february = await handleGetEmployeeCosting({
    ...ctx,
    user: ADMIN,
    email: "rahul@mydgv.com",
    query: { from: "2026-02-01", to: "2026-02-28" },
  });
  assert.strictEqual(february.statusCode, 200);
  assert.strictEqual(february.body.summary.confirmedCostUsd, 11.25);
  assert.strictEqual(february.body.summary.missingCostRecordCount, 0);
  assert.strictEqual(february.body.summary.pendingReviewHours, 4);
  assert.strictEqual(february.body.summary.taskCount, 5);
  assert.strictEqual(february.body.summary.completedTaskCount, 3);

  const january = await handleGetEmployeeCosting({
    ...ctx,
    user: ADMIN,
    email: "rahul@mydgv.com",
    query: { from: "2026-01-01", to: "2026-01-31" },
  });
  assert.strictEqual(january.body.summary.confirmedCostUsd, 0);
  assert.strictEqual(january.body.summary.missingCostRecordCount, 1);
  assert.strictEqual(january.body.summary.completedActualHours, 1);

  const empDenied = await handleGetEmployeeCosting({
    ...ctx,
    user: EMP,
    email: "rahul@mydgv.com",
  });
  assert.strictEqual(empDenied.statusCode, 403);

  const badDate = await handleGetEmployeeCosting({
    ...ctx,
    user: ADMIN,
    email: "rahul@mydgv.com",
    query: { from: "02-01-2026" },
  });
  assert.strictEqual(badDate.statusCode, 400);

  const laterRate = JSON.parse(JSON.stringify(project.body));
  const snap = laterRate.assignments.find((row) => row.taskId === "t-costed");
  assert.strictEqual(snap.amountUsd, 6.75);
  assert.strictEqual(snap.hourlyRateUsd, 2.25);

  const recon = summarizeRows(project.body.assignments);
  assert.strictEqual(recon.confirmedCostUsd, 11.25);
  assert.strictEqual(recon.taskCount, 6);
  assert.strictEqual(recon.completedTaskCount, 4);

  setCostingCapsForTest({ maxTasks: 2 });
  try {
    const truncatedEmp = await handleGetEmployeeCosting({
      ...ctx,
      user: ADMIN,
      email: "rahul@mydgv.com",
    });
    assert.strictEqual(truncatedEmp.statusCode, 200);
    assert.strictEqual(truncatedEmp.body.truncated, true);
    assert.ok(truncatedEmp.body.summary.taskCount <= 2);
  } finally {
    setCostingCapsForTest({ reset: true });
  }

  assert.deepStrictEqual(
    collectEmployeeTaskIds(
      [{ taskId: "a" }, { taskId: "b" }],
      [{ taskId: "a" }, { taskId: "c" }]
    ),
    ["a", "b", "c"]
  );

  const snapOnly = seedPeople();
  snapOnly[keyOf(WORK, "ENTITY#PROJECT", "PROJECT#p-snap")] = {
    PK: "ENTITY#PROJECT",
    SK: "PROJECT#p-snap",
    projectId: "p-snap",
    name: "Snap",
    projectType: "INTERNAL",
  };
  seedTask(snapOnly, {
    taskId: "t-snap-only",
    projectId: "p-snap",
    title: "Snapshot only",
    status: "DONE",
    estimatedHours: 1,
    assignedAt: "2026-02-01T00:00:00.000Z",
    assignmentStatus: "DONE",
    actualHours: 1,
    completedAt: "2026-02-11T10:00:00.000Z",
    completedDate: "2026-02-11",
    cost: {
      status: STATUS_COSTED,
      amountUsd: 2.25,
      hourlyRateUsd: 2.25,
      completedDate: "2026-02-11",
    },
  });
  delete snapOnly[keyOf(WORK, "USER#rahul@mydgv.com", "ASSIGNMENT#t-snap-only")];
  const snapReport = await handleGetEmployeeCosting({
    ddb: memoryDdb(snapOnly),
    tableName: WORK,
    accessTable: ACCESS,
    profileTable: PROFILE,
    user: ADMIN,
    email: "rahul@mydgv.com",
  });
  assert.strictEqual(snapReport.statusCode, 200);
  assert.strictEqual(snapReport.body.summary.confirmedCostUsd, 2.25);
  assert.strictEqual(snapReport.body.assignments.length, 1);
  assert.strictEqual(snapReport.body.assignments[0].amountUsd, 2.25);

  console.log("costingReports tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

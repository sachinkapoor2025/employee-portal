const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  STATUS_COSTED,
  STATUS_MISSING_RATE,
  calculateAmountUsd,
  reportingDateIst,
  ensureAssignmentCost,
  persistCompletionWithCost,
  persistSubmissionBasis,
  retireSubmissionBasis,
  reviewResubmitDecision,
  REVIEW_RECOVERY_MESSAGE,
  getAssignmentCost,
  roundUsd,
  BASIS_ACTIVE,
  BASIS_FINAL,
  BASIS_RETURNED,
  STATUS_SUBMISSION_BASIS,
} = require("./taskCosting");
const {
  handleCreateDesignation,
  handlePatchDesignation,
  handlePutEmployee,
} = require("./costRates");
  const {
    REASON,
    SOURCE_DESIGNATION,
    SOURCE_EMPLOYEE,
  } = require("./costRates");

function keyOf(table, pk, sk) {
  return `${table}\0${pk}\0${sk}`;
}

function evalCond(existing, cond, item) {
  if (!cond) return true;
  if (cond.includes(":ptrType")) {
    return (
      !existing ||
      (existing.type === item?.type &&
        existing.taskId === item?.taskId &&
        existing.email === item?.email)
    );
  }
  if (cond.includes("attribute_not_exists(PK)") && existing) return false;
  if (cond.includes("attribute_exists(PK)") && !existing) return false;
  if (cond.includes("#status = :missing")) {
    return existing && existing.status === "MISSING_RATE";
  }
  if (cond.includes("#basis = :active")) {
    return existing && existing.basisState === "ACTIVE";
  }
  if (cond.includes("#basis = :returned")) {
    return existing && existing.basisState === "RETURNED";
  }
  return true;
}

function memoryDdb(seed = {}) {
  const items = { ...seed };
  const ddb = {
    items,
    transactFails: 0,
    async send(command) {
      if (command instanceof GetCommand) {
        const k = keyOf(
          command.input.TableName,
          command.input.Key.PK,
          command.input.Key.SK
        );
        return items[k] ? { Item: { ...items[k] } } : {};
      }
      if (command instanceof PutCommand) {
        const item = command.input.Item;
        const k = keyOf(command.input.TableName, item.PK, item.SK);
        if (
          !evalCond(
            items[k],
            command.input.ConditionExpression || "",
            item
          )
        ) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        items[k] = { ...item };
        return {};
      }
      if (command instanceof QueryCommand) {
        const table = command.input.TableName;
        const pk = command.input.ExpressionAttributeValues[":pk"];
        const skPrefix = command.input.ExpressionAttributeValues[":sk"];
        const found = Object.entries(items)
          .filter(([k]) => k.startsWith(`${table}\0`))
          .map(([, item]) => item)
          .filter(
            (item) => item.PK === pk && String(item.SK || "").startsWith(skPrefix || "")
          );
        return { Items: found.map((item) => ({ ...item })) };
      }
      if (command instanceof UpdateCommand) {
        const k = keyOf(
          command.input.TableName,
          command.input.Key.PK,
          command.input.Key.SK
        );
        if (!items[k]) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        return { Attributes: { ...items[k] } };
      }
      if (command instanceof TransactWriteCommand) {
        if (ddb.transactFails > 0) {
          ddb.transactFails -= 1;
          const err = new Error("cancelled");
          err.name = "TransactionCanceledException";
          err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
          throw err;
        }
        const ops = command.input.TransactItems || [];
        for (const op of ops) {
          if (op.Put) {
            const item = op.Put.Item;
            const k = keyOf(op.Put.TableName, item.PK, item.SK);
            if (
              !evalCond(items[k], op.Put.ConditionExpression || "", item)
            ) {
              const err = new Error("cancelled");
              err.name = "TransactionCanceledException";
              err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
              throw err;
            }
          }
        }
        for (const op of ops) {
          if (op.Put) {
            const item = op.Put.Item;
            items[keyOf(op.Put.TableName, item.PK, item.SK)] = { ...item };
          }
        }
        return {};
      }
      throw new Error(command.constructor.name);
    },
  };
  return ddb;
}

const WORK = "WorkTasks";
const ACCESS = "UserAccess";
const SUPER = { email: "boss@mydgv.com", groups: ["Admin"], isAdmin: true };

function seedAccess() {
  return {
    [keyOf(ACCESS, "boss@mydgv.com", "boss@mydgv.com")]: {
      PK: "boss@mydgv.com",
      SK: "boss@mydgv.com",
      email: "boss@mydgv.com",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    },
    [keyOf(ACCESS, "rahul@mydgv.com", "rahul@mydgv.com")]: {
      PK: "rahul@mydgv.com",
      SK: "rahul@mydgv.com",
      email: "rahul@mydgv.com",
      role: "EMPLOYEE",
      status: "ACTIVE",
    },
  };
}

assert.strictEqual(roundUsd(10.005), 10.01);
assert.strictEqual(calculateAmountUsd(2.5, 3), 7.5);
assert.strictEqual(reportingDateIst("2026-10-13T18:40:00.000Z"), "2026-10-14");
assert.strictEqual(reportingDateIst("2026-10-13T18:29:00.000Z"), "2026-10-13");

(async () => {
  const ddb = memoryDdb(seedAccess());
  const created = await handleCreateDesignation({
    user: SUPER,
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-01-01T00:00:00.000Z",
    body: { name: "SEO", internalHourlyRate: 2, externalHourlyRate: 4 },
  });
  assert.strictEqual(created.statusCode, 201);
  const designationId = created.body.designation.designationId;

  const emp = await handlePutEmployee({
    user: SUPER,
    email: "rahul@mydgv.com",
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-01-01T00:00:00.000Z",
    body: {
      designationId,
      internalHourlyRate: 2.25,
      externalHourlyRate: null,
    },
  });
  assert.strictEqual(emp.statusCode, 201);

  await handlePatchDesignation({
    user: SUPER,
    designationId,
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-06-01T00:00:00.000Z",
    body: { internalHourlyRate: 9, externalHourlyRate: 12 },
  });

  await handlePutEmployee({
    user: SUPER,
    email: "rahul@mydgv.com",
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-06-01T00:00:00.000Z",
    body: { internalHourlyRate: 8, externalHourlyRate: 11 },
  });

  const task = {
    taskId: "t-int",
    projectId: "p1",
    createdAt: "2026-02-01T00:00:00.000Z",
    sourceTaskId: null,
  };
  const assignment = {
    email: "rahul@mydgv.com",
    assignedAt: "2026-02-01T00:00:00.000Z",
    actualHours: 3,
    completedAt: "2026-02-02T00:00:00.000Z",
    status: "DONE",
  };

  const internalEarly = await ensureAssignmentCost({
    ddb,
    tableName: WORK,
    task,
    assignment,
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-02-02T00:00:00.000Z",
  });
  assert.strictEqual(internalEarly.status, STATUS_COSTED);
  assert.strictEqual(internalEarly.rateSource, SOURCE_EMPLOYEE);
  assert.strictEqual(internalEarly.hourlyRateUsd, 2.25);
  assert.strictEqual(internalEarly.amountUsd, 6.75);
  assert.strictEqual(internalEarly.currency, "USD");
  assert.ok(internalEarly.rateVersionId);

  const retry = await ensureAssignmentCost({
    ddb,
    tableName: WORK,
    task,
    assignment,
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-12-01T00:00:00.000Z",
  });
  assert.strictEqual(retry.amountUsd, 6.75);
  assert.strictEqual(retry.hourlyRateUsd, 2.25);

  const extEarly = await ensureAssignmentCost({
    ddb,
    tableName: WORK,
    task: { ...task, taskId: "t-ext" },
    assignment,
    project: { projectType: "EXTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-02-02T00:00:00.000Z",
  });
  assert.strictEqual(extEarly.rateSource, SOURCE_DESIGNATION);
  assert.strictEqual(extEarly.hourlyRateUsd, 4);
  assert.strictEqual(extEarly.amountUsd, 12);

  const later = await ensureAssignmentCost({
    ddb,
    tableName: WORK,
    task: { ...task, taskId: "t-late" },
    assignment: { ...assignment, assignedAt: "2026-07-01T00:00:00.000Z" },
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-07-02T00:00:00.000Z",
  });
  assert.strictEqual(later.hourlyRateUsd, 8);
  assert.strictEqual(later.rateSource, SOURCE_EMPLOYEE);

  await handlePutEmployee({
    user: SUPER,
    email: "rahul@mydgv.com",
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-08-01T00:00:00.000Z",
    body: { designationId, internalHourlyRate: null, externalHourlyRate: null },
  });

  const afterClearPersonal = await ensureAssignmentCost({
    ddb,
    tableName: WORK,
    task: { ...task, taskId: "t-desig" },
    assignment: { ...assignment, assignedAt: "2026-08-02T00:00:00.000Z" },
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-08-02T00:00:00.000Z",
  });
  assert.strictEqual(afterClearPersonal.rateSource, SOURCE_DESIGNATION);
  assert.strictEqual(afterClearPersonal.hourlyRateUsd, 9);

  const historicalStill = await getAssignmentCost(ddb, WORK, "t-int", "rahul@mydgv.com");
  assert.strictEqual(historicalStill.hourlyRateUsd, 2.25);

  const ppc = await handleCreateDesignation({
    user: SUPER,
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-01-01T00:00:00.000Z",
    body: { name: "PPC", internalHourlyRate: 15, externalHourlyRate: 20 },
  });
  assert.strictEqual(ppc.statusCode, 201);
  await handlePutEmployee({
    user: SUPER,
    email: "rahul@mydgv.com",
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-09-01T00:00:00.000Z",
    body: {
      designationId: ppc.body.designation.designationId,
      internalHourlyRate: null,
      externalHourlyRate: null,
    },
  });
  const afterMove = await ensureAssignmentCost({
    ddb,
    tableName: WORK,
    task: { ...task, taskId: "t-moved" },
    assignment: { ...assignment, assignedAt: "2026-09-02T00:00:00.000Z" },
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-09-02T00:00:00.000Z",
  });
  assert.strictEqual(afterMove.rateSource, SOURCE_DESIGNATION);
  assert.strictEqual(afterMove.hourlyRateUsd, 15);
  const historicalAfterMove = await getAssignmentCost(
    ddb,
    WORK,
    "t-int",
    "rahul@mydgv.com"
  );
  assert.strictEqual(historicalAfterMove.hourlyRateUsd, 2.25);
  assert.strictEqual(historicalAfterMove.designationId, designationId);

  const missing = await ensureAssignmentCost({
    ddb,
    tableName: WORK,
    task: { ...task, taskId: "t-miss" },
    assignment: {
      email: "ghost@mydgv.com",
      assignedAt: "2026-02-01T00:00:00.000Z",
      actualHours: 2,
      completedAt: "2026-02-02T00:00:00.000Z",
    },
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-02-02T00:00:00.000Z",
  });
  assert.strictEqual(missing.status, STATUS_MISSING_RATE);
  assert.strictEqual(missing.reason, REASON.HISTORICAL_DESIGNATION_UNKNOWN);
  assert.strictEqual(missing.amountUsd, null);
  assert.strictEqual(missing.hourlyRateUsd, null);

  ddb.items[keyOf(ACCESS, "ghost@mydgv.com", "ghost@mydgv.com")] = {
    PK: "ghost@mydgv.com",
    SK: "ghost@mydgv.com",
    email: "ghost@mydgv.com",
    role: "EMPLOYEE",
    status: "ACTIVE",
  };
  await handlePutEmployee({
    user: SUPER,
    email: "ghost@mydgv.com",
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-03-01T00:00:00.000Z",
    body: { designationId, internalHourlyRate: 6 },
  });
  const filled = await ensureAssignmentCost({
    ddb,
    tableName: WORK,
    task: { ...task, taskId: "t-miss" },
    assignment: {
      email: "ghost@mydgv.com",
      assignedAt: "2026-02-01T00:00:00.000Z",
      actualHours: 2,
      completedAt: "2026-02-02T00:00:00.000Z",
    },
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-03-02T00:00:00.000Z",
  });
  assert.strictEqual(filled.status, STATUS_MISSING_RATE);
  assert.strictEqual(filled.reason, REASON.HISTORICAL_DESIGNATION_UNKNOWN);
  assert.strictEqual(filled.amountUsd, null);

  await handlePutEmployee({
    user: SUPER,
    email: "ghost@mydgv.com",
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-09-01T00:00:00.000Z",
    body: {
      designationId: ppc.body.designation.designationId,
      internalHourlyRate: null,
      externalHourlyRate: null,
    },
  });
  const delayed = await ensureAssignmentCost({
    ddb,
    tableName: WORK,
    task: { ...task, taskId: "t-miss" },
    assignment: {
      email: "ghost@mydgv.com",
      assignedAt: "2026-02-01T00:00:00.000Z",
      actualHours: 2,
      completedAt: "2026-02-02T00:00:00.000Z",
    },
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-09-02T00:00:00.000Z",
  });
  assert.strictEqual(delayed.status, STATUS_MISSING_RATE);
  assert.strictEqual(delayed.reason, REASON.HISTORICAL_DESIGNATION_UNKNOWN);
  assert.strictEqual(delayed.hourlyRateUsd, null);

  const unclassified = await ensureAssignmentCost({
    ddb,
    tableName: WORK,
    task: { ...task, taskId: "t-unclass" },
    assignment,
    project: { name: "Legacy" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-02-02T00:00:00.000Z",
  });
  assert.strictEqual(unclassified.status, STATUS_MISSING_RATE);
  assert.strictEqual(unclassified.reason, REASON.UNCLASSIFIED_PROJECT);
  assert.strictEqual(unclassified.amountUsd, null);

  let hoursErr = null;
  try {
    await ensureAssignmentCost({
      ddb,
      tableName: WORK,
      task: { ...task, taskId: "t-hours" },
      assignment: { ...assignment, actualHours: null },
      project: { projectType: "INTERNAL" },
      approvedBy: "admin@mydgv.com",
      nowIso: "2026-02-02T00:00:00.000Z",
    });
  } catch (err) {
    hoursErr = err;
  }
  assert.strictEqual(hoursErr.statusCode, 400);

  const raceDdb = memoryDdb(seedAccess());
  raceDdb.transactFails = 1;
  raceDdb.items[keyOf(WORK, "TASK#t-race", "COST#rahul@mydgv.com")] = {
    PK: "TASK#t-race",
    SK: "COST#rahul@mydgv.com",
    status: STATUS_COSTED,
    amountUsd: 1,
    hourlyRateUsd: 1,
    actualHours: 1,
    email: "rahul@mydgv.com",
    taskId: "t-race",
  };
  const raced = await ensureAssignmentCost({
    ddb: raceDdb,
    tableName: WORK,
    task: { taskId: "t-race", projectId: "p1" },
    assignment: {
      email: "rahul@mydgv.com",
      assignedAt: "2026-02-01T00:00:00.000Z",
      actualHours: 1,
    },
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-02-02T00:00:00.000Z",
  });
  assert.strictEqual(raced.amountUsd, 1);

  const raceEmpty = memoryDdb(seedAccess());
  raceEmpty.transactFails = 1;
  const origSend = raceEmpty.send.bind(raceEmpty);
  raceEmpty.send = async (command) => {
    try {
      return await origSend(command);
    } catch (err) {
      if (err.name === "TransactionCanceledException") {
        raceEmpty.items[keyOf(WORK, "TASK#t-race2", "COST#rahul@mydgv.com")] = {
          PK: "TASK#t-race2",
          SK: "COST#rahul@mydgv.com",
          status: STATUS_COSTED,
          amountUsd: 3.5,
          hourlyRateUsd: 3.5,
          actualHours: 1,
          email: "rahul@mydgv.com",
          taskId: "t-race2",
        };
      }
      throw err;
    }
  };
  const racedEmpty = await ensureAssignmentCost({
    ddb: raceEmpty,
    tableName: WORK,
    task: { taskId: "t-race2", projectId: "p1" },
    assignment: {
      email: "rahul@mydgv.com",
      assignedAt: "2026-02-01T00:00:00.000Z",
      actualHours: 1,
    },
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-02-02T00:00:00.000Z",
  });
  assert.strictEqual(racedEmpty.amountUsd, 3.5);

  const atomic = memoryDdb(seedAccess());
  const storedAssignment = {
    PK: "TASK#t-atomic",
    SK: "ASSIGNMENT#rahul@mydgv.com",
    type: "ASSIGNMENT",
    taskId: "t-atomic",
    email: "rahul@mydgv.com",
    status: "REVIEW",
    actualHours: 2,
    assignedAt: "2026-02-01T00:00:00.000Z",
  };
  atomic.items[keyOf(WORK, storedAssignment.PK, storedAssignment.SK)] = {
    ...storedAssignment,
  };
  const outgoingAssignment = {
    ...storedAssignment,
    status: "DONE",
    completedAt: "2026-02-02T00:00:00.000Z",
  };
  const submitted = await persistSubmissionBasis({
    ddb: atomic,
    tableName: WORK,
    assignmentItem: { ...storedAssignment, status: "REVIEW" },
    task: { taskId: "t-atomic", projectId: "p1" },
    assignment: { ...storedAssignment, status: "REVIEW", actualHours: 2 },
    project: { projectType: "INTERNAL" },
    nowIso: "2026-02-01T12:00:00.000Z",
  });
  assert.strictEqual(submitted.status, STATUS_MISSING_RATE);
  assert.strictEqual(submitted.basisState, BASIS_ACTIVE);
  assert.strictEqual(submitted.reason, REASON.HISTORICAL_DESIGNATION_UNKNOWN);
  atomic.transactFails = 1;
  let atomicErr = null;
  try {
    await persistCompletionWithCost({
      ddb: atomic,
      tableName: WORK,
      assignmentItem: outgoingAssignment,
      task: { taskId: "t-atomic", projectId: "p1" },
      assignment: outgoingAssignment,
      approvedBy: "admin@mydgv.com",
      nowIso: "2026-02-02T00:00:00.000Z",
    });
  } catch (err) {
    atomicErr = err;
  }
  assert.strictEqual(atomicErr.code, "TASK_COST_SNAPSHOT");
  assert.strictEqual(
    atomic.items[keyOf(WORK, storedAssignment.PK, storedAssignment.SK)].status,
    "REVIEW"
  );
  assert.strictEqual(
    atomic.items[keyOf(WORK, "TASK#t-atomic", "COST#rahul@mydgv.com")].basisState,
    BASIS_ACTIVE
  );

  const atomicOk = await persistCompletionWithCost({
    ddb: atomic,
    tableName: WORK,
    assignmentItem: outgoingAssignment,
    task: { taskId: "t-atomic", projectId: "p1" },
    assignment: outgoingAssignment,
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-02-02T00:00:00.000Z",
  });
  assert.strictEqual(atomicOk.status, STATUS_MISSING_RATE);
  assert.strictEqual(atomicOk.basisState, BASIS_FINAL);
  assert.strictEqual(atomicOk.reason, REASON.HISTORICAL_DESIGNATION_UNKNOWN);
  assert.strictEqual(
    atomic.items[keyOf(WORK, storedAssignment.PK, storedAssignment.SK)].status,
    "DONE"
  );
  const retryAtomic = await persistCompletionWithCost({
    ddb: atomic,
    tableName: WORK,
    assignmentItem: outgoingAssignment,
    task: { taskId: "t-atomic", projectId: "p1" },
    assignment: outgoingAssignment,
    project: { projectType: "INTERNAL" },
    approvedBy: "admin@mydgv.com",
    nowIso: "2026-02-03T00:00:00.000Z",
  });
  assert.strictEqual(retryAtomic.status, STATUS_MISSING_RATE);
  assert.strictEqual(retryAtomic.createdAt, atomicOk.createdAt);

  const missingBasis = memoryDdb(seedAccess());
  let missingBasisErr = null;
  try {
    await persistCompletionWithCost({
      ddb: missingBasis,
      tableName: WORK,
      assignmentItem: outgoingAssignment,
      task: { taskId: "t-atomic", projectId: "p1" },
      assignment: outgoingAssignment,
      approvedBy: "admin@mydgv.com",
      nowIso: "2026-02-02T00:00:00.000Z",
    });
  } catch (err) {
    missingBasisErr = err;
  }
  assert.strictEqual(missingBasisErr.code, "SUBMISSION_BASIS_REQUIRED");

  const rates = memoryDdb(seedAccess());
  const writer = await handleCreateDesignation({
    user: SUPER,
    ddb: rates,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-10-01T00:00:00.000Z",
    body: { name: "Writer", internalHourlyRate: 1, externalHourlyRate: 3 },
  });
  assert.strictEqual(writer.statusCode, 201);
  const writerId = writer.body.designation.designationId;
  const hired = await handlePutEmployee({
    user: SUPER,
    email: "rahul@mydgv.com",
    ddb: rates,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-10-01T00:00:00.000Z",
    body: { designationId: writerId, internalHourlyRate: 1, externalHourlyRate: null },
  });
  assert.strictEqual(hired.statusCode, 201);
  const project = { projectType: "INTERNAL" };
  const octTask = { taskId: "t-oct", projectId: "p1", createdAt: "2026-10-01T00:00:00.000Z" };
  const octStored = {
    PK: "TASK#t-oct",
    SK: "ASSIGNMENT#rahul@mydgv.com",
    type: "ASSIGNMENT",
    taskId: "t-oct",
    email: "rahul@mydgv.com",
    status: "IN_PROGRESS",
    assignedAt: "2026-10-01T00:00:00.000Z",
    actualHours: 6,
  };
  rates.items[keyOf(WORK, octStored.PK, octStored.SK)] = { ...octStored };
  const octSubmit = await persistSubmissionBasis({
    ddb: rates,
    tableName: WORK,
    assignmentItem: { ...octStored, status: "REVIEW", submittedAt: "2026-10-28T04:00:00.000Z" },
    task: octTask,
    assignment: { ...octStored, status: "REVIEW", actualHours: 6 },
    project,
    nowIso: "2026-10-28T04:00:00.000Z",
  });
  assert.strictEqual(octSubmit.status, STATUS_SUBMISSION_BASIS);
  assert.strictEqual(octSubmit.basisState, BASIS_ACTIVE);
  assert.strictEqual(octSubmit.hourlyRateUsd, 1);
  assert.strictEqual(octSubmit.amountUsd, 6);
  assert.strictEqual(octSubmit.actualHours, 6);
  assert.strictEqual(octSubmit.submittedAt, "2026-10-28T04:00:00.000Z");
  assert.ok(octSubmit.rateVersionId);
  assert.ok(octSubmit.rateSource);
  const raised = await handlePutEmployee({
    user: SUPER,
    email: "rahul@mydgv.com",
    ddb: rates,
    tableName: WORK,
    accessTable: ACCESS,
    nowIso: "2026-10-29T04:00:00.000Z",
    body: { internalHourlyRate: 2, externalHourlyRate: null },
  });
  assert.strictEqual(raised.statusCode, 200);
  const unchanged = await persistSubmissionBasis({
    ddb: rates,
    tableName: WORK,
    assignmentItem: { ...octStored, status: "REVIEW", actualHours: 9 },
    task: octTask,
    assignment: { ...octStored, status: "REVIEW", actualHours: 9 },
    project,
    nowIso: "2026-10-29T05:00:00.000Z",
  });
  assert.strictEqual(unchanged.submissionId, octSubmit.submissionId);
  assert.strictEqual(unchanged.hourlyRateUsd, 1);
  assert.strictEqual(unchanged.amountUsd, 6);
  assert.strictEqual(unchanged.submittedAt, "2026-10-28T04:00:00.000Z");
  assert.strictEqual(
    rates.items[keyOf(WORK, octStored.PK, octStored.SK)].submittedAt,
    "2026-10-28T04:00:00.000Z"
  );
  const approved = await persistCompletionWithCost({
    ddb: rates,
    tableName: WORK,
    assignmentItem: {
      ...octStored,
      status: "DONE",
      actualHours: 9,
      completedAt: "2026-10-30T04:00:00.000Z",
    },
    task: octTask,
    assignment: {
      ...octStored,
      status: "DONE",
      actualHours: 9,
      completedAt: "2026-10-30T04:00:00.000Z",
    },
    approvedBy: "boss@mydgv.com",
    nowIso: "2026-10-30T04:00:00.000Z",
  });
  assert.strictEqual(approved.status, STATUS_COSTED);
  assert.strictEqual(approved.basisState, BASIS_FINAL);
  assert.strictEqual(approved.hourlyRateUsd, 1);
  assert.strictEqual(approved.amountUsd, 6);
  assert.strictEqual(approved.actualHours, 6);
  assert.strictEqual(approved.rateVersionId, octSubmit.rateVersionId);
  assert.strictEqual(approved.rateSource, octSubmit.rateSource);
  assert.strictEqual(approved.finalizedSubmissionId, octSubmit.submissionId);
  assert.strictEqual(approved.submittedAt, "2026-10-28T04:00:00.000Z");
  assert.strictEqual(
    rates.items[keyOf(WORK, octStored.PK, octStored.SK)].actualHours,
    6
  );

  const returnedTask = { taskId: "t-return", projectId: "p1" };
  const returnedStored = {
    ...octStored,
    PK: "TASK#t-return",
    taskId: "t-return",
    status: "REVIEW",
    actualHours: 6,
  };
  rates.items[keyOf(WORK, returnedStored.PK, returnedStored.SK)] = {
    ...returnedStored,
  };
  const firstPass = await persistSubmissionBasis({
    ddb: rates,
    tableName: WORK,
    assignmentItem: returnedStored,
    task: returnedTask,
    assignment: returnedStored,
    project,
    nowIso: "2026-10-28T04:00:00.000Z",
  });
  assert.strictEqual(firstPass.amountUsd, 6);
  await retireSubmissionBasis({
    ddb: rates,
    tableName: WORK,
    assignmentItem: { ...returnedStored, status: "IN_PROGRESS" },
    task: returnedTask,
    assignment: { ...returnedStored, status: "IN_PROGRESS" },
    nowIso: "2026-10-29T06:00:00.000Z",
  });
  const retired = await getAssignmentCost(
    rates,
    WORK,
    "t-return",
    "rahul@mydgv.com"
  );
  assert.strictEqual(retired.basisState, BASIS_RETURNED);
  assert.strictEqual(retired.amountUsd, 6);
  assert.strictEqual(retired.submittedAt, "2026-10-28T04:00:00.000Z");
  assert.strictEqual(
    rates.items[keyOf(WORK, returnedStored.PK, returnedStored.SK)].submittedAt,
    "2026-10-28T04:00:00.000Z"
  );
  const resubmit = await persistSubmissionBasis({
    ddb: rates,
    tableName: WORK,
    assignmentItem: { ...returnedStored, status: "REVIEW", actualHours: 4 },
    task: returnedTask,
    assignment: { ...returnedStored, status: "REVIEW", actualHours: 4 },
    project,
    nowIso: "2026-10-30T04:00:00.000Z",
  });
  assert.strictEqual(resubmit.hourlyRateUsd, 2);
  assert.strictEqual(resubmit.actualHours, 4);
  assert.strictEqual(resubmit.amountUsd, 8);
  assert.notStrictEqual(resubmit.rateVersionId, firstPass.rateVersionId);
  assert.notStrictEqual(resubmit.submissionId, firstPass.submissionId);
  const history = Object.values(rates.items).filter(
    (item) => item.SK && String(item.SK).startsWith("COSTHIST#")
  );
  const originalHistory = history.find((item) => item.submissionId === firstPass.submissionId);
  assert.ok(originalHistory);
  assert.strictEqual(originalHistory.submittedAt, "2026-10-28T04:00:00.000Z");
  assert.strictEqual(resubmit.submittedAt, "2026-10-30T04:00:00.000Z");
  const resubmitApproved = await persistCompletionWithCost({
    ddb: rates,
    tableName: WORK,
    assignmentItem: {
      ...returnedStored,
      status: "DONE",
      actualHours: 4,
      completedAt: "2026-10-30T08:00:00.000Z",
    },
    task: returnedTask,
    assignment: {
      ...returnedStored,
      status: "DONE",
      actualHours: 4,
      completedAt: "2026-10-30T08:00:00.000Z",
    },
    approvedBy: "boss@mydgv.com",
    nowIso: "2026-10-30T08:00:00.000Z",
  });
  assert.strictEqual(resubmitApproved.amountUsd, 8);
  assert.strictEqual(resubmitApproved.finalizedSubmissionId, resubmit.submissionId);

  const missingDecision = reviewResubmitDecision({
    basis: null,
    actualHoursInput: 6,
  });
  assert.strictEqual(missingDecision.ok, false);
  assert.strictEqual(missingDecision.code, "SUBMISSION_BASIS_REQUIRED");
  assert.strictEqual(missingDecision.error, REVIEW_RECOVERY_MESSAGE);
  const lockedDecision = reviewResubmitDecision({
    basis: { basisState: "ACTIVE", actualHours: 6, status: "SUBMISSION_BASIS" },
    actualHoursInput: 4,
  });
  assert.strictEqual(lockedDecision.code, "SUBMISSION_HOURS_LOCKED");
  const repairDecision = reviewResubmitDecision({
    basis: { basisState: "ACTIVE", actualHours: 6, status: "SUBMISSION_BASIS" },
    actualHoursInput: 6,
  });
  assert.strictEqual(repairDecision.repair, true);
  assert.strictEqual(repairDecision.actualHours, 6);

  console.log("taskCosting tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

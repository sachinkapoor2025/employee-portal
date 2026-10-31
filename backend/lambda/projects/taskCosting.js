const { randomUUID } = require("crypto");
const { GetCommand, PutCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const {
  prepareProtectedAssignmentPut,
  putAssignmentSafe,
  userAssignmentPointerItem,
  assertPersistOk,
} = require("./taskNotifyPersist");
const { pointerPut } = require("./userAssignmentPointers");
const { normalizeEmail } = require("./projectAccess");
const {
  REASON,
  SOURCE_EMPLOYEE,
  SOURCE_DESIGNATION,
  resolveHourlyRatesAt,
  isValidPositiveRate,
} = require("./costRates");
const { parseRequiredHours } = require("./taskTime");

/**
 * Submission costing:
 * The snapshot is written when the assignment enters REVIEW, using the rate
 * effective at that submission instant. Approval does not rewrite it.
 * A rejected attempt keeps its snapshot. The follow-up is a new task and gets
 * its own snapshot when that attempt is submitted. Admin Complete of a
 * superseded source is still rejected with 409 ASSIGNMENT_SUPERSEDED.
 */
const TYPE_ASSIGNMENT_COST = "ASSIGNMENT_COST";
const STATUS_COSTED = "COSTED";
const STATUS_MISSING_RATE = "MISSING_RATE";
const CURRENCY_USD = "USD";
const ASSIGNMENT_SUPERSEDED = "ASSIGNMENT_SUPERSEDED";
const SUPERSEDED_MESSAGE =
  "This assignment was reassigned. Complete the follow-up task instead.";

/**
 * Monetary amounts are USD cents using half-up rounding:
 * Math.round(actualHours * hourlyRateUsd * 100) / 100.
 * Hours remain the existing two-decimal assignment hours.
 */
function roundUsd(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

function calculateAmountUsd(actualHours, hourlyRateUsd) {
  return roundUsd(Number(actualHours) * Number(hourlyRateUsd));
}

function companyTimeZone() {
  return process.env.COMPANY_TIMEZONE || "Asia/Kolkata";
}

function reportingDateIst(iso, timeZone = companyTimeZone()) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

const COST_INDEX_PAIRED = "PAIRED";
const COST_INDEX_ABSENT = "ABSENT";
const COST_INDEX_MISSING_TASK = "MISSING_TASK_COST_INDEX";
const COST_INDEX_MISSING_EMPLOYEE = "MISSING_EMPLOYEE_COST_INDEX";
const COST_INDEX_MISMATCH = "COST_INDEX_MISMATCH";

/**
 * Compare the task cost copy and the employee cost copy.
 * This does not write or delete either record.
 * Repair is a later maintenance copy of the surviving item onto the missing
 * key. Keep the stored amount, rate, hours, submittedAt, and attemptId.
 * Do not recalculate and do not delete the surviving copy.
 */
function diagnoseCostIndexes(taskItem, employeeItem) {
  if (!taskItem && !employeeItem) {
    return { status: COST_INDEX_ABSENT, repair: null };
  }
  if (taskItem && !employeeItem) {
    return {
      status: COST_INDEX_MISSING_EMPLOYEE,
      repair:
        "Copy TASK#taskId / COST#email onto USER#email / ASSIGNMENT_COST#taskId. Do not delete the task copy or recalculate the amount.",
    };
  }
  if (!taskItem && employeeItem) {
    return {
      status: COST_INDEX_MISSING_TASK,
      repair:
        "Copy USER#email / ASSIGNMENT_COST#taskId onto TASK#taskId / COST#email. Do not delete the employee copy or recalculate the amount. The project costing report reads only the task copy, so it stays unpriced until that copy is restored.",
    };
  }
  const paired =
    taskItem.status === employeeItem.status &&
    taskItem.amountUsd === employeeItem.amountUsd &&
    taskItem.actualHours === employeeItem.actualHours;
  if (!paired) {
    return {
      status: COST_INDEX_MISMATCH,
      repair:
        "Do not delete either copy. Restore the differing copy from the record that matches the assignment submission. Do not recalculate the amount.",
    };
  }
  return { status: COST_INDEX_PAIRED, repair: null };
}

function costSk(email) {
  return `COST#${normalizeEmail(email)}`;
}

function employeeCostSk(taskId) {
  return `ASSIGNMENT_COST#${taskId}`;
}

function assignmentSk(email) {
  return `ASSIGNMENT#${normalizeEmail(email)}`;
}

function classifyProjectType(project) {
  const raw = String(project?.projectType || "").toUpperCase();
  if (raw === "INTERNAL" || raw === "EXTERNAL") return raw;
  return null;
}

function taskCostKey(tableName, taskId, email) {
  return {
    TableName: tableName,
    Key: { PK: `TASK#${taskId}`, SK: costSk(email) },
  };
}

async function getAssignmentCost(ddb, tableName, taskId, email) {
  const res = await ddb.send(new GetCommand(taskCostKey(tableName, taskId, email)));
  return res.Item || null;
}

function buildCostSnapshot({
  task,
  assignment,
  project,
  resolved,
  actualHours,
  approvedBy,
  nowIso,
}) {
  const email = normalizeEmail(assignment.email);
  const projectType = classifyProjectType(project);
  const assignedAt =
    assignment.assignedAt || task.createdAt || nowIso;
  const submittedAt = assignment.submittedAt || null;
  const completedAt = assignment.completedAt || (submittedAt ? null : nowIso);
  const datedAt = submittedAt || completedAt;
  const applies = Boolean(resolved?.project?.applies);
  const rate = resolved?.project?.rate;
  const hasRate = applies && isValidPositiveRate(rate);
  const status = hasRate ? STATUS_COSTED : STATUS_MISSING_RATE;
  const reason = hasRate
    ? resolved.project.reason ||
      (resolved.project.source === SOURCE_EMPLOYEE
        ? REASON.EMPLOYEE_OVERRIDE
        : REASON.DESIGNATION_FALLBACK)
    : !applies
      ? REASON.UNCLASSIFIED_PROJECT
      : resolved?.project?.reason || REASON.RATE_UNSET;
  const hourlyRateUsd = hasRate ? rate : null;
  const amountUsd = hasRate ? calculateAmountUsd(actualHours, hourlyRateUsd) : null;
  const base = {
    type: TYPE_ASSIGNMENT_COST,
    status,
    reason,
    taskId: task.taskId,
    projectId: task.projectId || null,
    email,
    projectType,
    assignmentSk: assignmentSk(email),
    assignedAt,
    submittedAt,
    attemptId: assignment.attemptId || null,
    actualHours,
    hourlyRateUsd,
    currency: CURRENCY_USD,
    rateSource: hasRate ? resolved.project.source : null,
    rateVersionId: hasRate ? resolved.rateVersionId || null : null,
    designationId: resolved?.designationId || assignment.designationId || null,
    amountUsd,
    completedAt,
    completedDate: datedAt ? reportingDateIst(datedAt) : null,
    approvedBy: normalizeEmail(approvedBy) || "",
    sourceTaskId: task.sourceTaskId || null,
    createdAt: nowIso,
  };
  return {
    taskItem: {
      PK: `TASK#${task.taskId}`,
      SK: costSk(email),
      ...base,
    },
    employeeItem: {
      PK: `USER#${email}`,
      SK: employeeCostSk(task.taskId),
      ...base,
    },
  };
}

function costedFieldsFromResolved(snapshotBase, resolved, actualHours) {
  const rate = resolved.project.rate;
  return {
    ...snapshotBase,
    status: STATUS_COSTED,
    reason: resolved.project.reason,
    hourlyRateUsd: rate,
    rateSource: resolved.project.source,
    rateVersionId: resolved.rateVersionId || null,
    designationId: resolved.designationId || snapshotBase.designationId || null,
    amountUsd: calculateAmountUsd(actualHours, rate),
    projectType: resolved.project.projectType || snapshotBase.projectType,
  };
}

async function putCostSnapshots(ddb, tableName, { taskItem, employeeItem }) {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: taskItem,
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: employeeItem,
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ],
    })
  );
}

function isConditionalOrCanceled(err) {
  const name = String(err?.name || "");
  return (
    name === "ConditionalCheckFailedException" ||
    name === "TransactionCanceledException"
  );
}

async function fulfillMissingCost({
  ddb,
  tableName,
  existing,
  task,
  assignment,
  project,
  approvedBy,
  nowIso,
}) {
  if (!existing || existing.status !== STATUS_MISSING_RATE) return existing;
  if (existing.amountUsd != null) return existing;
  const hours = parseRequiredHours(existing.actualHours || assignment.actualHours);
  if (!hours.ok) return existing;
  const resolved = await resolveHourlyRatesAt({
    ddb,
    tableName,
    email: existing.email || assignment.email,
    projectType: classifyProjectType(project) || existing.projectType,
    atIso: existing.assignedAt || assignment.assignedAt || task.createdAt,
  });
  if (!resolved.project.applies || !isValidPositiveRate(resolved.project.rate)) {
    return existing;
  }
  const { taskItem, employeeItem } = buildCostSnapshot({
    task,
    assignment: { ...assignment, assignedAt: existing.assignedAt },
    project,
    resolved,
    actualHours: hours.value,
    approvedBy: approvedBy || existing.approvedBy,
    nowIso,
  });
  const filledTask = {
    ...existing,
    ...costedFieldsFromResolved(existing, resolved, hours.value),
    createdAt: existing.createdAt,
  };
  const filledEmployee = {
    ...employeeItem,
    ...filledTask,
    PK: `USER#${filledTask.email}`,
    SK: employeeCostSk(filledTask.taskId),
  };
  filledTask.PK = existing.PK;
  filledTask.SK = existing.SK;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: filledTask,
              ConditionExpression: "#status = :missing",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":missing": STATUS_MISSING_RATE },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: { ...filledEmployee, createdAt: existing.createdAt },
              ConditionExpression: "#status = :missing",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":missing": STATUS_MISSING_RATE },
            },
          },
        ],
      })
    );
    return filledTask;
  } catch (err) {
    if (isConditionalOrCanceled(err)) {
      return getAssignmentCost(ddb, tableName, task.taskId, assignment.email);
    }
    throw err;
  }
}

async function ensureAssignmentCost({
  ddb,
  tableName,
  task,
  assignment,
  project,
  approvedBy,
  nowIso,
}) {
  const hours = parseRequiredHours(assignment?.actualHours);
  if (!hours.ok) {
    const err = new Error(hours.error);
    err.statusCode = 400;
    err.code = "ACTUAL_HOURS_REQUIRED";
    throw err;
  }
  const email = normalizeEmail(assignment.email);
  const existing = await getAssignmentCost(ddb, tableName, task.taskId, email);
  if (existing?.status === STATUS_COSTED) return existing;
  if (existing?.status === STATUS_MISSING_RATE) {
    return fulfillMissingCost({
      ddb,
      tableName,
      existing,
      task,
      assignment,
      project,
      approvedBy,
      nowIso,
    });
  }
  const assignedAt = assignment.assignedAt || task.createdAt || nowIso;
  const resolved = await resolveHourlyRatesAt({
    ddb,
    tableName,
    email,
    projectType: classifyProjectType(project),
    atIso: assignedAt,
  });
  const snapshots = buildCostSnapshot({
    task,
    assignment,
    project,
    resolved,
    actualHours: hours.value,
    approvedBy,
    nowIso,
  });
  try {
    await putCostSnapshots(ddb, tableName, snapshots);
    return snapshots.taskItem;
  } catch (err) {
    if (isConditionalOrCanceled(err)) {
      const raced = await getAssignmentCost(ddb, tableName, task.taskId, email);
      if (raced) return raced;
    }
    throw err;
  }
}

function snapshotError(cause) {
  const err = new Error(
    "Unable to save the task cost record. Retry the completion action."
  );
  err.statusCode = 500;
  err.code = "TASK_COST_SNAPSHOT";
  err.cause = cause;
  return err;
}

/**
 * Write the completing ASSIGNMENT row in the same TransactWrite as the two
 * COST snapshots (3 items, under DynamoDB's 100-item limit). Overlay notify
 * attrs first so red-admin fields are not clobbered. Task copies stay
 * outside the transact; if those fail, COST + DONE assignment already exist
 * and a Complete retry is idempotent.
 */
async function persistCompletionWithCost({
  ddb,
  tableName,
  assignmentItem,
  task,
  assignment,
  project,
  approvedBy,
  nowIso,
}) {
  const hours = parseRequiredHours(assignment?.actualHours);
  if (!hours.ok) {
    const err = new Error(hours.error);
    err.statusCode = 400;
    err.code = "ACTUAL_HOURS_REQUIRED";
    throw err;
  }
  const email = normalizeEmail(assignment.email);
  const prepared = await prepareProtectedAssignmentPut(
    ddb,
    tableName,
    assignmentItem
  );
  if (!prepared.ok) {
    throw snapshotError(new Error(prepared.reason || "ASSIGNMENT_PREPARE"));
  }
  const existing = await getAssignmentCost(ddb, tableName, task.taskId, email);
  if (existing?.status === STATUS_COSTED) {
    const written = await putAssignmentSafe(ddb, tableName, assignmentItem);
    assertPersistOk(written, {
      op: "writeAssignmentWithExistingCost",
      taskId: task.taskId,
      email,
    });
    return existing;
  }
  if (existing?.status === STATUS_MISSING_RATE) {
    const filled = await fulfillMissingCost({
      ddb,
      tableName,
      existing,
      task,
      assignment,
      project,
      approvedBy,
      nowIso,
    });
    const written = await putAssignmentSafe(ddb, tableName, assignmentItem);
    assertPersistOk(written, {
      op: "writeAssignmentWithMissingCost",
      taskId: task.taskId,
      email,
    });
    return filled;
  }
  const assignedAt = assignment.assignedAt || task.createdAt || nowIso;
  const resolved = await resolveHourlyRatesAt({
    ddb,
    tableName,
    email,
    projectType: classifyProjectType(project),
    atIso: assignedAt,
  });
  const snapshots = buildCostSnapshot({
    task,
    assignment,
    project,
    resolved,
    actualHours: hours.value,
    approvedBy,
    nowIso,
  });
  const pointer = userAssignmentPointerItem(assignmentItem);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          prepared.put,
          {
            Put: {
              TableName: tableName,
              Item: snapshots.taskItem,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: snapshots.employeeItem,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          ...(pointer ? [pointerPut(tableName, pointer)] : []),
        ],
      })
    );
    return snapshots.taskItem;
  } catch (err) {
    if (isConditionalOrCanceled(err)) {
      const raced = await getAssignmentCost(ddb, tableName, task.taskId, email);
      if (raced) {
        const written = await putAssignmentSafe(ddb, tableName, assignmentItem);
        assertPersistOk(written, {
          op: "writeAssignmentAfterCostRace",
          taskId: task.taskId,
          email,
        });
        return raced;
      }
    }
    throw snapshotError(err);
  }
}

/**
 * Write the REVIEW assignment and its two cost copies together.
 * A second call for the same task and email returns the existing snapshot
 * and does not create another amount.
 */
function submissionActivityPut(tableName, activityItem) {
  if (!activityItem?.PK || !activityItem?.SK) return null;
  return {
    Put: {
      TableName: tableName,
      Item: activityItem,
      ConditionExpression: "attribute_not_exists(PK)",
    },
  };
}

async function putSubmissionActivityOnce(ddb, tableName, activityItem) {
  const put = submissionActivityPut(tableName, activityItem);
  if (!put) return;
  try {
    await ddb.send(new PutCommand(put.Put));
  } catch (err) {
    if (!isConditionalOrCanceled(err)) throw err;
  }
}

async function persistSubmissionWithCost({
  ddb,
  tableName,
  assignmentItem,
  task,
  assignment,
  project,
  nowIso,
  activityItem = null,
}) {
  const hours = parseRequiredHours(assignment?.actualHours);
  if (!hours.ok) {
    const err = new Error(hours.error);
    err.statusCode = 400;
    err.code = "ACTUAL_HOURS_REQUIRED";
    throw err;
  }
  const email = normalizeEmail(assignment.email);
  const submittedAt = assignment.submittedAt || nowIso;
  const attemptId = assignment.attemptId || randomUUID();
  const pricedAssignment = {
    ...assignment,
    actualHours: hours.value,
    submittedAt,
    attemptId,
  };
  const existing = await getAssignmentCost(ddb, tableName, task.taskId, email);
  if (existing?.status === STATUS_COSTED || existing?.status === STATUS_MISSING_RATE) {
    const preserved = await prepareProtectedAssignmentPut(ddb, tableName, {
      ...assignmentItem,
      actualHours: existing.actualHours ?? hours.value,
      submittedAt: existing.submittedAt || submittedAt,
      attemptId: existing.attemptId || attemptId,
      status: "REVIEW",
    });
    if (preserved.ok) {
      const written = await putAssignmentSafe(ddb, tableName, preserved.item);
      assertPersistOk(written, {
        op: "writeAssignmentWithExistingSubmissionCost",
        taskId: task.taskId,
        email,
      });
      await putSubmissionActivityOnce(ddb, tableName, activityItem);
    }
    return existing;
  }
  const resolved = await resolveHourlyRatesAt({
    ddb,
    tableName,
    email,
    projectType: classifyProjectType(project),
    atIso: submittedAt,
  });
  const snapshots = buildCostSnapshot({
    task,
    assignment: pricedAssignment,
    project,
    resolved,
    actualHours: hours.value,
    approvedBy: "",
    nowIso,
  });
  const prepared = await prepareProtectedAssignmentPut(ddb, tableName, {
    ...assignmentItem,
    actualHours: hours.value,
    submittedAt,
    attemptId,
    status: "REVIEW",
  });
  if (!prepared.ok) {
    throw snapshotError(new Error(prepared.reason || "ASSIGNMENT_PREPARE"));
  }
  const pointer = userAssignmentPointerItem(prepared.item || assignmentItem);
  const activityPut = activityItem ? submissionActivityPut(tableName, activityItem) : null;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          prepared.put,
          {
            Put: {
              TableName: tableName,
              Item: snapshots.taskItem,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: snapshots.employeeItem,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          ...(pointer ? [pointerPut(tableName, pointer)] : []),
          ...(activityPut ? [activityPut] : []),
        ],
      })
    );
    return snapshots.taskItem;
  } catch (err) {
    if (isConditionalOrCanceled(err)) {
      const raced = await getAssignmentCost(ddb, tableName, task.taskId, email);
      if (raced) return raced;
    }
    throw snapshotError(err);
  }
}

function supersededError(assignment) {
  const err = new Error(SUPERSEDED_MESSAGE);
  err.statusCode = 409;
  err.code = ASSIGNMENT_SUPERSEDED;
  err.supersededByTaskId = assignment.supersededByTaskId;
  return err;
}

function assertNotSuperseded(assignment) {
  if (assignment?.supersededByTaskId) {
    throw supersededError(assignment);
  }
}

module.exports = {
  TYPE_ASSIGNMENT_COST,
  STATUS_COSTED,
  STATUS_MISSING_RATE,
  CURRENCY_USD,
  ASSIGNMENT_SUPERSEDED,
  SUPERSEDED_MESSAGE,
  roundUsd,
  calculateAmountUsd,
  reportingDateIst,
  costSk,
  employeeCostSk,
  classifyProjectType,
  COST_INDEX_PAIRED,
  COST_INDEX_ABSENT,
  COST_INDEX_MISSING_TASK,
  COST_INDEX_MISSING_EMPLOYEE,
  COST_INDEX_MISMATCH,
  diagnoseCostIndexes,
  getAssignmentCost,
  buildCostSnapshot,
  ensureAssignmentCost,
  persistCompletionWithCost,
  persistSubmissionWithCost,
  fulfillMissingCost,
  assertNotSuperseded,
};

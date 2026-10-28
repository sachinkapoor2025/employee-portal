const { randomUUID } = require("crypto");
const { GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
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
 * Reassignment costing (Phase 2):
 * Each follow-up is a new task with its own assignment date and snapshot.
 * The abandoned source REVIEW row is flagged supersededByTaskId and Admin
 * Complete is rejected with 409 ASSIGNMENT_SUPERSEDED so it cannot become a
 * second payable effort. Source history stays in REVIEW; only the follow-up
 * is costed unless a future workflow explicitly allows completing superseded
 * assignments.
 */
const TYPE_ASSIGNMENT_COST = "ASSIGNMENT_COST";
const STATUS_COSTED = "COSTED";
const STATUS_MISSING_RATE = "MISSING_RATE";
const STATUS_SUBMISSION_BASIS = "SUBMISSION_BASIS";
const BASIS_ACTIVE = "ACTIVE";
const BASIS_RETURNED = "RETURNED";
const BASIS_FINAL = "FINAL";
const CURRENCY_USD = "USD";
const ASSIGNMENT_SUPERSEDED = "ASSIGNMENT_SUPERSEDED";
const SUPERSEDED_MESSAGE =
  "This assignment was reassigned. Complete the follow-up task instead.";
const REVIEW_RECOVERY_MESSAGE =
  "This review has no submission costing basis. Return the task to In Progress so the employee can submit again. Reported hours stay on the assignment. Do not approve it in place and do not invent a rate.";
const SUBMISSION_HOURS_LOCKED_MESSAGE =
  "Return this task to In Progress before submitting different hours. The current review keeps the hours already stored.";

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

function costSk(email) {
  return `COST#${normalizeEmail(email)}`;
}

function employeeCostSk(taskId) {
  return `ASSIGNMENT_COST#${taskId}`;
}

function historyTaskSk(email, submissionId) {
  return `COSTHIST#${normalizeEmail(email)}#${submissionId}`;
}

function historyEmployeeSk(taskId, submissionId) {
  return `ASSIGNMENT_COST_HIST#${taskId}#${submissionId}`;
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
  const completedAt = assignment.completedAt || nowIso;
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
    actualHours,
    hourlyRateUsd,
    currency: CURRENCY_USD,
    rateSource: hasRate ? resolved.project.source : null,
    rateVersionId: hasRate ? resolved.rateVersionId || null : null,
    designationId: resolved?.designationId || assignment.designationId || null,
    amountUsd,
    completedAt,
    completedDate: reportingDateIst(completedAt),
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

function reviewResubmitDecision({ basis, actualHoursInput } = {}) {
  const active = isActiveBasis(basis);
  const final = isFinalBasis(basis);
  if (!active && !final) {
    return {
      ok: false,
      statusCode: 400,
      code: "SUBMISSION_BASIS_REQUIRED",
      error: REVIEW_RECOVERY_MESSAGE,
    };
  }
  if (
    actualHoursInput !== undefined &&
    actualHoursInput !== null &&
    String(actualHoursInput).trim() !== ""
  ) {
    const parsed = parseRequiredHours(actualHoursInput);
    if (!parsed.ok) {
      return {
        ok: false,
        statusCode: 400,
        code: "ACTUAL_HOURS_REQUIRED",
        error: parsed.error,
      };
    }
    if (Number(parsed.value) !== Number(basis.actualHours)) {
      return {
        ok: false,
        statusCode: 400,
        code: "SUBMISSION_HOURS_LOCKED",
        error: SUBMISSION_HOURS_LOCKED_MESSAGE,
      };
    }
  }
  return { ok: true, repair: true, actualHours: basis.actualHours };
}

function activeBasisCondition() {
  return {
    ConditionExpression: "#basis = :active",
    ExpressionAttributeNames: { "#basis": "basisState" },
    ExpressionAttributeValues: { ":active": BASIS_ACTIVE },
  };
}

function returnedBasisCondition() {
  return {
    ConditionExpression: "#basis = :returned",
    ExpressionAttributeNames: { "#basis": "basisState" },
    ExpressionAttributeValues: { ":returned": BASIS_RETURNED },
  };
}

function submissionCostCondition(existing) {
  if (existing?.basisState === BASIS_RETURNED) return returnedBasisCondition();
  return { ConditionExpression: "attribute_not_exists(PK)" };
}

function basisError(message, code, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function historyCopies(existing) {
  if (!existing?.submissionId) return [];
  const submissionId = existing.submissionId;
  const archived = {
    ...existing,
    archivedAt: existing.archivedAt || new Date().toISOString(),
    basisState: existing.basisState || BASIS_RETURNED,
  };
  return [
    {
      ...archived,
      PK: existing.PK,
      SK: historyTaskSk(existing.email, submissionId),
    },
    {
      ...archived,
      PK: `USER#${normalizeEmail(existing.email)}`,
      SK: historyEmployeeSk(existing.taskId, submissionId),
    },
  ];
}

function buildSubmissionBasis({
  task,
  assignment,
  project,
  resolved,
  actualHours,
  nowIso,
  submissionId,
}) {
  const email = normalizeEmail(assignment.email);
  const projectType = classifyProjectType(project);
  const applies = Boolean(resolved?.project?.applies);
  const rate = resolved?.project?.rate;
  const hasRate = applies && isValidPositiveRate(rate);
  const reason = hasRate
    ? resolved.project.reason ||
      (resolved.project.source === SOURCE_EMPLOYEE
        ? REASON.EMPLOYEE_OVERRIDE
        : REASON.DESIGNATION_FALLBACK)
    : !applies
      ? REASON.UNCLASSIFIED_PROJECT
      : resolved?.project?.reason || REASON.RATE_UNSET;
  const hourlyRateUsd = hasRate ? rate : null;
  const base = {
    type: TYPE_ASSIGNMENT_COST,
    status: hasRate ? STATUS_SUBMISSION_BASIS : STATUS_MISSING_RATE,
    basisState: BASIS_ACTIVE,
    reason,
    submissionId,
    submittedAt: nowIso,
    taskId: task.taskId,
    projectId: task.projectId || null,
    email,
    projectType,
    assignmentSk: assignmentSk(email),
    assignedAt: assignment.assignedAt || task.createdAt || null,
    actualHours,
    hourlyRateUsd,
    currency: CURRENCY_USD,
    rateSource: hasRate ? resolved.project.source : null,
    rateVersionId: hasRate ? resolved.rateVersionId || null : null,
    designationId: resolved?.designationId || assignment.designationId || null,
    amountUsd: hasRate ? calculateAmountUsd(actualHours, hourlyRateUsd) : null,
    completedAt: null,
    completedDate: null,
    approvedBy: null,
    finalizedAt: null,
    legacyBaseline: false,
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

function isActiveBasis(existing) {
  return existing?.basisState === BASIS_ACTIVE;
}

function isFinalBasis(existing) {
  return (
    existing?.basisState === BASIS_FINAL || existing?.status === STATUS_COSTED
  );
}

async function persistSubmissionBasis({
  ddb,
  tableName,
  assignmentItem,
  task,
  assignment,
  project,
  nowIso,
}) {
  assertNotSuperseded(assignment);
  const hours = parseRequiredHours(assignment?.actualHours);
  if (!hours.ok) {
    throw basisError(hours.error, "ACTUAL_HOURS_REQUIRED");
  }
  const email = normalizeEmail(assignment.email);
  const existing = await getAssignmentCost(ddb, tableName, task.taskId, email);
  if (isFinalBasis(existing)) {
    throw basisError(
      "This assignment already has a finalized cost.",
      "SUBMISSION_ALREADY_FINAL",
      409
    );
  }
  const lockedItem = {
    ...assignmentItem,
    actualHours: isActiveBasis(existing) ? existing.actualHours : hours.value,
    submittedAt: isActiveBasis(existing) ? existing.submittedAt : nowIso,
  };
  if (isActiveBasis(existing)) {
    const written = await putAssignmentSafe(ddb, tableName, lockedItem);
    assertPersistOk(written, {
      op: "writeAssignmentWithActiveBasis",
      taskId: task.taskId,
      email,
    });
    return existing;
  }
  const resolved = await resolveHourlyRatesAt({
    ddb,
    tableName,
    email,
    projectType: classifyProjectType(project),
    atIso: nowIso,
  });
  const snapshots = buildSubmissionBasis({
    task,
    assignment,
    project,
    resolved,
    actualHours: hours.value,
    nowIso,
    submissionId: randomUUID(),
  });
  lockedItem.submittedAt = nowIso;
  lockedItem.reviewNotifyPending = true;
  lockedItem.reviewNotifySubmissionId = snapshots.taskItem.submissionId;
  const prepared = await prepareProtectedAssignmentPut(
    ddb,
    tableName,
    lockedItem
  );
  if (!prepared.ok) throw snapshotError(new Error(prepared.reason || "ASSIGNMENT_PREPARE"));
  const costCondition = submissionCostCondition(existing);
  const pointer = userAssignmentPointerItem(lockedItem);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          prepared.put,
          {
            Put: {
              TableName: tableName,
              Item: snapshots.taskItem,
              ...costCondition,
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: snapshots.employeeItem,
              ...costCondition,
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
      if (isActiveBasis(raced) || isFinalBasis(raced)) {
        const written = await putAssignmentSafe(ddb, tableName, {
          ...lockedItem,
          actualHours: raced.actualHours,
          submittedAt: raced.submittedAt || lockedItem.submittedAt,
        });
        assertPersistOk(written, {
          op: "writeAssignmentAfterSubmissionRace",
          taskId: task.taskId,
          email,
        });
        return raced;
      }
    }
    throw snapshotError(err);
  }
}

async function retireSubmissionBasis({
  ddb,
  tableName,
  assignmentItem,
  task,
  assignment,
  nowIso,
}) {
  const email = normalizeEmail(assignment.email);
  const existing = await getAssignmentCost(ddb, tableName, task.taskId, email);
  const prepared = await prepareProtectedAssignmentPut(
    ddb,
    tableName,
    assignmentItem
  );
  if (!prepared.ok) throw snapshotError(new Error(prepared.reason || "ASSIGNMENT_PREPARE"));
  if (!existing || existing.basisState === BASIS_RETURNED) {
    const written = await putAssignmentSafe(ddb, tableName, assignmentItem);
    assertPersistOk(written, {
      op: "writeAssignmentWithoutActiveBasis",
      taskId: task.taskId,
      email,
    });
    return existing;
  }
  if (isFinalBasis(existing)) {
    throw basisError(
      "A finalized cost cannot be returned to in progress.",
      "COST_ALREADY_FINAL",
      409
    );
  }
  const returned = {
    ...existing,
    basisState: BASIS_RETURNED,
    returnedAt: nowIso,
  };
  const history = historyCopies({ ...existing, archivedAt: nowIso });
  const pointer = userAssignmentPointerItem(assignmentItem);
  const returnedPut = activeBasisCondition();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          prepared.put,
          {
            Put: {
              TableName: tableName,
              Item: { ...returned, PK: existing.PK, SK: existing.SK },
              ...returnedPut,
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                ...returned,
                PK: `USER#${email}`,
                SK: employeeCostSk(task.taskId),
              },
              ...returnedPut,
            },
          },
          ...history.map((item) => ({
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          })),
          ...(pointer ? [pointerPut(tableName, pointer)] : []),
        ],
      })
    );
    return { ...returned, PK: existing.PK, SK: existing.SK };
  } catch (err) {
    if (isConditionalOrCanceled(err)) {
      const raced = await getAssignmentCost(ddb, tableName, task.taskId, email);
      if (!raced || raced.basisState === BASIS_RETURNED) return raced;
    }
    throw snapshotError(err);
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
 * Finalize the employee's active submission basis in the same TransactWrite as
 * the completing ASSIGNMENT row. The captured rate and hours are not resolved
 * again. A retry after COSTED or FINAL is idempotent.
 */
async function persistCompletionWithCost({
  ddb,
  tableName,
  assignmentItem,
  task,
  assignment,
  approvedBy,
  nowIso,
}) {
  assertNotSuperseded(assignment);
  const email = normalizeEmail(assignment.email);
  const existing = await getAssignmentCost(ddb, tableName, task.taskId, email);
  if (!existing || existing.basisState === BASIS_RETURNED) {
    throw basisError(REVIEW_RECOVERY_MESSAGE, "SUBMISSION_BASIS_REQUIRED");
  }
  const hours = parseRequiredHours(existing.actualHours);
  if (!hours.ok) {
    throw basisError(hours.error, "ACTUAL_HOURS_REQUIRED");
  }
  const lockedAssignment = {
    ...assignmentItem,
    actualHours: hours.value,
    submittedAt: existing.submittedAt || assignmentItem.submittedAt || null,
  };
  if (isFinalBasis(existing)) {
    const written = await putAssignmentSafe(ddb, tableName, lockedAssignment);
    assertPersistOk(written, {
      op: "writeAssignmentWithExistingCost",
      taskId: task.taskId,
      email,
    });
    return existing;
  }
  if (!isActiveBasis(existing)) {
    throw basisError(REVIEW_RECOVERY_MESSAGE, "SUBMISSION_BASIS_REQUIRED");
  }
  const hasRate = isValidPositiveRate(existing.hourlyRateUsd);
  const finalized = {
    ...existing,
    status: hasRate ? STATUS_COSTED : STATUS_MISSING_RATE,
    basisState: BASIS_FINAL,
    actualHours: hours.value,
    hourlyRateUsd: hasRate ? existing.hourlyRateUsd : null,
    amountUsd: hasRate
      ? existing.amountUsd != null
        ? existing.amountUsd
        : calculateAmountUsd(hours.value, existing.hourlyRateUsd)
      : null,
    rateSource: hasRate ? existing.rateSource : null,
    rateVersionId: hasRate ? existing.rateVersionId || null : null,
    completedAt: assignment.completedAt || nowIso,
    completedDate: reportingDateIst(assignment.completedAt || nowIso),
    approvedBy: normalizeEmail(approvedBy) || "",
    finalizedAt: nowIso,
    finalizedSubmissionId: existing.submissionId,
  };
  const prepared = await prepareProtectedAssignmentPut(
    ddb,
    tableName,
    lockedAssignment
  );
  if (!prepared.ok) {
    throw snapshotError(new Error(prepared.reason || "ASSIGNMENT_PREPARE"));
  }
  const finalCondition = activeBasisCondition();
  const pointer = userAssignmentPointerItem(lockedAssignment);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          prepared.put,
          {
            Put: {
              TableName: tableName,
              Item: { ...finalized, PK: existing.PK, SK: existing.SK },
              ...finalCondition,
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                ...finalized,
                PK: `USER#${email}`,
                SK: employeeCostSk(task.taskId),
              },
              ...finalCondition,
            },
          },
          ...(pointer ? [pointerPut(tableName, pointer)] : []),
        ],
      })
    );
    return { ...finalized, PK: existing.PK, SK: existing.SK };
  } catch (err) {
    if (isConditionalOrCanceled(err)) {
      const raced = await getAssignmentCost(ddb, tableName, task.taskId, email);
      if (isFinalBasis(raced)) {
        const written = await putAssignmentSafe(ddb, tableName, {
          ...lockedAssignment,
          actualHours: raced.actualHours,
        });
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
  STATUS_SUBMISSION_BASIS,
  BASIS_ACTIVE,
  BASIS_RETURNED,
  BASIS_FINAL,
  CURRENCY_USD,
  ASSIGNMENT_SUPERSEDED,
  SUPERSEDED_MESSAGE,
  REVIEW_RECOVERY_MESSAGE,
  SUBMISSION_HOURS_LOCKED_MESSAGE,
  reviewResubmitDecision,
  roundUsd,
  calculateAmountUsd,
  reportingDateIst,
  costSk,
  employeeCostSk,
  historyTaskSk,
  historyEmployeeSk,
  classifyProjectType,
  getAssignmentCost,
  buildCostSnapshot,
  buildSubmissionBasis,
  ensureAssignmentCost,
  persistSubmissionBasis,
  retireSubmissionBasis,
  persistCompletionWithCost,
  activeBasisCondition,
  returnedBasisCondition,
  submissionCostCondition,
  fulfillMissingCost,
  assertNotSuperseded,
};

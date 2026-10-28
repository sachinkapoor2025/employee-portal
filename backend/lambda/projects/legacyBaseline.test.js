const assert = require("assert");
const { GetCommand, PutCommand, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { MemoryDynamoDB } = require("../../scripts/memory-ddb");
const {
  previewLegacyPage,
  applyLegacyBaseline,
  decodeCursor,
  legacyPutCondition,
  LEGACY_REASON,
  LEGACY_NOTE,
} = require("./legacyBaseline");

const TABLE = "WorkTasks";
const NOW = "2026-10-30T04:00:00.000Z";

async function put(ddb, item) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
}

function task(taskId, projectId) {
  return {
    PK: "ENTITY#TASK",
    SK: `TASK#${taskId}`,
    type: "TASK",
    taskId,
    projectId,
    title: taskId,
  };
}

function assignment(taskId, email, extra = {}) {
  return {
    PK: `TASK#${taskId}`,
    SK: `ASSIGNMENT#${email}`,
    type: "ASSIGNMENT",
    taskId,
    email,
    status: "DONE",
    actualHours: 6,
    assignedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-02T00:00:00.000Z",
    removed: false,
    ...extra,
  };
}

async function seedBase(ddb) {
  await put(ddb, {
    PK: "ENTITY#PROJECT",
    SK: "PROJECT#internal",
    projectId: "internal",
    name: "Internal",
    projectType: "INTERNAL",
    type: "PROJECT",
  });
  await put(ddb, {
    PK: "ENTITY#PROJECT",
    SK: "PROJECT#plain",
    projectId: "plain",
    name: "Plain",
    type: "PROJECT",
  });
  await put(ddb, {
    PK: "USER#ada@mydgv.com",
    SK: "COST_RATES",
    type: "EMPLOYEE_COST_RATES",
    email: "ada@mydgv.com",
    status: "ACTIVE",
    internalHourlyRate: 1,
    externalHourlyRate: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  await put(ddb, task("eligible", "internal"));
  await put(ddb, assignment("eligible", "ada@mydgv.com"));
  await put(ddb, task("missing-rate", "internal"));
  await put(ddb, assignment("missing-rate", "ada@mydgv.com", { actualHours: 2 }));
  const missing = {
    type: "ASSIGNMENT_COST",
    status: "MISSING_RATE",
    reason: "RATE_UNSET",
    taskId: "missing-rate",
    email: "ada@mydgv.com",
    actualHours: 2,
    amountUsd: null,
    hourlyRateUsd: null,
    assignedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-02T00:00:00.000Z",
  };
  await put(ddb, { ...missing, PK: "TASK#missing-rate", SK: "COST#ada@mydgv.com" });
  await put(ddb, {
    ...missing,
    PK: "USER#ada@mydgv.com",
    SK: "ASSIGNMENT_COST#missing-rate",
  });
  await put(ddb, task("final-missing", "internal"));
  await put(ddb, assignment("final-missing", "ada@mydgv.com", { actualHours: 3 }));
  const frozenMissing = {
    ...missing,
    taskId: "final-missing",
    actualHours: 3,
    basisState: "FINAL",
    submissionId: "submit-final",
    finalizedSubmissionId: "submit-final",
    status: "MISSING_RATE",
  };
  await put(ddb, { ...frozenMissing, PK: "TASK#final-missing", SK: "COST#ada@mydgv.com" });
  await put(ddb, {
    ...frozenMissing,
    PK: "USER#ada@mydgv.com",
    SK: "ASSIGNMENT_COST#final-missing",
  });
  await put(ddb, task("frozen", "internal"));
  await put(ddb, assignment("frozen", "ada@mydgv.com", { actualHours: 5 }));
  const frozen = {
    type: "ASSIGNMENT_COST",
    status: "COSTED",
    basisState: "FINAL",
    taskId: "frozen",
    email: "ada@mydgv.com",
    actualHours: 5,
    hourlyRateUsd: 4,
    amountUsd: 20,
    legacyBaseline: false,
  };
  await put(ddb, { ...frozen, PK: "TASK#frozen", SK: "COST#ada@mydgv.com" });
  await put(ddb, { ...frozen, PK: "USER#ada@mydgv.com", SK: "ASSIGNMENT_COST#frozen" });
  await put(ddb, task("one-sided", "internal"));
  await put(ddb, assignment("one-sided", "ada@mydgv.com", { actualHours: 1 }));
  await put(ddb, {
    ...missing,
    taskId: "one-sided",
    actualHours: 1,
    PK: "TASK#one-sided",
    SK: "COST#ada@mydgv.com",
  });
  await put(ddb, task("removed", "internal"));
  await put(ddb, assignment("removed", "ada@mydgv.com", { removed: true }));
  await put(ddb, task("no-hours", "internal"));
  await put(ddb, assignment("no-hours", "ada@mydgv.com", { actualHours: null }));
  await put(ddb, task("plain", "plain"));
  await put(ddb, assignment("plain", "ada@mydgv.com", { actualHours: 1 }));
  await put(ddb, task("inactive-designation", "internal"));
  await put(ddb, assignment("inactive-designation", "no-rate@mydgv.com", { actualHours: 1 }));
  await put(ddb, {
    PK: "USER#no-rate@mydgv.com",
    SK: "COST_RATES",
    type: "EMPLOYEE_COST_RATES",
    email: "no-rate@mydgv.com",
    status: "ACTIVE",
    designationId: "des-old",
    internalHourlyRate: null,
    externalHourlyRate: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  await put(ddb, {
    PK: "ENTITY#DESIGNATION",
    SK: "DESIGNATION#des-old",
    designationId: "des-old",
    status: "INACTIVE",
    internalHourlyRate: 9,
    externalHourlyRate: 9,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
}

(async () => {
  const emptyCondition = legacyPutCondition(null);
  const missingCondition = legacyPutCondition({ status: "MISSING_RATE" });
  assert.strictEqual(emptyCondition.ConditionExpression, "attribute_not_exists(PK)");
  assert.match(missingCondition.ConditionExpression, /attribute_not_exists\(#basis\)/);
  assert.match(missingCondition.ConditionExpression, /attribute_not_exists\(#submissionId\)/);
  assert.match(missingCondition.ConditionExpression, /#status = :missing/);
  // The expression is what real DynamoDB would evaluate. This file's memory
  // double treats unrecognized AND conditions as success, so the assertions
  // below do not prove that DynamoDB enforced the condition.

  const ddb = new MemoryDynamoDB();
  await seedBase(ddb);
  const preview = await previewLegacyPage({
    ddb,
    tableName: TABLE,
    nowIso: NOW,
    limit: 25,
  });
  assert.strictEqual(preview.countsScope, "page");
  assert.strictEqual(preview.label, LEGACY_NOTE);
  const eligibleIds = preview.eligible.map((row) => row.taskId).sort();
  assert.deepStrictEqual(eligibleIds, ["eligible", "missing-rate"]);
  assert.ok(preview.skipped.some((row) => row.taskId === "frozen" && row.reason === "COSTED_FROZEN"));
  assert.ok(preview.skipped.some((row) => row.taskId === "final-missing" && row.reason === "FINALIZED_SUBMISSION"));
  assert.ok(preview.skipped.some((row) => row.taskId === "removed" && row.reason === "REMOVED_ASSIGNMENT"));
  assert.ok(preview.unresolved.some((row) => row.taskId === "one-sided" && row.reason === "INCONSISTENT_COST_RECORDS"));
  assert.ok(preview.unresolved.some((row) => row.taskId === "no-hours" && row.reason === "MISSING_HOURS"));
  assert.ok(preview.unresolved.some((row) => row.taskId === "plain" && row.reason === "UNCLASSIFIED_PROJECT"));
  assert.ok(
    preview.unresolved.some(
      (row) => row.taskId === "inactive-designation" && row.reason === "DESIGNATION_INACTIVE"
    )
  );

  const stale = await applyLegacyBaseline({
    ddb,
    tableName: TABLE,
    nowIso: NOW,
    candidates: preview.eligible.map((row) => ({ ...row, hourlyRateUsd: 99, amountUsd: 99 })),
    previewDigest: preview.previewDigest,
  });
  assert.strictEqual(stale.blocked, true);
  assert.strictEqual(stale.code, "REPREVIEW_REQUIRED");
  assert.strictEqual(stale.applied.length, 0);
  const absent = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: "TASK#eligible", SK: "COST#ada@mydgv.com" },
    })
  );
  assert.strictEqual(absent.Item, undefined);

  const applied = await applyLegacyBaseline({
    ddb,
    tableName: TABLE,
    nowIso: NOW,
    candidates: preview.eligible,
    previewDigest: preview.previewDigest,
  });
  assert.strictEqual(applied.blocked, false);
  assert.strictEqual(applied.counts.applied, 2);
  const eligibleCost = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: "TASK#eligible", SK: "COST#ada@mydgv.com" },
    })
  );
  assert.strictEqual(eligibleCost.Item.status, "COSTED");
  assert.strictEqual(eligibleCost.Item.legacyBaseline, true);
  assert.strictEqual(eligibleCost.Item.reason, LEGACY_REASON);
  assert.strictEqual(eligibleCost.Item.amountUsd, 6);
  const employeeCopy = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: "USER#ada@mydgv.com", SK: "ASSIGNMENT_COST#eligible" },
    })
  );
  assert.strictEqual(employeeCopy.Item.amountUsd, 6);
  const finalMissing = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: "TASK#final-missing", SK: "COST#ada@mydgv.com" },
    })
  );
  assert.strictEqual(finalMissing.Item.status, "MISSING_RATE");
  assert.strictEqual(finalMissing.Item.basisState, "FINAL");
  assert.strictEqual(finalMissing.Item.amountUsd, null);
  const frozenAfter = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: "TASK#frozen", SK: "COST#ada@mydgv.com" },
    })
  );
  assert.strictEqual(frozenAfter.Item.amountUsd, 20);
  assert.strictEqual(frozenAfter.Item.legacyBaseline, false);

  await put(ddb, {
    PK: "USER#ada@mydgv.com",
    SK: "COST_RATES",
    type: "EMPLOYEE_COST_RATES",
    email: "ada@mydgv.com",
    status: "ACTIVE",
    internalHourlyRate: 2,
    externalHourlyRate: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  const changed = await applyLegacyBaseline({
    ddb,
    tableName: TABLE,
    nowIso: NOW,
    candidates: preview.eligible,
    previewDigest: preview.previewDigest,
  });
  assert.strictEqual(changed.blocked, true);
  assert.strictEqual(changed.code, "REPREVIEW_REQUIRED");
  const eligibleAfterChange = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: "TASK#eligible", SK: "COST#ada@mydgv.com" },
    })
  );
  assert.strictEqual(eligibleAfterChange.Item.hourlyRateUsd, 1);
  assert.strictEqual(eligibleAfterChange.Item.amountUsd, 6);

  const items = [
    { PK: "FILLER#1", SK: "A", type: "NOTE" },
    assignment("p1", "ada@mydgv.com"),
    task("p1", "internal"),
    assignment("p2", "ada@mydgv.com", { actualHours: 4 }),
    task("p2", "internal"),
    {
      PK: "ENTITY#PROJECT",
      SK: "PROJECT#internal",
      projectId: "internal",
      projectType: "INTERNAL",
    },
    {
      PK: "USER#ada@mydgv.com",
      SK: "COST_RATES",
      email: "ada@mydgv.com",
      status: "ACTIVE",
      internalHourlyRate: 1,
    },
  ];
  const paging = {
    async send(command) {
      if (command instanceof ScanCommand) {
        const limit = command.input.Limit || items.length;
        const startKey = command.input.ExclusiveStartKey;
        const start = startKey
          ? items.findIndex((item) => item.PK === startKey.PK && item.SK === startKey.SK) + 1
          : 0;
        const slice = items.slice(start, start + limit);
        const last = slice[slice.length - 1];
        const more = start + slice.length < items.length;
        return {
          Items: slice,
          LastEvaluatedKey: more && last ? { PK: last.PK, SK: last.SK } : undefined,
        };
      }
      if (command instanceof QueryCommand) return { Items: [] };
      if (command instanceof GetCommand) {
        return {
          Item: items.find(
            (item) => item.PK === command.input.Key.PK && item.SK === command.input.Key.SK
          ),
        };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
  const firstPage = await previewLegacyPage({
    ddb: paging,
    tableName: TABLE,
    nowIso: NOW,
    limit: 1,
  });
  assert.strictEqual(
    firstPage.eligible.length + firstPage.skipped.length + firstPage.unresolved.length,
    1
  );
  assert.strictEqual(firstPage.countsScope, "page");
  assert.ok(firstPage.nextCursor);
  const cursor = JSON.parse(Buffer.from(firstPage.nextCursor, "base64url").toString("utf8"));
  assert.ok(cursor.afterKey && cursor.afterKey.PK && cursor.afterKey.SK);
  assert.strictEqual(decodeCursor(firstPage.nextCursor).ok, true);
  assert.strictEqual(decodeCursor(Buffer.from(JSON.stringify({ offset: 1, startKey: cursor.afterKey })).toString("base64url")).ok, false);
  const secondPage = await previewLegacyPage({
    ddb: paging,
    tableName: TABLE,
    nowIso: NOW,
    limit: 1,
    cursor,
  });
  assert.strictEqual(
    secondPage.eligible.length + secondPage.skipped.length + secondPage.unresolved.length,
    1
  );
  assert.notStrictEqual(firstPage.eligible[0].taskId, secondPage.eligible[0].taskId);
  const repeated = await previewLegacyPage({
    ddb: paging,
    tableName: TABLE,
    nowIso: NOW,
    limit: 1,
    cursor,
  });
  assert.strictEqual(repeated.eligible[0].taskId, secondPage.eligible[0].taskId);

  const mutable = [
    assignment("a-task", "ada@mydgv.com"),
    assignment("b-task", "ada@mydgv.com"),
    assignment("c-task", "ada@mydgv.com"),
  ];
  const ordered = {
    async send(command) {
      if (command instanceof ScanCommand) {
        const sorted = [...mutable].sort((left, right) =>
          left.PK === right.PK ? left.SK.localeCompare(right.SK) : left.PK.localeCompare(right.PK)
        );
        const startKey = command.input.ExclusiveStartKey;
        const start = startKey
          ? (() => {
              const exact = sorted.findIndex(
                (item) => item.PK === startKey.PK && item.SK === startKey.SK
              );
              if (exact >= 0) return exact + 1;
              const next = sorted.findIndex(
                (item) =>
                  item.PK > startKey.PK ||
                  (item.PK === startKey.PK && item.SK > startKey.SK)
              );
              return next === -1 ? sorted.length : next;
            })()
          : 0;
        const limit = command.input.Limit || sorted.length;
        const slice = sorted.slice(start, start + limit);
        const last = slice[slice.length - 1];
        const more = start + slice.length < sorted.length;
        return {
          Items: slice,
          LastEvaluatedKey: more && last ? { PK: last.PK, SK: last.SK } : undefined,
        };
      }
      if (command instanceof GetCommand) {
        const found = mutable.find(
          (item) => item.PK === command.input.Key.PK && item.SK === command.input.Key.SK
        );
        return { Item: found };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
  const seen = [];
  let pageCursor = { afterKey: null };
  let guard = 0;
  while (guard < 10) {
    guard += 1;
    const page = await previewLegacyPage({
      ddb: ordered,
      tableName: TABLE,
      nowIso: NOW,
      limit: 1,
      cursor: pageCursor,
    });
    assert.strictEqual(page.countsScope, "page");
    assert.ok(page.unresolved);
    const ids = [...page.eligible, ...page.skipped, ...page.unresolved].map((row) => row.taskId);
    assert.strictEqual(ids.length, 1);
    seen.push(ids[0]);
    if (!page.nextCursor) break;
    pageCursor = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8"));
  }
  assert.deepStrictEqual(seen, ["a-task", "b-task", "c-task"]);

  const firstBoundary = await previewLegacyPage({
    ddb: ordered,
    tableName: TABLE,
    nowIso: NOW,
    limit: 1,
  });
  mutable.push(assignment("0-task", "ada@mydgv.com"));
  mutable.splice(mutable.findIndex((item) => item.taskId === "b-task"), 1);
  const afterChange = await previewLegacyPage({
    ddb: ordered,
    tableName: TABLE,
    nowIso: NOW,
    limit: 2,
    cursor: JSON.parse(Buffer.from(firstBoundary.nextCursor, "base64url").toString("utf8")),
  });
  const changedIds = [...afterChange.eligible, ...afterChange.skipped, ...afterChange.unresolved]
    .map((row) => row.taskId);
  assert.ok(!changedIds.includes("a-task"));
  assert.ok(!changedIds.includes("0-task"));
  assert.ok(!changedIds.includes("b-task"));
  assert.ok(changedIds.includes("c-task"));

  let rounds = 0;
  const spinning = {
    async send(command) {
      if (!(command instanceof ScanCommand)) throw new Error("unexpected");
      rounds += 1;
      return {
        Items: [{ PK: "ENTITY#NOISE", SK: `ROW#${rounds}`, type: "OTHER" }],
        LastEvaluatedKey: { PK: "ENTITY#NOISE", SK: `ROW#${rounds}` },
      };
    },
  };
  const bounded = await previewLegacyPage({
    ddb: spinning,
    tableName: TABLE,
    nowIso: NOW,
    limit: 5,
  });
  assert.ok(rounds <= 20);
  assert.strictEqual(bounded.truncated, true);
  assert.strictEqual(bounded.counts.eligible, 0);
  assert.strictEqual(bounded.counts.unresolved, 0);

  console.log("legacyBaseline tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  inspectCanonicalAssignment,
  classifyExistingPointer,
  planUserAssignmentPointerBackfill,
  runUserAssignmentPointerBackfill,
  summarizeBackfill,
} = require("./userAssignmentPointers");
const { parseArgs } = require("../../scripts/backfill-user-assignment-pointers");

function keyOf(table, pk, sk) {
  return `${table}\0${pk}\0${sk}`;
}

function memoryDdb(seed = {}) {
  const items = { ...seed };
  let writes = 0;
  return {
    items,
    get writes() {
      return writes;
    },
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
        const expr = String(command.input.ConditionExpression || "");
        if (expr.includes("attribute_not_exists(PK)") && items[k]) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        writes += 1;
        items[k] = { ...item };
        return {};
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

const TABLE = "WorkTasks";

{
  const parsed = parseArgs(["--dry-run", "--table", "WorkTasks"]);
  assert.strictEqual(parsed.write, false);
  assert.strictEqual(parsed.tableName, "WorkTasks");
  const writeBlocked = parseArgs(["--write", "--table", "WorkTasks"]);
  assert.strictEqual(writeBlocked.write, false);
  const writeOk = parseArgs([
    "--write",
    "--i-understand-write",
    "--table",
    "WorkTasks",
  ]);
  assert.strictEqual(writeOk.write, true);
}

{
  const bad = inspectCanonicalAssignment({
    PK: "TASK#t1",
    SK: "ASSIGNMENT#a@mydgv.com",
    email: "b@mydgv.com",
    taskId: "t1",
    type: "ASSIGNMENT",
  });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, "MALFORMED");
  const removed = inspectCanonicalAssignment({
    PK: "TASK#t1",
    SK: "ASSIGNMENT#a@mydgv.com",
    email: "a@mydgv.com",
    taskId: "t1",
    type: "ASSIGNMENT",
    removed: true,
  });
  assert.strictEqual(removed.code, "SKIPPED_REMOVED");
}

{
  const pointer = {
    PK: "USER#a@mydgv.com",
    SK: "ASSIGNMENT#t1",
    type: "USER_ASSIGNMENT",
    taskId: "t1",
    email: "a@mydgv.com",
  };
  assert.strictEqual(classifyExistingPointer(null, pointer), "MISSING");
  assert.strictEqual(classifyExistingPointer(pointer, pointer), "EXISTING");
  assert.strictEqual(
    classifyExistingPointer({ ...pointer, type: "OTHER" }, pointer),
    "CONFLICT"
  );
}

(async () => {
  const items = {
    [keyOf(TABLE, "ENTITY#TASK", "TASK#t-miss")]: {
      PK: "ENTITY#TASK",
      SK: "TASK#t-miss",
      taskId: "t-miss",
    },
    [keyOf(TABLE, "TASK#t-miss", "ASSIGNMENT#a@mydgv.com")]: {
      PK: "TASK#t-miss",
      SK: "ASSIGNMENT#a@mydgv.com",
      type: "ASSIGNMENT",
      taskId: "t-miss",
      email: "a@mydgv.com",
      status: "REVIEW",
    },
    [keyOf(TABLE, "ENTITY#TASK", "TASK#t-have")]: {
      PK: "ENTITY#TASK",
      SK: "TASK#t-have",
      taskId: "t-have",
    },
    [keyOf(TABLE, "TASK#t-have", "ASSIGNMENT#a@mydgv.com")]: {
      PK: "TASK#t-have",
      SK: "ASSIGNMENT#a@mydgv.com",
      type: "ASSIGNMENT",
      taskId: "t-have",
      email: "a@mydgv.com",
    },
    [keyOf(TABLE, "USER#a@mydgv.com", "ASSIGNMENT#t-have")]: {
      PK: "USER#a@mydgv.com",
      SK: "ASSIGNMENT#t-have",
      type: "USER_ASSIGNMENT",
      taskId: "t-have",
      email: "a@mydgv.com",
    },
    [keyOf(TABLE, "ENTITY#TASK", "TASK#t-bad")]: {
      PK: "ENTITY#TASK",
      SK: "TASK#t-bad",
      taskId: "t-bad",
    },
    [keyOf(TABLE, "TASK#t-bad", "ASSIGNMENT#a@mydgv.com")]: {
      PK: "TASK#t-bad",
      SK: "ASSIGNMENT#a@mydgv.com",
      type: "ASSIGNMENT",
      taskId: "t-other",
      email: "a@mydgv.com",
    },
    [keyOf(TABLE, "ENTITY#TASK", "TASK#t-conflict")]: {
      PK: "ENTITY#TASK",
      SK: "TASK#t-conflict",
      taskId: "t-conflict",
    },
    [keyOf(TABLE, "TASK#t-conflict", "ASSIGNMENT#a@mydgv.com")]: {
      PK: "TASK#t-conflict",
      SK: "ASSIGNMENT#a@mydgv.com",
      type: "ASSIGNMENT",
      taskId: "t-conflict",
      email: "a@mydgv.com",
    },
    [keyOf(TABLE, "USER#a@mydgv.com", "ASSIGNMENT#t-conflict")]: {
      PK: "USER#a@mydgv.com",
      SK: "ASSIGNMENT#t-conflict",
      type: "OTHER",
      taskId: "nope",
      email: "nope@mydgv.com",
    },
  };

  const dryDdb = memoryDdb(items);
  const planned = await planUserAssignmentPointerBackfill({
    ddb: dryDdb,
    tableName: TABLE,
  });
  assert.strictEqual(dryDdb.writes, 0);
  assert.strictEqual(planned.candidates.length, 1);
  assert.strictEqual(planned.candidates[0].taskId, "t-miss");
  assert.strictEqual(planned.existing.length, 1);
  assert.strictEqual(planned.malformed.length, 1);
  assert.strictEqual(planned.conflicts.length, 1);

  const dryRun = await runUserAssignmentPointerBackfill({
    ddb: dryDdb,
    tableName: TABLE,
    write: false,
  });
  assert.strictEqual(dryRun.mode, "dry-run");
  assert.strictEqual(dryDdb.writes, 0);
  assert.ok(!dryDdb.items[keyOf(TABLE, "USER#a@mydgv.com", "ASSIGNMENT#t-miss")]);

  const writeDdb = memoryDdb(items);
  const written = await runUserAssignmentPointerBackfill({
    ddb: writeDdb,
    tableName: TABLE,
    write: true,
  });
  assert.strictEqual(written.mode, "write");
  assert.strictEqual(written.written.length, 1);
  assert.strictEqual(
    writeDdb.items[keyOf(TABLE, "USER#a@mydgv.com", "ASSIGNMENT#t-miss")].type,
    "USER_ASSIGNMENT"
  );
  assert.strictEqual(
    writeDdb.items[keyOf(TABLE, "USER#a@mydgv.com", "ASSIGNMENT#t-conflict")].type,
    "OTHER"
  );
  assert.strictEqual(
    writeDdb.items[keyOf(TABLE, "TASK#t-miss", "ASSIGNMENT#a@mydgv.com")].status,
    "REVIEW"
  );
  const summary = summarizeBackfill(written);
  assert.strictEqual(summary.writtenCount, 1);
  assert.strictEqual(summary.conflictCount, 1);

  console.log("userAssignmentPointers tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

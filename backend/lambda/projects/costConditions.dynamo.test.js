/**
 * Real conditional writes against DynamoDB Local only.
 * Refuses any endpoint that is not loopback and any table whose name
 * contains the production work table. The in-memory mock is not used.
 */
const assert = require("assert");
const {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const {
  activeBasisCondition,
  submissionCostCondition,
} = require("./taskCosting");
const { legacyPutCondition } = require("./legacyBaseline");

const TABLE = "cost-step1-isolated-conditions";
const ENDPOINT = process.env.COST_CONDITION_DDB_ENDPOINT || "http://127.0.0.1:8000";

function assertIsolatedTarget() {
  const url = new URL(ENDPOINT);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`Refusing non-loopback DynamoDB endpoint ${ENDPOINT}`);
  }
  const banned = ["mydgv-portal-WorkTasks", "WorkTasks"];
  if (banned.some((name) => TABLE === name || TABLE.includes("mydgv-portal"))) {
    throw new Error(`Refusing table ${TABLE}`);
  }
}

function clients() {
  const raw = new DynamoDBClient({
    region: "ap-south-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  return {
    raw,
    doc: DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    }),
  };
}

async function waitUntilActive(raw) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const described = await raw.send(new DescribeTableCommand({ TableName: TABLE }));
    if (described.Table && described.Table.TableStatus === "ACTIVE") return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Isolated table did not become ACTIVE");
}

async function recreate(raw) {
  try {
    await raw.send(new DeleteTableCommand({ TableName: TABLE }));
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
  }
  await raw.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    })
  );
  await waitUntilActive(raw);
}

async function getItem(ddb, key) {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: key }));
  return res.Item || null;
}

async function expectCancel(ddb, items) {
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (err) {
    assert.strictEqual(err.name, "TransactionCanceledException");
    return;
  }
  throw new Error("Transaction was expected to cancel");
}

function put(key, item, condition) {
  return {
    Put: {
      TableName: TABLE,
      Item: { ...key, ...item },
      ...condition,
    },
  };
}

(async () => {
  assertIsolatedTarget();
  const { raw, doc: ddb } = clients();
  try {
    await recreate(raw);
  } catch (err) {
    console.error(`UNVERIFIED: DynamoDB Local is not usable at ${ENDPOINT}`);
    console.error(err && err.message ? err.message : err);
    process.exit(2);
  }
  try {
    const taskKey = { PK: "TASK#isolated", SK: "COST#ada@example.com" };
    const employeeKey = { PK: "USER#ada@example.com", SK: "ASSIGNMENT_COST#isolated" };
    const frozen = {
      status: "MISSING_RATE",
      basisState: "FINAL",
      submissionId: "sub-frozen",
      amountUsd: null,
    };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          put(taskKey, frozen, { ConditionExpression: "attribute_not_exists(PK)" }),
          put(employeeKey, frozen, { ConditionExpression: "attribute_not_exists(PK)" }),
        ],
      })
    );
    await expectCancel(ddb, [
      put(taskKey, { status: "COSTED", amountUsd: 99 }, legacyPutCondition(frozen)),
      put(employeeKey, { status: "COSTED", amountUsd: 99 }, legacyPutCondition(frozen)),
    ]);
    assert.strictEqual((await getItem(ddb, taskKey)).basisState, "FINAL");
    assert.strictEqual((await getItem(ddb, employeeKey)).submissionId, "sub-frozen");

    const plainTask = { PK: "TASK#plain", SK: "COST#ada@example.com" };
    const plainEmployee = { PK: "USER#ada@example.com", SK: "ASSIGNMENT_COST#plain" };
    const plain = { status: "MISSING_RATE", actualHours: 2 };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          put(plainTask, plain, submissionCostCondition(null)),
          put(plainEmployee, plain, submissionCostCondition(null)),
        ],
      })
    );
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          put(plainTask, { status: "COSTED", legacyBaseline: true, amountUsd: 2 }, legacyPutCondition(plain)),
          put(plainEmployee, { status: "COSTED", legacyBaseline: true, amountUsd: 2 }, legacyPutCondition(plain)),
        ],
      })
    );
    assert.strictEqual((await getItem(ddb, plainTask)).amountUsd, 2);
    assert.strictEqual((await getItem(ddb, plainEmployee)).amountUsd, 2);
    await expectCancel(ddb, [
      put(plainTask, { status: "COSTED", amountUsd: 50 }, submissionCostCondition(null)),
      put(plainEmployee, { status: "COSTED", amountUsd: 50 }, submissionCostCondition(null)),
    ]);
    assert.strictEqual((await getItem(ddb, plainTask)).amountUsd, 2);
    assert.strictEqual((await getItem(ddb, plainEmployee)).amountUsd, 2);

    const rollTask = { PK: "TASK#rollback", SK: "COST#ada@example.com" };
    const rollEmployee = { PK: "USER#ada@example.com", SK: "ASSIGNMENT_COST#rollback" };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          put(rollEmployee, frozen, { ConditionExpression: "attribute_not_exists(PK)" }),
        ],
      })
    );
    await expectCancel(ddb, [
      put(rollTask, { status: "COSTED", amountUsd: 6 }, submissionCostCondition(null)),
      put(rollEmployee, { status: "COSTED", amountUsd: 6 }, legacyPutCondition(frozen)),
    ]);
    assert.strictEqual(await getItem(ddb, rollTask), null);
    assert.strictEqual((await getItem(ddb, rollEmployee)).basisState, "FINAL");

    const activeTask = { PK: "TASK#active", SK: "COST#ada@example.com" };
    const activeEmployee = { PK: "USER#ada@example.com", SK: "ASSIGNMENT_COST#active" };
    const active = { status: "SUBMISSION_BASIS", basisState: "ACTIVE", submittedAt: "2026-10-28T04:00:00.000Z" };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          put(activeTask, active, submissionCostCondition(null)),
          put(activeEmployee, { ...active, basisState: "RETURNED" }, submissionCostCondition(null)),
        ],
      })
    );
    await expectCancel(ddb, [
      put(activeTask, { ...active, basisState: "FINAL" }, activeBasisCondition()),
      put(activeEmployee, { ...active, basisState: "FINAL" }, activeBasisCondition()),
    ]);
    assert.strictEqual((await getItem(ddb, activeTask)).basisState, "ACTIVE");
    assert.strictEqual((await getItem(ddb, activeTask)).submittedAt, "2026-10-28T04:00:00.000Z");
    assert.strictEqual((await getItem(ddb, activeEmployee)).basisState, "RETURNED");

    console.log("isolated DynamoDB condition tests passed");
  } finally {
    await raw.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => {});
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

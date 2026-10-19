const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  OWNER_DESIGNATION,
  OWNER_EMPLOYEE,
  pickEffectiveVersion,
  ratesDiffer,
  versionPutsForMutation,
  listRateVersions,
} = require("./costRateVersions");

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
      if (command instanceof PutCommand) {
        const item = command.input.Item;
        items[keyOf(command.input.TableName, item.PK, item.SK)] = { ...item };
        return {};
      }
      if (command instanceof QueryCommand) {
        const table = command.input.TableName;
        const pk = command.input.ExpressionAttributeValues[":pk"];
        const skPrefix = command.input.ExpressionAttributeValues[":sk"];
        const found = Object.entries(items)
          .filter(([k]) => k.startsWith(`${table}\0`))
          .map(([, item]) => item)
          .filter((item) => item.PK === pk && String(item.SK).startsWith(skPrefix));
        return { Items: found.map((item) => ({ ...item })) };
      }
      if (command instanceof TransactWriteCommand) {
        for (const op of command.input.TransactItems || []) {
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
}

const TABLE = "WorkTasks";

assert.strictEqual(
  ratesDiffer(
    { internalHourlyRate: 2, externalHourlyRate: 3, status: "ACTIVE" },
    { internalHourlyRate: 2, externalHourlyRate: 3, status: "ACTIVE" }
  ),
  false
);
assert.strictEqual(
  ratesDiffer(
    { internalHourlyRate: 2, status: "ACTIVE" },
    { internalHourlyRate: 2.5, status: "ACTIVE" }
  ),
  true
);

const v1 = { effectiveFrom: "2026-01-01T00:00:00.000Z", versionId: "a", createdAt: "2026-01-01T00:00:00.000Z" };
const v2 = { effectiveFrom: "2026-06-01T00:00:00.000Z", versionId: "b", createdAt: "2026-06-01T00:00:00.000Z" };
assert.strictEqual(pickEffectiveVersion([v1, v2], "2026-03-01T00:00:00.000Z").versionId, "a");
assert.strictEqual(pickEffectiveVersion([v1, v2], "2026-06-01T00:00:00.000Z").versionId, "b");
assert.strictEqual(pickEffectiveVersion([v1, v2], "2025-12-01T00:00:00.000Z"), null);
const sameInstant = [
  { effectiveFrom: "2026-06-01T00:00:00.000Z", versionId: "a", createdAt: "2026-06-01T00:00:00.000Z" },
  { effectiveFrom: "2026-06-01T00:00:00.000Z", versionId: "b", createdAt: "2026-06-01T00:00:01.000Z" },
];
assert.strictEqual(
  pickEffectiveVersion(sameInstant, "2026-06-01T00:00:00.000Z").versionId,
  "b"
);
assert.strictEqual(
  pickEffectiveVersion(sameInstant, "2026-06-01T12:00:00.000Z").versionId,
  "b"
);

(async () => {
  const ddb = memoryDdb();
  const first = await versionPutsForMutation({
    ddb,
    tableName: TABLE,
    ownerType: OWNER_DESIGNATION,
    ownerId: "seo",
    existingItem: null,
    nextSnapshot: {
      internalHourlyRate: 2,
      externalHourlyRate: 3,
      status: "ACTIVE",
    },
    nowIso: "2026-01-01T00:00:00.000Z",
    actor: "boss@mydgv.com",
  });
  assert.strictEqual(first.length, 1);
  await ddb.send(
    new TransactWriteCommand({ TransactItems: first })
  );
  const listed = await listRateVersions(ddb, TABLE, OWNER_DESIGNATION, "seo");
  assert.strictEqual(listed.length, 1);

  const second = await versionPutsForMutation({
    ddb,
    tableName: TABLE,
    ownerType: OWNER_EMPLOYEE,
    ownerId: "rahul@mydgv.com",
    existingItem: {
      internalHourlyRate: 4,
      externalHourlyRate: null,
      status: "ACTIVE",
      designationId: "seo",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    nextSnapshot: {
      internalHourlyRate: 5,
      externalHourlyRate: null,
      status: "ACTIVE",
      designationId: "seo",
    },
    nowIso: "2026-06-01T00:00:00.000Z",
    actor: "boss@mydgv.com",
  });
  assert.strictEqual(second.length, 2);
  console.log("costRateVersions tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

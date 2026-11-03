const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const departments = require("./departments");
const {
  SEED_DESIGNATIONS,
  applyDesignationSeed,
  applyLegacyCostingMigration,
  designationIdFor,
  planDesignationSeed,
  planLegacyCostingMigration,
} = require("./designationCatalog");

function keyOf(table, pk, sk) {
  return `${table}\0${pk}\0${sk}`;
}

function memoryDdb(seed = {}) {
  const items = { ...seed };
  return {
    items,
    async send(command) {
      if (command instanceof GetCommand) {
        const key = keyOf(
          command.input.TableName,
          command.input.Key.PK,
          command.input.Key.SK
        );
        return items[key] ? { Item: { ...items[key] } } : {};
      }
      if (command instanceof PutCommand) {
        const item = command.input.Item;
        items[keyOf(command.input.TableName, item.PK, item.SK)] = { ...item };
        return {};
      }
      if (command instanceof ScanCommand) {
        const found = Object.entries(items)
          .filter(([key]) => key.startsWith(`${command.input.TableName}\0`))
          .map(([, item]) => ({ ...item }));
        return { Items: found };
      }
      if (command instanceof TransactWriteCommand) {
        for (const entry of command.input.TransactItems) {
          if (!entry.Put) continue;
          const item = entry.Put.Item;
          const key = keyOf(entry.Put.TableName, item.PK, item.SK);
          if (
            String(entry.Put.ConditionExpression || "").includes("attribute_not_exists") &&
            items[key]
          ) {
            const err = new Error("conditional");
            err.name = "TransactionCanceledException";
            throw err;
          }
        }
        for (const entry of command.input.TransactItems) {
          if (!entry.Put) continue;
          const item = entry.Put.Item;
          items[keyOf(entry.Put.TableName, item.PK, item.SK)] = { ...item };
        }
        return {};
      }
      throw new Error(command.constructor.name);
    },
  };
}

function departmentItems() {
  return Object.fromEntries(
    departments.SEED_DEPARTMENTS.map((row) => [
      keyOf("work", "ENTITY#DEPARTMENT", `DEPARTMENT#${row.departmentId}`),
      {
        PK: "ENTITY#DEPARTMENT",
        SK: `DEPARTMENT#${row.departmentId}`,
        departmentId: row.departmentId,
        name: row.name,
      },
    ])
  );
}

(async () => {
  const ids = SEED_DESIGNATIONS.map((row) => row.designationId);
  const names = SEED_DESIGNATIONS.map((row) => row.nameKey);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.strictEqual(new Set(names).size, names.length);
  assert.strictEqual(SEED_DESIGNATIONS.length, 85);
  assert.strictEqual(
    designationIdFor(
      "it-software-development",
      "Software Development",
      "Technical Lead"
    ),
    ids[0]
  );
  const it = SEED_DESIGNATIONS.filter(
    (row) => row.departmentId === "it-software-development"
  );
  assert.deepStrictEqual(
    it.slice(0, 5).map((row) => row.name),
    [
      "Technical Lead",
      "Senior Software Developer",
      "Software Developer",
      "Junior Software Developer",
      "Intern Software Developer",
    ]
  );
  assert.deepStrictEqual(
    it.slice(0, 5).map((row) => row.sortOrder),
    [1, 2, 3, 4, 5]
  );
  assert.strictEqual(it[5].track, "Software Testing / QA");
  assert.strictEqual(it[5].sortOrder, 1);
  assert.strictEqual(it[10].track, "UI/UX Design");

  const missing = planDesignationSeed({ departments: [], designations: [] });
  assert.strictEqual(missing.create.length, 0);
  assert.ok(missing.missingDepartments.includes("it-software-development"));

  const ddb = memoryDdb(departmentItems());
  const plan = planDesignationSeed({
    departments: departments.SEED_DEPARTMENTS,
    designations: [],
  });
  assert.strictEqual(plan.create.length, 85);
  const first = await applyDesignationSeed({
    ddb,
    tableName: "work",
    plan,
    nowIso: "2026-11-02T00:00:00.000Z",
  });
  assert.strictEqual(first.created.length, 85);
  const lead = ddb.items[
    keyOf("work", "ENTITY#ORG_DESIGNATION", `DESIGNATION#${ids[0]}`)
  ];
  lead.internalHourlyRate = 9;
  lead.name = "Renamed Lead";
  const second = await applyDesignationSeed({
    ddb,
    tableName: "work",
    plan: planDesignationSeed({
      departments: departments.SEED_DEPARTMENTS,
      designations: SEED_DESIGNATIONS,
    }),
    nowIso: "2026-11-03T00:00:00.000Z",
  });
  assert.strictEqual(second.created.length, 0);
  assert.strictEqual(second.skipped.length, 85);
  assert.strictEqual(lead.internalHourlyRate, 9);
  assert.strictEqual(lead.name, "Renamed Lead");

  const target = SEED_DESIGNATIONS.find((row) => row.name === "SEO Specialist");
  const legacyId = "legacy-seo";
  const legacy = {
    PK: "ENTITY#DESIGNATION",
    SK: `DESIGNATION#${legacyId}`,
    type: "DESIGNATION",
    designationId: legacyId,
    name: "SEO Specialist",
    internalHourlyRate: 2,
    externalHourlyRate: 3,
    status: "ACTIVE",
  };
  const ambiguousLegacy = {
    PK: "ENTITY#DESIGNATION",
    SK: "DESIGNATION#ambiguous",
    type: "DESIGNATION",
    designationId: "ambiguous",
    name: "Shared Title",
  };
  const unmatched = {
    PK: "ENTITY#DESIGNATION",
    SK: "DESIGNATION#old-exec",
    type: "DESIGNATION",
    designationId: "old-exec",
    name: "SEO Executive",
    internalHourlyRate: 8,
  };
  const snapshot = {
    PK: "TASK#task-1",
    SK: "COST#person@mydgv.com",
    type: "ASSIGNMENT_COST",
    designationId: legacyId,
    hourlyRateUsd: 2,
    amountUsd: 4,
  };
  ddb.items[keyOf("work", legacy.PK, legacy.SK)] = legacy;
  ddb.items[keyOf("work", ambiguousLegacy.PK, ambiguousLegacy.SK)] = ambiguousLegacy;
  ddb.items[keyOf("work", unmatched.PK, unmatched.SK)] = unmatched;
  ddb.items[keyOf("work", snapshot.PK, snapshot.SK)] = snapshot;
  ddb.items[keyOf("work", "USER#person@mydgv.com", "COST_RATES")] = {
    PK: "USER#person@mydgv.com",
    SK: "COST_RATES",
    type: "EMPLOYEE_COST_RATES",
    email: "person@mydgv.com",
    designationId: legacyId,
    internalHourlyRate: 1.5,
  };
  ddb.items[keyOf("work", "ENTITY#ORG_DESIGNATION", "DESIGNATION#shared-a")] = {
    PK: "ENTITY#ORG_DESIGNATION",
    SK: "DESIGNATION#shared-a",
    type: "ORG_DESIGNATION",
    designationId: "shared-a",
    departmentId: "it-software-development",
    name: "Shared Title",
  };
  ddb.items[keyOf("work", "ENTITY#ORG_DESIGNATION", "DESIGNATION#shared-b")] = {
    PK: "ENTITY#ORG_DESIGNATION",
    SK: "DESIGNATION#shared-b",
    type: "ORG_DESIGNATION",
    designationId: "shared-b",
    departmentId: "ai-automation",
    name: "Shared Title",
  };
  const orgItems = Object.values(ddb.items).filter(
    (item) => item.type === "ORG_DESIGNATION"
  );
  const legacyItems = Object.values(ddb.items).filter(
    (item) => item.PK === "ENTITY#DESIGNATION"
  );
  const report = planLegacyCostingMigration({ legacyItems, orgItems });
  assert.strictEqual(report.unmatched[0].name, "SEO Executive");
  assert.strictEqual(report.ambiguous[0].designationId, "ambiguous");
  const match = report.pendingMatches.find((row) => row.designationId === legacyId);
  assert.strictEqual(match.action, "manual-review");
  assert.strictEqual(match.targetDesignationId, undefined);
  assert.ok(match.reason.includes("not a link"));
  const applied = await applyLegacyCostingMigration({
    ddb,
    tableName: "work",
    plan: report,
    nowIso: "2026-11-02T00:00:00.000Z",
  });
  assert.strictEqual(applied.copied.length, 0);
  assert.strictEqual(applied.relinked.length, 0);
  assert.ok(applied.manual.some((row) => row.designationId === legacyId));
  const org = ddb.items[
    keyOf("work", "ENTITY#ORG_DESIGNATION", `DESIGNATION#${target.designationId}`)
  ];
  assert.strictEqual(org.internalHourlyRate, null);
  assert.strictEqual(
    ddb.items[keyOf("work", "USER#person@mydgv.com", "COST_RATES")].designationId,
    legacyId
  );
  assert.strictEqual(
    ddb.items[keyOf("work", "USER#person@mydgv.com", "COST_RATES")].internalHourlyRate,
    1.5
  );
  assert.strictEqual(snapshot.hourlyRateUsd, 2);
  assert.strictEqual(snapshot.designationId, legacyId);
  assert.strictEqual(
    ddb.items[keyOf("work", legacy.PK, legacy.SK)].migratedToDesignationId,
    undefined
  );
  assert.strictEqual(
    ddb.items[keyOf("work", unmatched.PK, unmatched.SK)].internalHourlyRate,
    8
  );

  console.log("designationCatalog.test.js ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Seed approved department designations and report legacy costing rows.
 *
 * Does not rename departments, delete designations, or rewrite cost snapshots.
 * Existing designation rows, rates, and employee assignments are left in place.
 * Default is dry-run. Pass --apply to write missing designations and safe links.
 *
 *   node scripts/seed-department-designations.js
 *   node scripts/seed-department-designations.js --apply
 */
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const {
  DEPARTMENT_ENTITY_PK,
  LEGACY_DESIGNATION_PK,
  ORG_DESIGNATION_PK,
  applyDesignationSeed,
  applyLegacyCostingMigration,
  planDesignationSeed,
  planLegacyCostingMigration,
} = require("../lambda/projects/designationCatalog");

function parseArgs(argv) {
  return { apply: argv.includes("--apply") };
}

async function queryPk(ddb, tableName, pk, skPrefix) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": pk, ":sk": skPrefix },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1";
  const tableName = process.env.WORK_TABLE;
  if (!tableName) throw new Error("WORK_TABLE is required.");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const [departments, designations, legacyItems] = await Promise.all([
    queryPk(ddb, tableName, DEPARTMENT_ENTITY_PK, "DEPARTMENT#"),
    queryPk(ddb, tableName, ORG_DESIGNATION_PK, "DESIGNATION#"),
    queryPk(ddb, tableName, LEGACY_DESIGNATION_PK, "DESIGNATION#"),
  ]);
  const seedPlan = planDesignationSeed({ departments, designations });
  const legacyPlan = planLegacyCostingMigration({ legacyItems, orgItems: designations });
  const preview = {
    mode: args.apply ? "apply" : "dry-run",
    missingDepartments: seedPlan.missingDepartments,
    create: seedPlan.create.map((row) => ({
      designationId: row.designationId,
      departmentId: row.departmentId,
      track: row.track,
      sortOrder: row.sortOrder,
      name: row.name,
    })),
    skipExisting: seedPlan.skip.length,
    legacy: legacyPlan,
  };
  console.log(JSON.stringify(preview, null, 2));
  if (!args.apply) return;
  if (seedPlan.missingDepartments.length) {
    throw new Error("Refusing to seed because one or more departments are missing.");
  }
  const seeded = await applyDesignationSeed({ ddb, tableName, plan: seedPlan });
  const orgItems = await queryPk(ddb, tableName, ORG_DESIGNATION_PK, "DESIGNATION#");
  const freshLegacy = await queryPk(ddb, tableName, LEGACY_DESIGNATION_PK, "DESIGNATION#");
  const migrated = await applyLegacyCostingMigration({
    ddb,
    tableName,
    plan: planLegacyCostingMigration({ legacyItems: freshLegacy, orgItems }),
  });
  console.log(JSON.stringify({ seeded, migrated }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

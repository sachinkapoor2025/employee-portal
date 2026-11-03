#!/usr/bin/env node
/**
 * Link legacy profile.department text to catalog department IDs.
 *
 * Does not delete profiles, costing rows, or the original department string.
 * Default is dry-run. Pass --apply to write.
 *
 *   node scripts/migrate-department-memberships.js
 *   node scripts/migrate-department-memberships.js --apply
 *   node scripts/migrate-department-memberships.js --apply --limit 20
 */
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const departments = require("../lambda/projects/departments");

function parseArgs(argv) {
  const args = { apply: argv.includes("--apply"), limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit") args.limit = Number(argv[i + 1]) || 0;
    if (argv[i].startsWith("--limit=")) args.limit = Number(argv[i].slice(8)) || 0;
  }
  return args;
}

async function listDepartments(ddb, tableName) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": departments.DEPARTMENT_ENTITY_PK,
          ":sk": "DEPARTMENT#",
        },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

function catalogForPreview(live) {
  const byId = new Map(live.map((item) => [item.departmentId, item]));
  for (const seed of departments.SEED_DEPARTMENTS) {
    if (!byId.has(seed.departmentId)) byId.set(seed.departmentId, seed);
  }
  return [...byId.values()];
}

async function scanProfiles(ddb, tableName) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey })
    );
    items.push(...(res.Items || []).filter((item) => item.SK === "PROFILE"));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1";
  const workTable = process.env.WORK_TABLE;
  const profileTable = process.env.USER_PROFILE_TABLE;
  if (!workTable || !profileTable) {
    throw new Error("WORK_TABLE and USER_PROFILE_TABLE are required.");
  }
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const now = new Date().toISOString();
  if (args.apply) {
    await departments.ensureSeedDepartments({
      ddb,
      tableName: workTable,
      nowIso: now,
      actor: "migration",
    });
  }
  const directory = catalogForPreview(await listDepartments(ddb, workTable));
  const profiles = await scanProfiles(ddb, profileTable);
  const summary = { match: 0, unmatched: 0, skip: 0, review: 0, written: 0 };
  const preview = [];
  let considered = 0;
  for (const profile of profiles) {
    const plan = departments.planProfileDepartmentMigration(profile, directory);
    summary[plan.action] = (summary[plan.action] || 0) + 1;
    if (plan.action === "skip") continue;
    considered += 1;
    if (args.limit && considered > args.limit) continue;
    const patch = departments.migrationPatch(plan, now);
    preview.push({
      email: profile.email || String(profile.PK || "").replace(/^USER#/, ""),
      legacyDepartment: profile.department || "",
      action: plan.action,
      patch,
    });
    if (!args.apply || !patch) continue;
    const names = {};
    const values = { ":updatedAt": now };
    const sets = ["updatedAt = :updatedAt"];
    Object.entries(patch).forEach(([key, value], index) => {
      names[`#f${index}`] = key;
      values[`:v${index}`] = value;
      sets.push(`#f${index} = :v${index}`);
    });
    await ddb.send(
      new UpdateCommand({
        TableName: profileTable,
        Key: { PK: profile.PK, SK: profile.SK },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    summary.written += 1;
  }
  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "apply" : "dry-run",
        region,
        workTable,
        profileTable,
        profiles: profiles.length,
        summary,
        preview: preview.slice(0, 50),
        previewTruncated: preview.length > 50,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * One-time USER assignment pointer backfill. Default is dry-run (no writes).
 *
 * Discovers canonical TASK#{taskId}/ASSIGNMENT#{email} rows by listing
 * ENTITY#TASK then querying each task. Does not scan USER partitions and
 * does not modify assignments or cost snapshots.
 *
 * Usage (do not run --write in this change set):
 *   node scripts/backfill-user-assignment-pointers.js --dry-run
 *   node scripts/backfill-user-assignment-pointers.js --write --i-understand-write
 *
 * This CLI is not executed by tests. Tests call the planner with in-memory DDB.
 */
"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const {
  runUserAssignmentPointerBackfill,
  summarizeBackfill,
} = require("../lambda/projects/userAssignmentPointers");

function parseArgs(argv) {
  const args = {
    dryRun: true,
    write: false,
    maxTasks: 400,
    maxQueryPages: 40,
    tableName: process.env.WORK_TABLE || "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--write") args.write = true;
    if (token === "--dry-run") args.dryRun = true;
    if (token === "--i-understand-write") args.ackWrite = true;
    if (token === "--max-tasks") args.maxTasks = Number(argv[i + 1]) || 400;
    if (token === "--table") args.tableName = String(argv[i + 1] || "");
    if (token.startsWith("--max-tasks=")) {
      args.maxTasks = Number(token.slice(12)) || 400;
    }
    if (token.startsWith("--table=")) args.tableName = token.slice(8);
  }
  if (args.write && args.ackWrite) args.dryRun = false;
  else args.write = false;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tableName) {
    console.error("WORK_TABLE or --table is required. Aborting.");
    process.exit(2);
  }
  if (args.write && !args.ackWrite) {
    console.error("Write mode requires --write --i-understand-write. Aborting.");
    process.exit(2);
  }
  const region = process.env.AWS_REGION || "ap-south-1";
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const report = await runUserAssignmentPointerBackfill({
    ddb,
    tableName: args.tableName,
    maxTasks: args.maxTasks,
    maxQueryPages: args.maxQueryPages,
    write: args.write,
  });
  console.log(JSON.stringify(summarizeBackfill(report), null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseArgs };

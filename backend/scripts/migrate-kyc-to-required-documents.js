#!/usr/bin/env node
/**
 * One-time copy-only KYC migration.
 *
 * Copies Aadhaar / PAN / Photograph / Resume blobs into files/{fileId}
 * and adds them to each user's Required Documents personal folder.
 * Does not delete DynamoDB records or original S3 objects.
 *
 * Usage:
 *   node scripts/migrate-kyc-to-required-documents.js --dry-run --limit 3
 *   node scripts/migrate-kyc-to-required-documents.js --apply --limit 3
 *   node scripts/migrate-kyc-to-required-documents.js --apply
 */
const { S3Client } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const {
  createDocumentsStorage,
  migrateKycDocuments,
  resolveBuckets,
} = require("../lambda/documents/kycMigration");

function parseArgs(argv) {
  const args = {
    dryRun: !argv.includes("--apply"),
    limit: 0,
    emails: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--limit") args.limit = Number(argv[i + 1]) || 0;
    if (token === "--emails" && argv[i + 1]) {
      args.emails = String(argv[i + 1])
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    }
    if (token.startsWith("--limit=")) args.limit = Number(token.slice(8)) || 0;
    if (token.startsWith("--emails=")) {
      args.emails = token
        .slice(9)
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1";
  const s3 = new S3Client({ region });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const { documentsBucket, profileBucket } = await resolveBuckets(s3, {
    documentsBucket: process.env.DOCUMENTS_BUCKET,
    profileBucket: process.env.PROFILE_IMAGE_BUCKET,
  });
  const workTable = process.env.WORK_TABLE || "mydgv-portal-WorkTasks";
  const profileTable = process.env.USER_PROFILE_TABLE || "mydgv-portal-UserProfile";
  const storage = createDocumentsStorage({ s3, bucket: documentsBucket });

  console.log(
    JSON.stringify(
      {
        mode: args.dryRun ? "dry-run" : "apply",
        region,
        workTable,
        profileTable,
        documentsBucket,
        profileBucket,
        limit: args.limit || null,
        emails: args.emails,
      },
      null,
      2
    )
  );

  const report = await migrateKycDocuments({
    ddb,
    s3,
    storage,
    workTable,
    profileTable,
    documentsBucket,
    profileBucket,
    dryRun: args.dryRun,
    limit: args.limit,
    emails: args.emails,
  });

  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

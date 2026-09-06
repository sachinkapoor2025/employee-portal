const assert = require("assert");
const {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
} = require("@aws-sdk/client-s3");
const {
  QueryCommand,
  ScanCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const { createDocumentsStorage } = require("../common/documentsStorage");
const { REQUIRED_DOCUMENTS_ID } = require("./folderRules");
const { migrateKycDocuments, isKycType } = require("./kycMigration");

function createMemoryS3(seed = {}) {
  const objects = new Map(Object.entries(seed));
  let seq = 0;
  function nextEtag() {
    seq += 1;
    return `"etag-${seq}"`;
  }
  async function send(command) {
    const input = command.input || {};
    const key = input.Key;
    if (command instanceof ListBucketsCommand) {
      return { Buckets: [{ Name: "mydgv-portal-employee-documents-test" }] };
    }
    if (command instanceof HeadObjectCommand) {
      const bucketKey = `${input.Bucket}::${key}`;
      if (!objects.has(bucketKey) && !objects.has(key)) {
        const err = new Error("missing");
        err.name = "NoSuchKey";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const obj = objects.get(`${input.Bucket}::${key}`) || objects.get(key);
      if (!obj) {
        const err = new Error("missing");
        err.name = "NoSuchKey";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {
        ETag: obj.etag,
        ContentType: obj.contentType,
        Body: {
          transformToByteArray: async () => obj.body,
          transformToString: async () => obj.body.toString("utf8"),
        },
      };
    }
    if (command instanceof PutObjectCommand) {
      const body = Buffer.isBuffer(input.Body)
        ? input.Body
        : Buffer.from(input.Body == null ? "" : String(input.Body));
      const stored = {
        body,
        etag: nextEtag(),
        contentType: input.ContentType,
        metadata: input.Metadata || {},
      };
      objects.set(key, stored);
      objects.set(`${input.Bucket}::${key}`, stored);
      return { ETag: stored.etag };
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(key);
      objects.delete(`${input.Bucket}::${key}`);
      return {};
    }
    throw new Error(`Unsupported command ${command.constructor.name}`);
  }
  return { send, _objects: objects };
}

function createMemoryDdb(items) {
  const rows = items.slice();
  async function send(command) {
    const input = command.input || {};
    if (command instanceof QueryCommand) {
      const pk = input.ExpressionAttributeValues[":pk"];
      const skPrefix = input.ExpressionAttributeValues[":sk"];
      return {
        Items: rows.filter(
          (row) =>
            row.PK === pk &&
            (!skPrefix || String(row.SK || "").startsWith(skPrefix))
        ),
      };
    }
    if (command instanceof ScanCommand) {
      const sk = input.ExpressionAttributeValues && input.ExpressionAttributeValues[":sk"];
      return {
        Items: rows.filter((row) => !sk || row.SK === sk),
      };
    }
    if (command instanceof GetCommand) {
      const found = rows.find(
        (row) => row.PK === input.Key.PK && row.SK === input.Key.SK
      );
      return { Item: found };
    }
    throw new Error(`Unsupported command ${command.constructor.name}`);
  }
  return { send };
}

async function run() {
  assert.ok(isKycType("aadhaar"));
  assert.ok(isKycType("RESUME"));
  assert.ok(!isKycType("BANK"));

  const sourceKey = "documents/rahul@mydgv.com/AADHAAR/doc-1/aadhaar.pdf";
  const s3 = createMemoryS3({
    [`docs-bucket::${sourceKey}`]: {
      body: Buffer.from("aadhaar-bytes"),
      etag: '"1"',
      contentType: "application/pdf",
    },
  });
  const storage = createDocumentsStorage({ s3, bucket: "docs-bucket" });
  const ddb = createMemoryDdb([
    {
      PK: "ENTITY#DOCUMENT",
      SK: "DOC#doc-1",
      documentId: "doc-1",
      email: "rahul@mydgv.com",
      documentType: "AADHAAR",
      fileName: "aadhaar.pdf",
      fileSize: 13,
      fileType: "application/pdf",
      storageKey: sourceKey,
      isCurrent: true,
      uploadedAt: "2026-01-01T00:00:00.000Z",
      description: "KYC Aadhaar",
    },
    {
      PK: "ENTITY#DOCUMENT",
      SK: "DOC#doc-bank",
      documentId: "doc-bank",
      email: "rahul@mydgv.com",
      documentType: "BANK",
      fileName: "bank.pdf",
      storageKey: "documents/rahul@mydgv.com/BANK/x/bank.pdf",
      isCurrent: true,
    },
    {
      PK: "USER#priya@mydgv.com",
      SK: "PROFILE",
      email: "priya@mydgv.com",
      hrDocuments: [
        {
          documentId: "p-pan",
          documentType: "PAN",
          fileName: "pan.jpg",
          storageKey: "profiles/priya@mydgv.com/pan.jpg",
        },
      ],
    },
  ]);

  s3._objects.set("profiles-bucket::profiles/priya@mydgv.com/pan.jpg", {
    body: Buffer.from("pan-bytes"),
    etag: '"2"',
    contentType: "image/jpeg",
  });

  const dry = await migrateKycDocuments({
    ddb,
    s3,
    storage,
    workTable: "work",
    profileTable: "profiles",
    documentsBucket: "docs-bucket",
    profileBucket: "profiles-bucket",
    dryRun: true,
  });
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.usersProcessed, 2);
  assert.strictEqual(dry.copied, 2);
  assert.ok(!s3._objects.has("files/"));

  const applied = await migrateKycDocuments({
    ddb,
    s3,
    storage,
    workTable: "work",
    profileTable: "profiles",
    documentsBucket: "docs-bucket",
    profileBucket: "profiles-bucket",
    dryRun: false,
  });
  assert.strictEqual(applied.copied, 2);
  assert.strictEqual(applied.errors.length, 0);

  const required = await storage.readManifest(
    "manifests/personal/rahul@mydgv.com/folders/required-documents.json"
  );
  assert.ok(required);
  assert.strictEqual(required.manifest.id, REQUIRED_DOCUMENTS_ID);
  assert.strictEqual(required.manifest.children.length, 1);
  assert.strictEqual(required.manifest.children[0].sourceDocumentId, "doc-1");
  assert.ok(required.manifest.children[0].fileId);
  assert.ok(s3._objects.has(`files/${required.manifest.children[0].fileId}`));
  assert.ok(s3._objects.has(`docs-bucket::${sourceKey}`), "source object must remain");

  const priya = await storage.readManifest(
    "manifests/personal/priya@mydgv.com/folders/required-documents.json"
  );
  assert.strictEqual(priya.manifest.children[0].sourceDocumentId, "p-pan");

  const again = await migrateKycDocuments({
    ddb,
    s3,
    storage,
    workTable: "work",
    profileTable: "profiles",
    documentsBucket: "docs-bucket",
    profileBucket: "profiles-bucket",
    dryRun: false,
  });
  assert.strictEqual(again.copied, 0);
  assert.strictEqual(again.skipped, 2);

  const limited = await migrateKycDocuments({
    ddb,
    s3,
    storage,
    workTable: "work",
    profileTable: "profiles",
    documentsBucket: "docs-bucket",
    profileBucket: "profiles-bucket",
    dryRun: true,
    limit: 1,
  });
  assert.strictEqual(limited.usersProcessed, 1);

  console.log("kycMigration tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

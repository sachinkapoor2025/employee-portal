const assert = require("assert");
const {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { createDocumentsStorage } = require("../common/documentsStorage");
const {
  parseNotificationRoute,
  handleNotificationRequest,
} = require("./notificationsLogic");

function createMemoryS3() {
  const objects = new Map();
  let seq = 0;

  function nextEtag() {
    seq += 1;
    return `"etag-${seq}"`;
  }

  async function send(command) {
    const input = command.input || {};
    const key = input.Key;

    if (command instanceof GetObjectCommand) {
      const obj = objects.get(key);
      if (!obj) {
        const err = new Error("The specified key does not exist.");
        err.name = "NoSuchKey";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {
        ETag: obj.etag,
        ContentType: obj.contentType,
        Metadata: obj.metadata,
        Body: {
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
      return { ETag: stored.etag };
    }

    if (command instanceof DeleteObjectCommand) {
      objects.delete(key);
      return {};
    }

    if (command instanceof ListObjectsV2Command) {
      const prefix = input.Prefix || "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return {
        Contents: keys.map((Key) => ({ Key })),
        IsTruncated: false,
      };
    }

    throw new Error(`Unsupported command ${command.constructor.name}`);
  }

  return { send, _objects: objects };
}

function parse(res) {
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function user() {
  return { email: "rahul@mydgv.com", isAdmin: false };
}

async function call(storage, method, path, { body, query } = {}) {
  const route = parseNotificationRoute(path);
  assert.ok(route, `expected notification route for ${path}`);
  return handleNotificationRequest({
    user: user(),
    method,
    body: body || {},
    query: query || {},
    route,
    storage,
  });
}

async function run() {
  assert.deepStrictEqual(parseNotificationRoute("/documents/notifications/feed"), {
    kind: "feed",
  });
  assert.deepStrictEqual(
    parseNotificationRoute("/prod/documents/notifications/mark-seen"),
    { kind: "mark-seen" }
  );

  const s3 = createMemoryS3();
  const storage = createDocumentsStorage({ s3, bucket: "test-docs" });

  const empty = parse(await call(storage, "GET", "/documents/notifications/feed"));
  assert.strictEqual(empty.status, 200);
  assert.deepStrictEqual(empty.body.events, []);
  assert.strictEqual(empty.body.unreadCount, 0);
  assert.strictEqual(empty.body.lastSeenAt, null);

  await storage.putNotificationEvent({
    timestamp: "2026-09-01T10:00:00.000Z",
    eventId: "evt-1",
    projectId: "p1",
    projectName: "Alpha",
    folderPath: "Alpha / Legal",
    fileCount: 2,
    uploadedBy: "admin@mydgv.com",
  });
  await storage.putNotificationEvent({
    timestamp: "2026-09-02T10:00:00.000Z",
    eventId: "evt-2",
    projectId: "p1",
    projectName: "Alpha",
    folderPath: "Alpha",
    fileCount: 1,
    uploadedBy: "admin@mydgv.com",
  });

  const feed = parse(await call(storage, "GET", "/documents/notifications/feed"));
  assert.strictEqual(feed.status, 200);
  assert.strictEqual(feed.body.events.length, 2);
  assert.strictEqual(feed.body.events[0].eventId, "evt-2");
  assert.strictEqual(feed.body.unreadCount, 2);

  const seen = parse(
    await call(storage, "POST", "/documents/notifications/mark-seen", {
      body: { lastSeenAt: "2026-09-02T10:00:00.000Z" },
    })
  );
  assert.strictEqual(seen.status, 200);
  assert.strictEqual(seen.body.lastSeenAt, "2026-09-02T10:00:00.000Z");

  const afterSeen = parse(
    await call(storage, "GET", "/documents/notifications/feed")
  );
  assert.strictEqual(afterSeen.body.unreadCount, 0);
  assert.strictEqual(afterSeen.body.lastSeenAt, "2026-09-02T10:00:00.000Z");

  await storage.putNotificationEvent({
    timestamp: "2026-09-03T10:00:00.000Z",
    eventId: "evt-3",
    projectName: "Beta",
    fileCount: 4,
    uploadedBy: "admin@mydgv.com",
  });

  const newer = parse(await call(storage, "GET", "/documents/notifications/feed"));
  assert.strictEqual(newer.body.unreadCount, 1);
  assert.strictEqual(newer.body.events[0].eventId, "evt-3");

  console.log("notificationsLogic tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

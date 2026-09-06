const assert = require("assert");
const {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { createDocumentsStorage } = require("../common/documentsStorage");
const { REQUIRED_DOCUMENTS_ID } = require("./folderRules");
const {
  parsePersonalRoute,
  handlePersonalRequest,
} = require("./personalLogic");

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
      const existing = objects.get(key);
      if (input.IfMatch) {
        if (!existing || existing.etag !== input.IfMatch) {
          const err = new Error("precondition");
          err.name = "PreconditionFailed";
          err.$metadata = { httpStatusCode: 412 };
          throw err;
        }
      } else if (input.IfNoneMatch === "*" && existing) {
        const err = new Error("precondition");
        err.name = "PreconditionFailed";
        err.$metadata = { httpStatusCode: 412 };
        throw err;
      }
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

function admin() {
  return { email: "admin@mydgv.com", isAdmin: true };
}

function employee() {
  return { email: "rahul@mydgv.com", isAdmin: false };
}

async function call(storage, method, path, { user, body, query } = {}) {
  const route = parsePersonalRoute(path);
  assert.ok(route, `expected personal route for ${path}`);
  return handlePersonalRequest({
    user: user || employee(),
    method,
    body: body || {},
    query: query || {},
    route,
    storage,
  });
}

function pdf(name, text) {
  return {
    fileName: name,
    contentType: "application/pdf",
    fileSize: Buffer.byteLength(text),
    content: Buffer.from(text).toString("base64"),
  };
}

async function run() {
  assert.deepStrictEqual(parsePersonalRoute("/documents/personal"), {
    kind: "root",
    email: null,
  });
  assert.deepStrictEqual(
    parsePersonalRoute("/documents/personal/ada@mydgv.com/folders/f1"),
    { kind: "folder", email: "ada@mydgv.com", folderId: "f1" }
  );
  assert.deepStrictEqual(
    parsePersonalRoute("/documents/personal/ada@mydgv.com/files/file-9/download-url"),
    {
      kind: "download-url",
      email: "ada@mydgv.com",
      folderId: "root",
      fileId: "file-9",
    }
  );
  assert.deepStrictEqual(
    parsePersonalRoute(
      "/documents/personal/ada@mydgv.com/folders/d1/files/file-9/download-url"
    ),
    {
      kind: "download-url",
      email: "ada@mydgv.com",
      folderId: "d1",
      fileId: "file-9",
    }
  );

  const s3 = createMemoryS3();
  const storage = createDocumentsStorage({ s3, bucket: "test-docs" });

  const first = parse(await call(storage, "GET", "/documents/personal"));
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.email, "rahul@mydgv.com");
  assert.strictEqual(first.body.children[0].id, REQUIRED_DOCUMENTS_ID);
  assert.strictEqual(first.body.children[0].name, "Required Documents");
  assert.strictEqual(first.body.children[0].isSystem, true);

  const second = parse(await call(storage, "GET", "/documents/personal"));
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.children.length, 1);

  const otherDenied = parse(
    await call(storage, "GET", "/documents/personal/priya@mydgv.com")
  );
  assert.strictEqual(otherDenied.status, 403);

  const adminOther = parse(
    await call(storage, "GET", "/documents/personal/priya@mydgv.com", {
      user: admin(),
    })
  );
  assert.strictEqual(adminOther.status, 200);
  assert.strictEqual(adminOther.body.email, "priya@mydgv.com");
  assert.ok(adminOther.body.children.some((c) => c.isSystem));

  const reserved = parse(
    await call(storage, "POST", "/documents/personal/rahul@mydgv.com/subfolders", {
      body: { name: "Required Documents" },
    })
  );
  assert.strictEqual(reserved.status, 400);

  const created = parse(
    await call(storage, "POST", "/documents/personal/rahul@mydgv.com/subfolders", {
      body: { name: "Tax" },
    })
  );
  assert.strictEqual(created.status, 201);
  const taxId = created.body.id;

  const dup = parse(
    await call(storage, "POST", "/documents/personal/rahul@mydgv.com/subfolders", {
      body: { name: "Tax" },
    })
  );
  assert.strictEqual(dup.body.name, "Tax (1)");

  const listed = parse(await call(storage, "GET", "/documents/personal"));
  assert.strictEqual(listed.body.children[0].isSystem, true);

  const renameSystem = parse(
    await call(
      storage,
      "PATCH",
      `/documents/personal/rahul@mydgv.com/folders/${REQUIRED_DOCUMENTS_ID}`,
      { body: { name: "KYC" } }
    )
  );
  assert.strictEqual(renameSystem.status, 400);

  const deleteSystem = parse(
    await call(
      storage,
      "DELETE",
      `/documents/personal/rahul@mydgv.com/folders/${REQUIRED_DOCUMENTS_ID}`
    )
  );
  assert.strictEqual(deleteSystem.status, 400);

  const intoRequired = parse(
    await call(
      storage,
      "POST",
      `/documents/personal/rahul@mydgv.com/folders/${REQUIRED_DOCUMENTS_ID}/files`,
      { body: { files: [pdf("aadhaar.pdf", "id-doc")], description: "KYC" } }
    )
  );
  assert.strictEqual(intoRequired.status, 201);
  assert.strictEqual(intoRequired.body.files[0].name, "aadhaar.pdf");
  assert.ok(!intoRequired.body.notification);
  const notifyKeys = [...s3._objects.keys()].filter((k) =>
    k.startsWith("notifications/events/")
  );
  assert.strictEqual(notifyKeys.length, 0);

  const otherUpload = parse(
    await call(
      storage,
      "POST",
      "/documents/personal/priya@mydgv.com/files",
      { body: { files: [pdf("x.pdf", "x")] } }
    )
  );
  assert.strictEqual(otherUpload.status, 403);

  const otherDownload = parse(
    await call(
      storage,
      "POST",
      "/documents/personal/priya@mydgv.com/files/file-9/download-url"
    )
  );
  assert.strictEqual(otherDownload.status, 403);

  const adminUpload = parse(
    await call(
      storage,
      "POST",
      "/documents/personal/priya@mydgv.com/files",
      { user: admin(), body: { files: [pdf("note.pdf", "n")] } }
    )
  );
  assert.strictEqual(adminUpload.status, 201);

  const deleted = parse(
    await call(
      storage,
      "DELETE",
      `/documents/personal/rahul@mydgv.com/folders/${taxId}`
    )
  );
  assert.strictEqual(deleted.status, 200);

  const deleteRoot = parse(
    await call(storage, "DELETE", "/documents/personal/rahul@mydgv.com")
  );
  assert.strictEqual(deleteRoot.status, 400);

  console.log("personalLogic tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

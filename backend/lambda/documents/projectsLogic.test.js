const assert = require("assert");
const {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { createDocumentsStorage } = require("../common/documentsStorage");
const {
  parseProjectRoute,
  handleProjectRequest,
  uniqueName,
  isReservedFolderName,
  validateFile,
} = require("./projectsLogic");

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

async function call(storage, method, path, { user, body } = {}) {
  const route = parseProjectRoute(path);
  assert.ok(route, `expected project route for ${path}`);
  return handleProjectRequest({
    user: user || admin(),
    method,
    body: body || {},
    route,
    storage,
  });
}

function notificationKeys(s3) {
  return [...s3._objects.keys()].filter((k) =>
    k.startsWith("notifications/events/")
  );
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
  assert.strictEqual(uniqueName("Report.pdf", []), "Report.pdf");
  assert.strictEqual(
    uniqueName("Report.pdf", ["Report.pdf"], { keepExtension: true }),
    "Report (1).pdf"
  );
  assert.strictEqual(
    uniqueName("Report.pdf", ["Report.pdf", "Report (1).pdf"], {
      keepExtension: true,
    }),
    "Report (2).pdf"
  );
  assert.strictEqual(uniqueName("Legal", ["Legal", "legal"]), "Legal (1)");
  assert.ok(isReservedFolderName("Required Documents"));
  assert.ok(isReservedFolderName(" required documents "));
  assert.ok(!isReservedFolderName("Required Docs"));
  assert.ok(validateFile({ fileName: "notes.exe", fileSize: 10 }));
  assert.strictEqual(validateFile({ fileName: "notes.pdf", fileSize: 10 }), null);

  assert.deepStrictEqual(parseProjectRoute("/documents/projects"), {
    kind: "index",
  });
  assert.deepStrictEqual(
    parseProjectRoute("/prod/documents/projects/abc/folders/root/files"),
    { kind: "files", projectId: "abc", folderId: "root" }
  );
  assert.deepStrictEqual(
    parseProjectRoute("/documents/projects/p1/folders/f1/files/file-9"),
    { kind: "file", projectId: "p1", folderId: "f1", fileId: "file-9" }
  );
  assert.deepStrictEqual(
    parseProjectRoute("/documents/projects/p1/files/file-9/download-url"),
    {
      kind: "download-url",
      projectId: "p1",
      folderId: "root",
      fileId: "file-9",
    }
  );
  assert.deepStrictEqual(
    parseProjectRoute("/documents/projects/p1/folders/d1/files/file-9/download-url"),
    {
      kind: "download-url",
      projectId: "p1",
      folderId: "d1",
      fileId: "file-9",
    }
  );

  const s3 = createMemoryS3();
  const storage = createDocumentsStorage({ s3, bucket: "test-docs" });

  const forbidden = parse(
    await call(storage, "POST", "/documents/projects", {
      user: employee(),
      body: { name: "Secret" },
    })
  );
  assert.strictEqual(forbidden.status, 403);
  assert.strictEqual(forbidden.body.error, "Admin required");

  const reserved = parse(
    await call(storage, "POST", "/documents/projects", {
      body: { name: "Required Documents" },
    })
  );
  assert.strictEqual(reserved.status, 400);
  assert.ok(String(reserved.body.error).includes("reserved"));

  const created = parse(
    await call(storage, "POST", "/documents/projects", {
      body: { name: "Q4 Reports" },
    })
  );
  assert.strictEqual(created.status, 201);
  const projectId = created.body.projectId;
  assert.ok(projectId);
  assert.strictEqual(created.body.name, "Q4 Reports");

  const dupProject = parse(
    await call(storage, "POST", "/documents/projects", {
      body: { name: "Q4 Reports" },
    })
  );
  assert.strictEqual(dupProject.status, 201);
  assert.strictEqual(dupProject.body.name, "Q4 Reports (1)");

  const listed = parse(
    await call(storage, "GET", "/documents/projects", { user: employee() })
  );
  assert.strictEqual(listed.status, 200);
  assert.strictEqual(listed.body.projects.length, 2);

  const root = parse(
    await call(storage, "GET", `/documents/projects/${projectId}/folders`, {
      user: employee(),
    })
  );
  assert.strictEqual(root.status, 200);
  assert.deepStrictEqual(root.body.children, []);

  const reservedFolder = parse(
    await call(storage, "POST", `/documents/projects/${projectId}/subfolders`, {
      body: { name: "required documents" },
    })
  );
  assert.strictEqual(reservedFolder.status, 400);

  const folderA = parse(
    await call(storage, "POST", `/documents/projects/${projectId}/subfolders`, {
      body: { name: "Legal" },
    })
  );
  assert.strictEqual(folderA.status, 201);
  const folderAId = folderA.body.id;

  const folderADup = parse(
    await call(storage, "POST", `/documents/projects/${projectId}/subfolders`, {
      body: { name: "Legal" },
    })
  );
  assert.strictEqual(folderADup.body.name, "Legal (1)");

  const nested = parse(
    await call(
      storage,
      "POST",
      `/documents/projects/${projectId}/folders/${folderAId}/subfolders`,
      { body: { name: "Contracts" } }
    )
  );
  assert.strictEqual(nested.status, 201);
  const folderBId = nested.body.id;
  assert.strictEqual(nested.body.parentId, folderAId);

  const empUpload = parse(
    await call(
      storage,
      "POST",
      `/documents/projects/${projectId}/folders/${folderBId}/files`,
      {
        user: employee(),
        body: { files: [pdf("secret.pdf", "nope")], description: "blocked" },
      }
    )
  );
  assert.strictEqual(empUpload.status, 403);
  assert.strictEqual(notificationKeys(s3).length, 0);

  const badType = parse(
    await call(
      storage,
      "POST",
      `/documents/projects/${projectId}/folders/${folderBId}/files`,
      {
        body: {
          files: [
            pdf("ok.pdf", "one"),
            { fileName: "virus.exe", content: Buffer.from("x").toString("base64") },
          ],
        },
      }
    )
  );
  assert.strictEqual(badType.status, 400);
  assert.strictEqual(notificationKeys(s3).length, 0);
  const afterBad = parse(
    await call(
      storage,
      "GET",
      `/documents/projects/${projectId}/folders/${folderBId}`
    )
  );
  assert.strictEqual(afterBad.body.children.length, 0);

  const uploaded = parse(
    await call(
      storage,
      "POST",
      `/documents/projects/${projectId}/folders/${folderBId}/files`,
      {
        body: {
          description: "Kickoff pack",
          date: "2026-01-15",
          files: [pdf("Brief.pdf", "aaa"), pdf("Brief.pdf", "bbb")],
        },
      }
    )
  );
  assert.strictEqual(uploaded.status, 201);
  assert.strictEqual(uploaded.body.files.length, 2);
  assert.strictEqual(uploaded.body.files[0].name, "Brief.pdf");
  assert.strictEqual(uploaded.body.files[1].name, "Brief (1).pdf");
  assert.strictEqual(uploaded.body.files[0].uploadedAt, "2026-01-15");
  assert.strictEqual(uploaded.body.notification.fileCount, 2);
  assert.ok(String(uploaded.body.notification.folderPath).includes("Legal"));
  assert.ok(String(uploaded.body.notification.folderPath).includes("Contracts"));
  assert.strictEqual(notificationKeys(s3).length, 1);
  const event = JSON.parse(
    s3._objects.get(notificationKeys(s3)[0]).body.toString("utf8")
  );
  assert.strictEqual(event.fileCount, 2);
  assert.strictEqual(event.uploadedBy, "admin@mydgv.com");
  assert.strictEqual(event.projectId, projectId);

  let blobCalls = 0;
  const failingStorage = {
    ...storage,
    async putFileBlob(input) {
      blobCalls += 1;
      if (blobCalls === 2) throw new Error("S3 put failed");
      return storage.putFileBlob(input);
    },
  };
  const partial = parse(
    await call(
      failingStorage,
      "POST",
      `/documents/projects/${projectId}/files`,
      {
        body: {
          files: [pdf("one.pdf", "1"), pdf("two.pdf", "22")],
        },
      }
    )
  );
  assert.strictEqual(partial.status, 500);
  assert.strictEqual(notificationKeys(s3).length, 1);
  const rootAfterPartial = parse(
    await call(storage, "GET", `/documents/projects/${projectId}`)
  );
  assert.ok(
    !rootAfterPartial.body.children.some((c) => c.type === "file"),
    "partial batch must not update the manifest"
  );

  const renamedFolder = parse(
    await call(
      storage,
      "PATCH",
      `/documents/projects/${projectId}/folders/${folderAId}`,
      { body: { name: "Legal Team" } }
    )
  );
  assert.strictEqual(renamedFolder.status, 200);
  assert.strictEqual(renamedFolder.body.name, "Legal Team");

  const reservedRename = parse(
    await call(
      storage,
      "PATCH",
      `/documents/projects/${projectId}/folders/${folderAId}`,
      { body: { name: "Required Documents" } }
    )
  );
  assert.strictEqual(reservedRename.status, 400);

  const fileId = uploaded.body.files[0].fileId;
  const renamedFile = parse(
    await call(
      storage,
      "PATCH",
      `/documents/projects/${projectId}/folders/${folderBId}/files/${fileId}`,
      { body: { name: "Kickoff.pdf" } }
    )
  );
  assert.strictEqual(renamedFile.status, 200);
  assert.strictEqual(renamedFile.body.name, "Kickoff.pdf");

  const deletedFolder = parse(
    await call(
      storage,
      "DELETE",
      `/documents/projects/${projectId}/folders/${folderAId}`
    )
  );
  assert.strictEqual(deletedFolder.status, 200);
  assert.ok(deletedFolder.body.deleted.folders >= 2);
  assert.ok(deletedFolder.body.deleted.files >= 2);
  const goneNested = parse(
    await call(
      storage,
      "GET",
      `/documents/projects/${projectId}/folders/${folderBId}`
    )
  );
  assert.strictEqual(goneNested.status, 404);
  const rootAfterDelete = parse(
    await call(storage, "GET", `/documents/projects/${projectId}/folders`)
  );
  assert.ok(!rootAfterDelete.body.children.some((c) => c.id === folderAId));
  assert.strictEqual(notificationKeys(s3).length, 1);

  const renamedProject = parse(
    await call(storage, "PATCH", `/documents/projects/${projectId}`, {
      body: { name: "Q4 Archive" },
    })
  );
  assert.strictEqual(renamedProject.status, 200);
  assert.strictEqual(renamedProject.body.name, "Q4 Archive");

  const deletedProject = parse(
    await call(storage, "DELETE", `/documents/projects/${projectId}`)
  );
  assert.strictEqual(deletedProject.status, 200);
  const missing = parse(
    await call(storage, "GET", `/documents/projects/${projectId}`)
  );
  assert.strictEqual(missing.status, 404);
  const indexAfter = parse(await call(storage, "GET", "/documents/projects"));
  assert.ok(!indexAfter.body.projects.some((p) => p.projectId === projectId));

  console.log("projectsLogic tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

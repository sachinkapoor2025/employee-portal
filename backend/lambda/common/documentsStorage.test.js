const assert = require("assert");
const {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  ManifestConflictError,
  createDocumentsStorage,
  emptyManifest,
  projectRootKey,
  projectFolderKey,
  personalRootKey,
  personalFolderKey,
  fileBlobKey,
  childFolderKey,
  PROJECT_INDEX_KEY,
  readManifest,
  writeManifest,
  updateManifest,
  putFileBlob,
  deleteFolderTree,
  readProjectIndex,
  writeProjectIndex,
  updateProjectIndex,
} = require("./documentsStorage");

function createMemoryS3() {
  const objects = new Map();
  let seq = 0;

  function nextEtag() {
    seq += 1;
    return `"etag-${seq}"`;
  }

  function getObject(key) {
    return objects.get(key) || null;
  }

  async function send(command) {
    const input = command.input || {};
    const key = input.Key;

    if (command instanceof GetObjectCommand) {
      const obj = getObject(key);
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
      const existing = getObject(key);
      if (input.IfMatch) {
        if (!existing || existing.etag !== input.IfMatch) {
          const err = new Error("At least one of the pre-conditions you specified did not hold");
          err.name = "PreconditionFailed";
          err.$metadata = { httpStatusCode: 412 };
          throw err;
        }
      } else if (input.IfNoneMatch === "*" && existing) {
        const err = new Error("At least one of the pre-conditions you specified did not hold");
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

  return { send, _objects: objects, _get: getObject };
}

async function run() {
  const bucket = "test-documents-bucket";

  assert.strictEqual(projectRootKey("p1"), "manifests/projects/p1/root.json");
  assert.strictEqual(
    projectFolderKey("p1", "f1"),
    "manifests/projects/p1/folders/f1.json"
  );
  assert.strictEqual(
    personalRootKey("Ada@mydgv.com"),
    "manifests/personal/ada@mydgv.com/root.json"
  );
  assert.strictEqual(
    personalFolderKey("ada@mydgv.com", "req"),
    "manifests/personal/ada@mydgv.com/folders/req.json"
  );
  assert.strictEqual(fileBlobKey("file-1"), "files/file-1");
  assert.strictEqual(
    childFolderKey(projectRootKey("p1"), "f1"),
    projectFolderKey("p1", "f1")
  );
  assert.strictEqual(
    childFolderKey(projectFolderKey("p1", "f1"), "f2"),
    projectFolderKey("p1", "f2")
  );

  // --- Manifest read/write round-trip ---
  const s3 = createMemoryS3();
  const rootKey = projectRootKey("proj-alpha");
  const original = {
    id: "proj-alpha",
    name: "Alpha",
    children: [
      { id: "docs", type: "folder", name: "Docs" },
      {
        id: "file-row-1",
        type: "file",
        name: "Brief.pdf",
        fileId: "blob-1",
        size: 1200,
        uploadedBy: "admin@mydgv.com",
        uploadedAt: "2026-09-06T03:00:00.000Z",
        description: "Kickoff brief",
      },
    ],
  };

  const written = await writeManifest(s3, bucket, rootKey, original);
  assert.ok(written.etag);
  assert.strictEqual(written.manifest.name, "Alpha");

  const read = await readManifest(s3, bucket, rootKey);
  assert.ok(read);
  assert.strictEqual(read.etag, written.etag);
  assert.deepStrictEqual(read.manifest, {
    id: "proj-alpha",
    name: "Alpha",
    children: original.children,
  });
  assert.strictEqual(
    s3._get(rootKey).contentType,
    "application/json"
  );

  const missing = await readManifest(s3, bucket, projectRootKey("does-not-exist"));
  assert.strictEqual(missing, null);

  const personalKey = personalRootKey("nitesh.kumar@mydgv.com");
  await writeManifest(s3, bucket, personalKey, emptyManifest({ id: "root", name: "Personal" }));
  const personal = await readManifest(s3, bucket, personalKey);
  assert.strictEqual(personal.manifest.name, "Personal");
  assert.deepStrictEqual(personal.manifest.children, []);

  // --- Conditional write conflict handling ---
  await assert.rejects(
    () => writeManifest(s3, bucket, rootKey, { name: "clobber", children: [] }),
    (err) => err instanceof ManifestConflictError && err.code === "MANIFEST_CONFLICT"
  );

  await assert.rejects(
    () =>
      writeManifest(
        s3,
        bucket,
        rootKey,
        { name: "stale", children: [] },
        { etag: '"etag-stale"' }
      ),
    (err) => err instanceof ManifestConflictError
  );

  const updated = await writeManifest(
    s3,
    bucket,
    rootKey,
    {
      ...read.manifest,
      name: "Alpha Renamed",
    },
    { etag: read.etag }
  );
  assert.notStrictEqual(updated.etag, read.etag);
  assert.strictEqual(updated.manifest.name, "Alpha Renamed");

  let updaterCalls = 0;
  const conflicting = {
    async send(command) {
      if (command instanceof PutObjectCommand && command.input.IfMatch && updaterCalls === 1) {
        updaterCalls += 1;
        const err = new Error("precondition");
        err.name = "PreconditionFailed";
        err.$metadata = { httpStatusCode: 412 };
        throw err;
      }
      return s3.send(command);
    },
  };

  const retried = await updateManifest(conflicting, bucket, rootKey, (manifest) => {
    updaterCalls += 1;
    return {
      ...manifest,
      children: [
        ...manifest.children,
        { id: "legal", type: "folder", name: "Legal" },
      ],
    };
  });
  assert.ok(updaterCalls >= 3, "updater should re-run after conflict");
  assert.ok(retried.manifest.children.some((c) => c.id === "legal"));
  const afterRetry = await readManifest(s3, bucket, rootKey);
  assert.ok(afterRetry.manifest.children.some((c) => c.name === "Legal"));

  await assert.rejects(
    () =>
      updateManifest(
        {
          async send(command) {
            if (command instanceof PutObjectCommand) {
              const err = new Error("always conflict");
              err.name = "PreconditionFailed";
              err.$metadata = { httpStatusCode: 412 };
              throw err;
            }
            return s3.send(command);
          },
        },
        bucket,
        rootKey,
        (manifest) => manifest,
        { maxAttempts: 2 }
      ),
    (err) => err instanceof ManifestConflictError && err.attempts === 2
  );

  // --- File blob metadata ---
  const blob = await putFileBlob(s3, bucket, {
    fileId: "blob-nested",
    body: Buffer.from("hello-file"),
    contentType: "application/pdf",
    fileName: "Contract (final).pdf",
    uploadedBy: "admin@mydgv.com",
    uploadedAt: "2026-09-06T04:00:00.000Z",
    description: "Signed copy",
    size: 10,
  });
  assert.strictEqual(blob.key, "files/blob-nested");
  const storedBlob = s3._get(blob.key);
  assert.strictEqual(storedBlob.contentType, "application/pdf");
  assert.strictEqual(
    storedBlob.metadata.originalfilename,
    encodeURIComponent("Contract (final).pdf")
  );
  assert.strictEqual(
    storedBlob.metadata.uploadedby,
    encodeURIComponent("admin@mydgv.com")
  );
  assert.strictEqual(
    storedBlob.metadata.uploadedat,
    encodeURIComponent("2026-09-06T04:00:00.000Z")
  );
  assert.strictEqual(
    storedBlob.metadata.description,
    encodeURIComponent("Signed copy")
  );
  assert.strictEqual(storedBlob.metadata.size, encodeURIComponent("10"));
  assert.strictEqual(storedBlob.body.toString("utf8"), "hello-file");

  // --- Recursive delete ---
  const projectId = "proj-delete";
  const folderA = "folder-a";
  const folderB = "folder-b";
  await putFileBlob(s3, bucket, { fileId: "file-a1", body: "a1", fileName: "a1.pdf" });
  await putFileBlob(s3, bucket, { fileId: "file-b1", body: "b1", fileName: "b1.pdf" });
  await putFileBlob(s3, bucket, { fileId: "file-root", body: "root", fileName: "root.pdf" });
  await putFileBlob(s3, bucket, { fileId: "file-keep", body: "keep", fileName: "keep.pdf" });

  await writeManifest(s3, bucket, projectFolderKey(projectId, folderB), {
    id: folderB,
    name: "Nested",
    children: [
      { id: "row-b1", type: "file", name: "b1.pdf", fileId: "file-b1" },
    ],
  });
  await writeManifest(s3, bucket, projectFolderKey(projectId, folderA), {
    id: folderA,
    name: "Contracts",
    children: [
      { id: "row-a1", type: "file", name: "a1.pdf", fileId: "file-a1" },
      { id: folderB, type: "folder", name: "Nested" },
    ],
  });
  await writeManifest(s3, bucket, projectRootKey(projectId), {
    id: projectId,
    name: "Delete Me",
    children: [
      { id: folderA, type: "folder", name: "Contracts" },
      { id: "row-root", type: "file", name: "root.pdf", fileId: "file-root" },
    ],
  });

  const keepKey = projectRootKey("proj-keep");
  await writeManifest(s3, bucket, keepKey, {
    id: "proj-keep",
    name: "Keep",
    children: [{ id: "row-keep", type: "file", name: "keep.pdf", fileId: "file-keep" }],
  });

  const deleted = await deleteFolderTree(s3, bucket, projectRootKey(projectId));
  assert.deepStrictEqual(new Set(deleted.manifests), new Set([
    projectRootKey(projectId),
    projectFolderKey(projectId, folderA),
    projectFolderKey(projectId, folderB),
  ]));
  assert.deepStrictEqual(new Set(deleted.files), new Set([
    fileBlobKey("file-a1"),
    fileBlobKey("file-b1"),
    fileBlobKey("file-root"),
  ]));

  assert.strictEqual(await readManifest(s3, bucket, projectRootKey(projectId)), null);
  assert.strictEqual(await readManifest(s3, bucket, projectFolderKey(projectId, folderA)), null);
  assert.strictEqual(await readManifest(s3, bucket, projectFolderKey(projectId, folderB)), null);
  assert.ok(!s3._get(fileBlobKey("file-a1")));
  assert.ok(!s3._get(fileBlobKey("file-b1")));
  assert.ok(!s3._get(fileBlobKey("file-root")));
  assert.ok(s3._get(fileBlobKey("file-keep")));
  const kept = await readManifest(s3, bucket, keepKey);
  assert.strictEqual(kept.manifest.name, "Keep");

  const emptyDelete = await deleteFolderTree(s3, bucket, projectRootKey("already-gone"));
  assert.deepStrictEqual(emptyDelete, { manifests: [], files: [] });

  // --- Project index ---
  const emptyIndex = await readProjectIndex(s3, bucket);
  assert.deepStrictEqual(emptyIndex.projects, []);
  assert.strictEqual(emptyIndex.etag, null);

  const createdIndex = await writeProjectIndex(s3, bucket, [
    { projectId: "proj-alpha", name: "Alpha", createdAt: "2026-09-01T00:00:00.000Z" },
  ]);
  assert.strictEqual(createdIndex.projects.length, 1);
  assert.strictEqual(s3._get(PROJECT_INDEX_KEY).contentType, "application/json");

  const indexRead = await readProjectIndex(s3, bucket);
  assert.deepStrictEqual(indexRead.projects, createdIndex.projects);

  const indexUpdated = await updateProjectIndex(s3, bucket, (projects) => [
    ...projects,
    { projectId: "proj-beta", name: "Beta", createdAt: "2026-09-02T00:00:00.000Z" },
  ]);
  assert.strictEqual(indexUpdated.projects.length, 2);
  assert.strictEqual(indexUpdated.projects[1].name, "Beta");

  const bound = createDocumentsStorage({ s3, bucket });
  const boundRead = await bound.readProjectIndex();
  assert.strictEqual(boundRead.projects.length, 2);

  console.log("documentsStorage tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

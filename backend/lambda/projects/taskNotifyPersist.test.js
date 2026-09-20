const assert = require("assert");
const {
  TASK_COMPLETION_EMAIL_ATTRS,
  ASSIGNMENT_RED_NOTIFY_ATTRS,
  overlayStoredAttrs,
  putTaskCopiesSafe,
  putAssignmentSafe,
  assertPersistOk,
  PersistConflictError,
} = require("./taskNotifyPersist");

function conditionalFail() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

function createMemoryDdb() {
  const items = new Map();
  const puts = [];
  let failNextPut = 0;
  return {
    items,
    puts,
    failNextPuts(n) {
      failNextPut = n;
    },
    send: async (cmd) => {
      const input = cmd.input;
      if (input.Key && !input.Item) {
        return { Item: items.get(`${input.Key.PK}|${input.Key.SK}`) };
      }
      if (input.Item) {
        const key = `${input.Item.PK}|${input.Item.SK}`;
        const existing = items.get(key);
        const expr = String(input.ConditionExpression || "");
        if (failNextPut > 0) {
          failNextPut -= 1;
          throw conditionalFail();
        }
        if (expr.includes("attribute_not_exists(PK)") && existing) {
          throw conditionalFail();
        }
        if (expr.includes("#notifyStatus = :notifyStatus")) {
          const expected = input.ExpressionAttributeValues[":notifyStatus"];
          const statusName = input.ExpressionAttributeNames["#notifyStatus"];
          if ((existing?.[statusName] || null) !== expected) throw conditionalFail();
          if (expr.includes("#notifyClaimed = :notifyClaimed")) {
            const claimedName = input.ExpressionAttributeNames["#notifyClaimed"];
            const expectedClaimed = input.ExpressionAttributeValues[":notifyClaimed"];
            if ((existing?.[claimedName] || null) !== expectedClaimed) {
              throw conditionalFail();
            }
          }
        }
        if (
          expr.includes("attribute_not_exists(#notifyStatus)") &&
          existing?.[input.ExpressionAttributeNames["#notifyStatus"]]
        ) {
          throw conditionalFail();
        }
        puts.push(input.Item);
        items.set(key, { ...input.Item });
        return {};
      }
      return {};
    },
  };
}

async function run() {
  const overlaid = overlayStoredAttrs(
    { title: "new", completionEmailStatus: null, extra: 1 },
    {
      completionEmailStatus: "SENT",
      completionEmailClaimedAt: "t1",
      completionEmailError: "x",
      completionEmailRecipientCount: 2,
    },
    TASK_COMPLETION_EMAIL_ATTRS
  );
  assert.strictEqual(overlaid.title, "new");
  assert.strictEqual(overlaid.completionEmailStatus, "SENT");
  assert.strictEqual(overlaid.completionEmailClaimedAt, "t1");
  assert.strictEqual(overlaid.completionEmailError, "x");
  assert.strictEqual(overlaid.completionEmailRecipientCount, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(overlaid, "completionEmailUpdatedAt"));

  const tableName = "WorkTasksTable";
  const ddb = createMemoryDdb();
  const created = await putTaskCopiesSafe(ddb, tableName, {
    PK: "ENTITY#TASK",
    SK: "TASK#t1",
    taskId: "t1",
    title: "First",
    projectId: "p1",
  });
  assert.strictEqual(created.ok, true);
  assert.strictEqual(ddb.items.get("PROJECT#p1|TASK#t1").title, "First");

  ddb.items.set("ENTITY#TASK|TASK#t1", {
    PK: "ENTITY#TASK",
    SK: "TASK#t1",
    taskId: "t1",
    title: "First",
    projectId: "p1",
    completionEmailStatus: "SENT",
    completionEmailClaimedAt: "2026-09-20T10:00:00.000Z",
    completionEmailUpdatedAt: "2026-09-20T10:00:01.000Z",
    completionEmailError: null,
    completionEmailRecipientCount: 3,
  });
  ddb.items.set("PROJECT#p1|TASK#t1", {
    ...ddb.items.get("ENTITY#TASK|TASK#t1"),
    PK: "PROJECT#p1",
    SK: "TASK#t1",
  });

  const stale = await putTaskCopiesSafe(ddb, tableName, {
    PK: "ENTITY#TASK",
    SK: "TASK#t1",
    taskId: "t1",
    title: "Stale title",
    projectId: "p1",
    archived: true,
  });
  assert.strictEqual(stale.ok, true);
  const entity = ddb.items.get("ENTITY#TASK|TASK#t1");
  assert.strictEqual(entity.title, "Stale title");
  assert.strictEqual(entity.archived, true);
  assert.strictEqual(entity.completionEmailStatus, "SENT");
  assert.strictEqual(entity.completionEmailClaimedAt, "2026-09-20T10:00:00.000Z");
  assert.strictEqual(entity.completionEmailUpdatedAt, "2026-09-20T10:00:01.000Z");
  assert.strictEqual(entity.completionEmailRecipientCount, 3);
  const project = ddb.items.get("PROJECT#p1|TASK#t1");
  assert.strictEqual(project.completionEmailStatus, "SENT");
  assert.strictEqual(project.title, "Stale title");

  ddb.items.get("ENTITY#TASK|TASK#t1").completionEmailStatus = "SENDING";
  ddb.items.get("PROJECT#p1|TASK#t1").completionEmailStatus = "SENDING";
  const sending = await putTaskCopiesSafe(ddb, tableName, {
    PK: "ENTITY#TASK",
    SK: "TASK#t1",
    taskId: "t1",
    title: "During send",
    projectId: "p1",
    completionEmailStatus: null,
  });
  assert.strictEqual(sending.ok, true);
  assert.strictEqual(
    ddb.items.get("ENTITY#TASK|TASK#t1").completionEmailStatus,
    "SENDING"
  );

  const conflictDdb = createMemoryDdb();
  conflictDdb.items.set("ENTITY#TASK|TASK#t2", {
    PK: "ENTITY#TASK",
    SK: "TASK#t2",
    taskId: "t2",
    title: "old",
    completionEmailStatus: "SENDING",
    completionEmailClaimedAt: "c1",
  });
  conflictDdb.failNextPuts(1);
  const retried = await putTaskCopiesSafe(conflictDdb, tableName, {
    PK: "ENTITY#TASK",
    SK: "TASK#t2",
    taskId: "t2",
    title: "new",
  });
  assert.strictEqual(retried.ok, true);
  assert.strictEqual(conflictDdb.items.get("ENTITY#TASK|TASK#t2").title, "new");
  assert.strictEqual(
    conflictDdb.items.get("ENTITY#TASK|TASK#t2").completionEmailStatus,
    "SENDING"
  );

  const assignDdb = createMemoryDdb();
  const createdA = await putAssignmentSafe(assignDdb, tableName, {
    PK: "TASK#t1",
    SK: "ASSIGNMENT#a@mydgv.com",
    email: "a@mydgv.com",
    status: "TODO",
  });
  assert.strictEqual(createdA.ok, true);
  assignDdb.items.set("TASK#t1|ASSIGNMENT#a@mydgv.com", {
    PK: "TASK#t1",
    SK: "ASSIGNMENT#a@mydgv.com",
    email: "a@mydgv.com",
    status: "TODO",
    redAdminNotifyStatus: "SENDING",
    redAdminNotifyClaimedAt: "c-red",
    redAdminNotifyAttempts: 2,
    redAdminNotifyRecipients: {
      "admin@mydgv.com": { messageId: "m-1", notifiedAt: "n1" },
    },
  });
  const staleAssign = await putAssignmentSafe(assignDdb, tableName, {
    PK: "TASK#t1",
    SK: "ASSIGNMENT#a@mydgv.com",
    email: "a@mydgv.com",
    status: "IN_PROGRESS",
    redAdminNotifyStatus: null,
    redAdminNotifyRecipients: {},
    redAdminNotifyAttempts: 0,
  });
  assert.strictEqual(staleAssign.ok, true);
  const storedA = assignDdb.items.get("TASK#t1|ASSIGNMENT#a@mydgv.com");
  assert.strictEqual(storedA.status, "IN_PROGRESS");
  assert.strictEqual(storedA.redAdminNotifyStatus, "SENDING");
  assert.strictEqual(storedA.redAdminNotifyAttempts, 2);
  assert.strictEqual(storedA.redAdminNotifyRecipients["admin@mydgv.com"].messageId, "m-1");

  storedA.redAdminNotifyStatus = "SENT";
  storedA.redAdminNotifiedAt = "done";
  const staleSent = await putAssignmentSafe(assignDdb, tableName, {
    PK: "TASK#t1",
    SK: "ASSIGNMENT#a@mydgv.com",
    email: "a@mydgv.com",
    status: "REVIEW",
    redAdminNotifyStatus: "FAILED",
    redAdminNotifyRecipients: {},
  });
  assert.strictEqual(staleSent.ok, true);
  const afterSent = assignDdb.items.get("TASK#t1|ASSIGNMENT#a@mydgv.com");
  assert.strictEqual(afterSent.status, "REVIEW");
  assert.strictEqual(afterSent.redAdminNotifyStatus, "SENT");
  assert.strictEqual(afterSent.redAdminNotifyRecipients["admin@mydgv.com"].messageId, "m-1");
  const fs = require("fs");
  const confirmSrc = fs.readFileSync(require.resolve("./taskImportConfirm.js"), "utf8");
  const handlerSrc = fs.readFileSync(require.resolve("./handler.js"), "utf8");
  assert.ok(confirmSrc.includes("putAssignmentSafe"));
  assert.ok(confirmSrc.includes("putTaskCopiesSafe"));
  assert.ok(confirmSrc.includes("assertPersistOk"));
  assert.ok(handlerSrc.includes("putAssignmentSafe"));
  assert.ok(handlerSrc.includes("putTaskCopiesSafe"));
  assert.ok(handlerSrc.includes("assertPersistOk"));
  assert.ok(handlerSrc.includes("PersistConflictError"));
  assert.ok(handlerSrc.includes("json(err.statusCode || 409"));

  ddb.items.get("ENTITY#TASK|TASK#t1").completionEmailStatus = "FAILED";
  ddb.items.get("ENTITY#TASK|TASK#t1").completionEmailError = "SEND_FAILED";
  const failedKeep = await putTaskCopiesSafe(ddb, tableName, {
    PK: "ENTITY#TASK",
    SK: "TASK#t1",
    taskId: "t1",
    title: "After fail",
    projectId: "p1",
  });
  assert.strictEqual(failedKeep.ok, true);
  assert.strictEqual(ddb.items.get("ENTITY#TASK|TASK#t1").completionEmailStatus, "FAILED");
  assert.strictEqual(ddb.items.get("ENTITY#TASK|TASK#t1").completionEmailError, "SEND_FAILED");

  const conflictTwice = createMemoryDdb();
  conflictTwice.items.set("ENTITY#TASK|TASK#t3", {
    PK: "ENTITY#TASK",
    SK: "TASK#t3",
    taskId: "t3",
    title: "stored",
    completionEmailStatus: "SENT",
    completionEmailClaimedAt: "c-sent",
    completionEmailRecipientCount: 4,
  });
  conflictTwice.failNextPuts(2);
  const twoConflicts = await putTaskCopiesSafe(conflictTwice, tableName, {
    PK: "ENTITY#TASK",
    SK: "TASK#t3",
    taskId: "t3",
    title: "should-not-save",
  });
  assert.strictEqual(twoConflicts.ok, false);
  const stillSent = conflictTwice.items.get("ENTITY#TASK|TASK#t3");
  assert.strictEqual(stillSent.title, "stored");
  assert.strictEqual(stillSent.completionEmailStatus, "SENT");
  assert.strictEqual(stillSent.completionEmailRecipientCount, 4);

  assert.throws(
    () => assertPersistOk(twoConflicts, { op: "put", taskId: "t3" }),
    (err) => {
      assert.strictEqual(err.name, "PersistConflictError");
      assert.strictEqual(err.statusCode, 409);
      assert.ok(err.message.includes("could not be saved"));
      return true;
    }
  );

  function apiResult(persistResult, op) {
    try {
      assertPersistOk(persistResult, { op, taskId: "t3" });
      return { statusCode: 200, body: { title: "saved" } };
    } catch (err) {
      if (err instanceof PersistConflictError) {
        return { statusCode: err.statusCode, body: { error: err.message } };
      }
      throw err;
    }
  }
  assert.strictEqual(apiResult({ ok: true }, "put").statusCode, 200);
  assert.strictEqual(apiResult({ ok: true }, "archive").statusCode, 200);
  assert.strictEqual(apiResult(twoConflicts, "put").statusCode, 409);
  assert.notStrictEqual(apiResult(twoConflicts, "put").statusCode, 200);
  assert.strictEqual(apiResult(twoConflicts, "archive").statusCode, 409);
  assert.strictEqual(apiResult(twoConflicts, "writeAssignment").statusCode, 409);
  assert.strictEqual(apiResult(twoConflicts, "importTask").statusCode, 409);

  const assignFail = createMemoryDdb();
  assignFail.items.set("TASK#t3|ASSIGNMENT#a@mydgv.com", {
    PK: "TASK#t3",
    SK: "ASSIGNMENT#a@mydgv.com",
    status: "TODO",
    redAdminNotifyStatus: "SENDING",
    redAdminNotifyAttempts: 2,
    redAdminNotifyRecipients: { "admin@mydgv.com": { messageId: "keep" } },
  });
  assignFail.failNextPuts(2);
  const assignConflict = await putAssignmentSafe(assignFail, tableName, {
    PK: "TASK#t3",
    SK: "ASSIGNMENT#a@mydgv.com",
    status: "IN_PROGRESS",
    redAdminNotifyStatus: null,
  });
  assert.strictEqual(assignConflict.ok, false);
  const assignStored = assignFail.items.get("TASK#t3|ASSIGNMENT#a@mydgv.com");
  assert.strictEqual(assignStored.status, "TODO");
  assert.strictEqual(assignStored.redAdminNotifyStatus, "SENDING");
  assert.strictEqual(assignStored.redAdminNotifyRecipients["admin@mydgv.com"].messageId, "keep");

  console.log("task notify persist tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

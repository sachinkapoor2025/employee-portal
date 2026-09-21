const assert = require("assert");
const {
  notifyAdminsTaskEnteredRed,
  claimRedAdminNotify,
  finalizeRedAdminNotify,
  persistRedAdminRecipient,
  recipientHasMessageId,
  allIntendedRecipientsDelivered,
} = require("./redAdminNotify");
const { canClaimRedAdminStatus, needsRedAdminNotify } = require("./escalation");

function conditionalFail() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

function createClaimDdb() {
  const items = new Map();
  return {
    items,
    send: async (cmd) => {
      const input = cmd.input;
      if (input.Item) {
        const item = input.Item;
        const key = `${item.PK}|${item.SK}`;
        items.set(key, { ...item });
        return {};
      }
      if (input.Key && !input.UpdateExpression) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        return { Item: items.get(key) };
      }
      if (input.Key) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        const existing = items.get(key);
        if (!existing) throw conditionalFail();
        const expr = String(input.ConditionExpression || "");
        const update = String(input.UpdateExpression || "");
        if (update.includes("#claimed = :now") || update.includes("redAdminNotifyClaimedAt = :now")) {
          const nowIso = input.ExpressionAttributeValues[":now"];
          const nowMs = Date.parse(nowIso);
          if (
            !canClaimRedAdminStatus(
              existing.redAdminNotifyStatus,
              existing.redAdminNotifyClaimedAt,
              nowMs
            )
          ) {
            throw conditionalFail();
          }
          const next = { ...existing };
          if (next.redAdminNotifyRecipients) {
            next.redAdminNotifyRecipients = { ...next.redAdminNotifyRecipients };
          }
          next.redAdminNotifyStatus = "SENDING";
          next.redAdminNotifyClaimedAt = nowIso;
          next.redAdminNotifyAttempts = input.ExpressionAttributeValues[":attempts"];
          items.set(key, next);
          return { Attributes: next };
        }
        if (expr.includes("redAdminNotifyStatus = :sending")) {
          if (String(existing.redAdminNotifyStatus || "").toUpperCase() !== "SENDING") {
            throw conditionalFail();
          }
        }
        if (expr.includes("attribute_not_exists(redAdminNotifyRecipients.#addr.messageId)")) {
          const addr = input.ExpressionAttributeNames["#addr"];
          if (existing.redAdminNotifyRecipients?.[addr]?.messageId) {
            throw conditionalFail();
          }
        }
        const next = { ...existing };
        if (next.redAdminNotifyRecipients) {
          next.redAdminNotifyRecipients = { ...next.redAdminNotifyRecipients };
        }
        if (input.UpdateExpression.includes("redAdminNotifyStatus = :next")) {
          next.redAdminNotifyStatus = input.ExpressionAttributeValues[":next"];
          if (input.ExpressionAttributeValues[":notifiedAt"] && !next.redAdminNotifiedAt) {
            next.redAdminNotifiedAt = input.ExpressionAttributeValues[":notifiedAt"];
          }
        }
        if (input.ExpressionAttributeValues && input.ExpressionAttributeValues[":entry"]) {
          const addr = input.ExpressionAttributeNames["#addr"];
          next.redAdminNotifyRecipients = next.redAdminNotifyRecipients || {};
          next.redAdminNotifyRecipients[addr] = input.ExpressionAttributeValues[":entry"];
        }
        items.set(key, next);
        return { Attributes: next };
      }
      return {};
    },
  };
}

function seedAssignment(ddb, item) {
  const copy = { ...item };
  if (item.redAdminNotifyRecipients) {
    copy.redAdminNotifyRecipients = { ...item.redAdminNotifyRecipients };
  }
  ddb.items.set(`${item.PK}|${item.SK}`, copy);
}

function assignmentItem(status, recipients) {
  return {
    PK: "TASK#task-1",
    SK: "ASSIGNMENT#a@mydgv.com",
    type: "ASSIGNMENT",
    taskId: "task-1",
    email: "a@mydgv.com",
    status: "TODO",
    redAdminNotifyStatus: status || null,
    redAdminNotifyRecipients: recipients || {},
  };
}

const baseTask = {
  taskId: "task-1",
  title: "test",
  projectId: "p1",
  dueDate: "2026-09-05T15:15:00.000Z",
  description: "desc",
  priority: "HIGH",
};

function adminRows(emails) {
  return (emails || []).map((email) => ({
    email,
    role: "ADMIN",
    status: "ACTIVE",
  }));
}

function rowsList(emails) {
  const rows = adminRows(emails);
  return async () => rows;
}

async function run() {
  const calls = [];
  const status = await notifyAdminsTaskEnteredRed({
    task: baseTask,
    assignment: { email: "amit@mydgv.com", status: "TODO" },
    redAt: "2026-09-05T15:25:00.000Z",
    listAccessRows: rowsList(["admin@mydgv.com"]),
    getAssigneeProfile: async () => ({ name: "Amit Sharma" }),
    getProjectName: async () => "Sample Project",
    sendEmail: async (opts) => {
      calls.push(opts);
      return { ok: true, messageId: "ses-1" };
    },
  });
  assert.strictEqual(status, "SENT");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].to, "admin@mydgv.com");
  assert.strictEqual(calls[0].from, "noreply@mydgv.com");
  assert.ok(calls[0].subject.includes("Task Entered Red Zone"));
  assert.ok(calls[0].text.includes("Amit Sharma"));
  assert.ok(calls[0].text.includes("amit@mydgv.com"));
  assert.ok(calls[0].html);

  const empty = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-2", title: "x" },
    assignment: { email: "a@mydgv.com", status: "TODO" },
    listAccessRows: async () => [],
    sendEmail: async () => ({ ok: true, messageId: "x" }),
  });
  assert.strictEqual(empty, "SENT");

  const onlySelf = [];
  const onlySelfStatus = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-2b", title: "x" },
    assignment: { email: "admin@mydgv.com", status: "TODO" },
    listAccessRows: rowsList(["admin@mydgv.com"]),
    sendEmail: async (opts) => {
      onlySelf.push(opts.to);
      return { ok: true, messageId: "x" };
    },
  });
  assert.strictEqual(onlySelfStatus, "SENT");
  assert.deepStrictEqual(onlySelf, []);

  const failed = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-3", title: "x" },
    assignment: { email: "a@mydgv.com", status: "TODO" },
    listAccessRows: rowsList(["admin@mydgv.com"]),
    sendEmail: async () => ({ ok: false, error: "MessageRejected" }),
  });
  assert.strictEqual(failed, "FAILED");

  const tableName = "WorkTasksTable";
  const nowIso = "2026-09-11T10:00:00.000Z";
  const nowMs = Date.parse(nowIso);

  const ddb1 = createClaimDdb();
  seedAssignment(ddb1, assignmentItem(null));
  const first = await claimRedAdminNotify(ddb1, {
    tableName,
    item: assignmentItem(null),
    nowIso,
    nowMs,
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.item.redAdminNotifyStatus, "SENDING");

  const second = await claimRedAdminNotify(ddb1, {
    tableName,
    item: assignmentItem(null),
    nowIso,
    nowMs,
  });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, "ALREADY_CLAIMED");

  const savedAdmin = await persistRedAdminRecipient(ddb1, {
    tableName,
    key: { PK: "TASK#task-1", SK: "ASSIGNMENT#a@mydgv.com" },
    email: "admin@mydgv.com",
    messageId: "ses-admin-1",
    notifiedAt: nowIso,
  });
  assert.strictEqual(savedAdmin.ok, true);
  assert.ok(
    recipientHasMessageId(
      ddb1.items.get("TASK#task-1|ASSIGNMENT#a@mydgv.com").redAdminNotifyRecipients,
      "admin@mydgv.com"
    )
  );

  const sent = await finalizeRedAdminNotify(ddb1, {
    tableName,
    item: first.item,
    status: "SENT",
    nowIso,
  });
  assert.strictEqual(sent.ok, true);
  assert.strictEqual(sent.status, "SENT");
  assert.ok(sent.item.redAdminNotifiedAt);
  const stored = ddb1.items.get("TASK#task-1|ASSIGNMENT#a@mydgv.com");
  assert.strictEqual(stored.redAdminNotifyStatus, "SENT");
  assert.ok(stored.redAdminNotifyRecipients["admin@mydgv.com"].messageId);

  const afterSent = await claimRedAdminNotify(ddb1, {
    tableName,
    item: assignmentItem("SENT"),
    nowIso: "2026-09-12T10:00:00.000Z",
    nowMs: Date.parse("2026-09-12T10:00:00.000Z"),
  });
  assert.strictEqual(afterSent.ok, false);
  assert.strictEqual(stored.redAdminNotifyStatus, "SENT");

  const failDdb = createClaimDdb();
  seedAssignment(failDdb, assignmentItem(null));
  const failClaim = await claimRedAdminNotify(failDdb, {
    tableName,
    item: assignmentItem(null),
    nowIso,
    nowMs,
  });
  assert.strictEqual(failClaim.ok, true);
  const failedFinalize = await finalizeRedAdminNotify(failDdb, {
    tableName,
    item: failClaim.item,
    status: "FAILED",
    nowIso,
  });
  assert.strictEqual(failedFinalize.ok, true);
  assert.strictEqual(failedFinalize.status, "FAILED");
  assert.strictEqual(
    failDdb.items.get("TASK#task-1|ASSIGNMENT#a@mydgv.com").redAdminNotifyStatus,
    "FAILED"
  );
  const retry = await claimRedAdminNotify(failDdb, {
    tableName,
    item: failDdb.items.get("TASK#task-1|ASSIGNMENT#a@mydgv.com"),
    nowIso: "2026-09-11T10:01:00.000Z",
    nowMs: Date.parse("2026-09-11T10:01:00.000Z"),
  });
  assert.strictEqual(retry.ok, true);

  const raceDdb = createClaimDdb();
  const item = assignmentItem(null);
  seedAssignment(raceDdb, item);
  const [left, right] = await Promise.all([
    claimRedAdminNotify(raceDdb, { tableName, item, nowIso, nowMs }),
    claimRedAdminNotify(raceDdb, { tableName, item, nowIso, nowMs }),
  ]);
  const winners = [left, right].filter((r) => r.ok);
  assert.strictEqual(winners.length, 1);
  assert.strictEqual(
    raceDdb.items.get("TASK#task-1|ASSIGNMENT#a@mydgv.com").redAdminNotifyStatus,
    "SENDING"
  );

  const noMessageId = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-4", title: "x" },
    assignment: { email: "a@mydgv.com", status: "TODO" },
    listAccessRows: rowsList(["admin@mydgv.com"]),
    sendEmail: async () => ({ ok: true, messageId: "" }),
  });
  assert.strictEqual(noMessageId, "FAILED");

  const persisted = {};
  const firstSweep = [];
  const admins = [
    "a@mydgv.com",
    "b@mydgv.com",
    "c@mydgv.com",
    "d@mydgv.com",
    "e@mydgv.com",
  ];
  const firstStatus = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-5", title: "Partial" },
    assignment: { email: "doer@mydgv.com", status: "TODO" },
    listAccessRows: rowsList(admins),
    existingRecipients: persisted,
    persistRecipient: async (email, entry) => {
      persisted[email] = entry;
    },
    sendEmail: async (opts) => {
      firstSweep.push(opts.to);
      if (opts.to === "c@mydgv.com") return { ok: false, error: "MessageRejected" };
      return { ok: true, messageId: `ses-${opts.to}` };
    },
  });
  assert.strictEqual(firstStatus, "FAILED");
  assert.deepStrictEqual(firstSweep, admins);
  assert.ok(persisted["a@mydgv.com"].messageId);
  assert.ok(persisted["b@mydgv.com"].messageId);
  assert.ok(!persisted["c@mydgv.com"]);
  assert.ok(persisted["d@mydgv.com"].messageId);
  assert.ok(persisted["e@mydgv.com"].messageId);
  assert.strictEqual(
    allIntendedRecipientsDelivered(persisted, admins),
    false
  );

  const secondSweep = [];
  const retryStatus = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-5", title: "Partial" },
    assignment: { email: "doer@mydgv.com", status: "TODO" },
    listAccessRows: rowsList(admins),
    existingRecipients: persisted,
    persistRecipient: async (email, entry) => {
      persisted[email] = entry;
    },
    sendEmail: async (opts) => {
      secondSweep.push(opts.to);
      return { ok: true, messageId: `ses-${opts.to}` };
    },
  });
  assert.deepStrictEqual(secondSweep, ["c@mydgv.com"]);
  assert.strictEqual(retryStatus, "SENT");
  assert.ok(persisted["c@mydgv.com"].messageId);
  assert.strictEqual(allIntendedRecipientsDelivered(persisted, admins), true);

  const thirdSweep = [];
  const sentAgain = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-5", title: "Partial" },
    assignment: {
      email: "doer@mydgv.com",
      status: "TODO",
      redAdminNotifyRecipients: persisted,
    },
    listAccessRows: rowsList(admins),
    existingRecipients: persisted,
    sendEmail: async (opts) => {
      thirdSweep.push(opts.to);
      return { ok: true, messageId: "dup" };
    },
  });
  assert.deepStrictEqual(thirdSweep, []);
  assert.strictEqual(sentAgain, "SENT");

  assert.strictEqual(
    needsRedAdminNotify(
      { dueDate: baseTask.dueDate },
      { email: "doer@mydgv.com", status: "DONE", redAdminNotifyStatus: "FAILED" },
      true
    ),
    false
  );
  assert.strictEqual(
    needsRedAdminNotify(
      { dueDate: baseTask.dueDate },
      { email: "doer@mydgv.com", status: "CANCELLED" },
      true
    ),
    false
  );

  const aRecipients = { "admin@mydgv.com": { messageId: "a-1", notifiedAt: nowIso } };
  const bRecipients = {};
  assert.ok(recipientHasMessageId(aRecipients, "admin@mydgv.com"));
  assert.ok(!recipientHasMessageId(bRecipients, "admin@mydgv.com"));

  const skipOne = [];
  const skipStatus = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-6", title: "Once" },
    assignment: { email: "doer@mydgv.com", status: "TODO" },
    listAccessRows: rowsList(["admin@mydgv.com"]),
    existingRecipients: {
      "admin@mydgv.com": { messageId: "already", notifiedAt: nowIso },
    },
    sendEmail: async (opts) => {
      skipOne.push(opts.to);
      return { ok: true, messageId: "dup" };
    },
  });
  assert.strictEqual(skipStatus, "SENT");
  assert.deepStrictEqual(skipOne, []);

  process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";
  const mixedRecipients = [];
  const mixedStatus = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-7", title: `Alert <script>x</script>` },
    assignment: { email: "admin@mydgv.com", status: "TODO" },
    adminEmails: [
      "lead@mydgv.com",
      "blocked-admin@mydgv.com",
      "admin@mydgv.com",
      "super@mydgv.com",
    ],
    listAccessRows: async () => [
      { email: "admin@mydgv.com", role: "ADMIN", status: "ACTIVE" },
      { email: "super@mydgv.com", role: "SUPER_ADMIN", status: "ACTIVE" },
      { email: "SUPER@mydgv.com", role: "SUPER_ADMIN", status: "ACTIVE" },
      { email: "lead@mydgv.com", role: "MANAGER", status: "ACTIVE" },
      { email: "blocked-admin@mydgv.com", role: "ADMIN", status: "BLOCKED" },
      { email: "", role: "ADMIN", status: "ACTIVE" },
      { email: "not-an-email", role: "ADMIN", status: "ACTIVE" },
    ],
    sendEmail: async (opts) => {
      mixedRecipients.push(opts);
      return { ok: true, messageId: `ses-${opts.to}` };
    },
  });
  assert.strictEqual(mixedStatus, "SENT");
  assert.deepStrictEqual(
    mixedRecipients.map((item) => item.to),
    ["super@mydgv.com"]
  );
  assert.ok(!mixedRecipients.map((item) => item.to).includes("lead@mydgv.com"));
  assert.ok(!mixedRecipients.map((item) => item.to).includes("blocked-admin@mydgv.com"));
  assert.ok(!mixedRecipients.map((item) => item.to).includes("admin@mydgv.com"));
  assert.ok(!mixedRecipients[0].html.includes("<script>"));
  assert.ok(mixedRecipients[0].html.includes("&lt;script&gt;"));
  assert.strictEqual(mixedRecipients[0].from, "noreply@mydgv.com");

  const emptyAccess = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-8", title: "x" },
    assignment: { email: "doer@mydgv.com", status: "TODO" },
    listAccessRows: async () => [],
    sendEmail: async () => {
      throw new Error("should not send");
    },
  });
  assert.strictEqual(emptyAccess, "SENT");

  const lookupThrows = await notifyAdminsTaskEnteredRed({
    task: { taskId: "task-9", title: "x" },
    assignment: { email: "doer@mydgv.com", status: "TODO" },
    listAccessRows: async () => {
      throw new Error("scan failed");
    },
    sendEmail: async () => {
      throw new Error("should not send");
    },
  });
  assert.strictEqual(lookupThrows, "FAILED");

  const ddbAttempts = createClaimDdb();
  seedAssignment(ddbAttempts, assignmentItem(null));
  const claimedOnce = await claimRedAdminNotify(ddbAttempts, {
    tableName,
    item: assignmentItem(null),
    nowIso,
    nowMs,
  });
  assert.strictEqual(claimedOnce.item.redAdminNotifyAttempts, 1);

  const wipeDdb = createClaimDdb();
  seedAssignment(wipeDdb, {
    ...assignmentItem("FAILED", {
      "admin@mydgv.com": { messageId: "keep-ses", notifiedAt: nowIso },
    }),
    status: "IN_PROGRESS",
    highestZone: "RED",
    assignedBy: "lead@mydgv.com",
    redAdminNotifyAttempts: 2,
  });
  const staleSnap = assignmentItem("FAILED");
  staleSnap.status = "TODO";
  staleSnap.redAdminNotifyRecipients = {};
  staleSnap.redAdminNotifyAttempts = 0;
  const wipeClaim = await claimRedAdminNotify(wipeDdb, {
    tableName,
    item: staleSnap,
    nowIso,
    nowMs,
  });
  assert.strictEqual(wipeClaim.ok, true);
  const kept = wipeDdb.items.get("TASK#task-1|ASSIGNMENT#a@mydgv.com");
  assert.strictEqual(kept.status, "IN_PROGRESS");
  assert.strictEqual(kept.highestZone, "RED");
  assert.strictEqual(kept.assignedBy, "lead@mydgv.com");
  assert.strictEqual(kept.redAdminNotifyRecipients["admin@mydgv.com"].messageId, "keep-ses");
  assert.strictEqual(kept.redAdminNotifyAttempts, 3);
  assert.strictEqual(
    wipeClaim.item.redAdminNotifyRecipients["admin@mydgv.com"].messageId,
    "keep-ses"
  );

  const sentProtect = createClaimDdb();
  seedAssignment(
    sentProtect,
    assignmentItem("SENT", { "admin@mydgv.com": { messageId: "sent-id", notifiedAt: nowIso } })
  );
  const sentClaim = await claimRedAdminNotify(sentProtect, {
    tableName,
    item: assignmentItem("FAILED"),
    nowIso: "2026-09-12T10:00:00.000Z",
    nowMs: Date.parse("2026-09-12T10:00:00.000Z"),
  });
  assert.strictEqual(sentClaim.ok, false);
  const sentStored = sentProtect.items.get("TASK#task-1|ASSIGNMENT#a@mydgv.com");
  assert.strictEqual(sentStored.redAdminNotifyStatus, "SENT");
  assert.strictEqual(sentStored.redAdminNotifyRecipients["admin@mydgv.com"].messageId, "sent-id");

  assert.strictEqual(
    needsRedAdminNotify(
      { dueDate: baseTask.dueDate },
      {
        email: "doer@mydgv.com",
        status: "TODO",
        redAdminNotifyStatus: "FAILED",
        redAdminNotifyAttempts: 5,
      },
      true
    ),
    false
  );
  assert.strictEqual(
    needsRedAdminNotify(
      { dueDate: baseTask.dueDate },
      {
        email: "doer@mydgv.com",
        status: "TODO",
        redAdminNotifyStatus: "FAILED",
        redAdminNotifyAttempts: 4,
      },
      true
    ),
    true
  );

  const redSrc = require("fs").readFileSync(require.resolve("./redAdminNotify.js"), "utf8");
  assert.ok(!redSrc.includes("PutCommand"));
  assert.ok(redSrc.includes("UpdateCommand"));
  assert.ok(redSrc.includes("attribute_exists(PK)"));

  const handlerSrc = require("fs").readFileSync(require.resolve("./handler.js"), "utf8");
  assert.ok(handlerSrc.includes("notifyAdminsTaskEnteredRed"));
  assert.ok(handlerSrc.includes("claimRedAdminNotify"));
  assert.ok(handlerSrc.includes("listAccessRows"));
  assert.ok(handlerSrc.includes("putTaskCopiesSafe"));
  assert.ok(handlerSrc.includes("activeCompletionAdminEmailsFromAccess"));
  assert.ok(handlerSrc.includes("PersistConflictError"));
  assert.ok(handlerSrc.includes("json(err.statusCode || 409"));
  assert.ok(!handlerSrc.includes("preserveNotify"));
  assert.ok(!handlerSrc.includes("TASK_DUE_SOON"));
  console.log("red admin notify tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

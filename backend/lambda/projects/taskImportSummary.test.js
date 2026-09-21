const assert = require("assert");
const { activeSuperAdminEmailsFromAccess, activeAdminEmailsFromAccess } = require("../common/roles");
const {
  buildSummaryEmail,
  countModes,
  escapeHtml,
  notifyFromAddress,
  safeFileName,
} = require("./taskImportSummary");

process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";

assert.strictEqual(notifyFromAddress(), "noreply@mydgv.com");

assert.deepStrictEqual(
  countModes([
    { assignmentMode: "IMMEDIATE" },
    { assignmentMode: "SCHEDULED" },
    { assignmentMode: "IMMEDIATE" },
  ]),
  { totalCount: 3, immediateCount: 2, scheduledCount: 1 }
);

assert.strictEqual(safeFileName("<script>x.xlsx"), "scriptx.xlsx");
assert.strictEqual(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");

const copy = buildSummaryEmail({
  fileName: `Report <img src=x onerror=alert(1)>.xlsx`,
  uploaderName: `Jane "Admin"`,
  uploaderEmail: "jane@mydgv.com",
  batchId: "batch-1",
  totalCount: 2,
  immediateCount: 1,
  scheduledCount: 1,
  portalUrl: "https://login.mydgv.com/admin/task-imports/batch-1",
});
assert.ok(copy.subject.startsWith("Excel Task Import Completed"));
assert.ok(!copy.subject.includes("<img"));
assert.ok(!copy.html.includes("<img src=x"));
assert.ok(copy.html.includes("Jane &quot;Admin&quot;"));
assert.ok(!/Task title/.test(copy.text));

const admins = activeAdminEmailsFromAccess([
  { email: "super@mydgv.com", status: "ACTIVE", role: "SUPER_ADMIN" },
  { email: "admin@mydgv.com", status: "ACTIVE", role: "ADMIN" },
  { email: "mgr@mydgv.com", status: "ACTIVE", role: "MANAGER" },
]);
const supers = activeSuperAdminEmailsFromAccess([
  { email: "super@mydgv.com", status: "ACTIVE", role: "SUPER_ADMIN" },
  { email: "admin@mydgv.com", status: "ACTIVE", role: "ADMIN" },
  { email: "mgr@mydgv.com", status: "ACTIVE", role: "MANAGER" },
  { email: "old@mydgv.com", status: "BLOCKED", role: "SUPER_ADMIN" },
]);
assert.ok(admins.includes("admin@mydgv.com"));
assert.deepStrictEqual(supers, ["super@mydgv.com"]);

const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const fs = require("fs");
const {
  claimSummaryEmail,
  finalizeSummaryEmail,
  SUMMARY_SENT,
} = require("./taskImportSummary");
const { notifyFromName, DEFAULT_FROM } = require("./notifyFrom");
const { isConditionalCheckFailed } = require("./taskNotifyPersist");

assert.strictEqual(DEFAULT_FROM, "noreply@mydgv.com");
assert.strictEqual(notifyFromName(), "DGV Portal");
{
  const previous = process.env.TASK_NOTIFY_FROM_EMAIL;
  process.env.TASK_NOTIFY_FROM_EMAIL = "  ";
  assert.strictEqual(notifyFromAddress(), DEFAULT_FROM);
  process.env.TASK_NOTIFY_FROM_EMAIL = "  custom-sender@mydgv.com  ";
  assert.strictEqual(notifyFromAddress(), "custom-sender@mydgv.com");
  process.env.TASK_NOTIFY_FROM_EMAIL = previous;
}
assert.strictEqual(typeof isConditionalCheckFailed, "function");

const summarySrc = fs.readFileSync(require.resolve("./taskImportSummary.js"), "utf8");
const redSrc = fs.readFileSync(require.resolve("./redAdminNotify.js"), "utf8");
const completeSrc = fs.readFileSync(require.resolve("./taskCompleteNotify.js"), "utf8");
const assignSrc = fs.readFileSync(require.resolve("./taskImportAssignNotify.js"), "utf8");
assert.ok(!summarySrc.includes('require("./redAdminNotify")'));
assert.ok(!redSrc.includes('require("./taskImportSummary")'));
assert.ok(summarySrc.includes('require("./taskNotifyPersist")'));
assert.ok(summarySrc.includes('require("./notifyFrom")'));
assert.ok(redSrc.includes('require("./notifyFrom")'));
assert.ok(completeSrc.includes('require("./taskNotifyPersist")'));
assert.ok(completeSrc.includes('require("./notifyFrom")'));
assert.ok(assignSrc.includes('require("./notifyFrom")'));
assert.ok(!completeSrc.includes('require("./redAdminNotify")'));
assert.ok(!assignSrc.includes('require("./taskImportSummary")'));
assert.ok(!completeSrc.includes('require("./taskImportSummary")'));

function conditionalFail() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

function bust(id) {
  try {
    delete require.cache[require.resolve(id)];
  } catch {
    /* missing optional */
  }
}

function bustNotifyGraph() {
  [
    "./taskImportSummary",
    "./redAdminNotify",
    "./notifyFrom",
    "./taskNotifyPersist",
    "./taskCompleteNotify",
    "./taskImportAssignNotify",
    "./handler",
  ].forEach(bust);
}

async function claimConflictAfter(firstModule) {
  bustNotifyGraph();
  require(firstModule);
  const loaded = require("./taskImportSummary");
  assert.strictEqual(typeof loaded.claimSummaryEmail, "function");
  const persist = require("./taskNotifyPersist");
  assert.strictEqual(typeof persist.isConditionalCheckFailed, "function");
  const ddb = {
    send: async () => {
      throw conditionalFail();
    },
  };
  let threw = null;
  let result;
  try {
    result = await loaded.claimSummaryEmail(
      ddb,
      "WorkTasksTable",
      "batch-cycle",
      "2026-09-20T12:00:00.000Z",
      Date.parse("2026-09-20T12:00:00.000Z")
    );
  } catch (err) {
    threw = err;
  }
  assert.strictEqual(threw, null, threw && threw.stack);
  assert.deepStrictEqual(result, { ok: false, reason: "ALREADY_CLAIMED" });
}

async function run() {
  await claimConflictAfter("./taskImportSummary");
  await claimConflictAfter("./redAdminNotify");
  await claimConflictAfter("./handler");

  const okDdb = {
    send: async (cmd) => {
      assert.ok(cmd instanceof UpdateCommand);
      const values = cmd.input.ExpressionAttributeValues || {};
      const nextStatus = values[":next"] ? values[":next"] : "SENDING";
      return {
        Attributes: {
          status: "COMPLETED",
          summaryEmailStatus: nextStatus,
        },
      };
    },
  };
  const claimed = await claimSummaryEmail(
    okDdb,
    "WorkTasksTable",
    "batch-ok",
    "2026-09-20T12:00:00.000Z",
    Date.parse("2026-09-20T12:00:00.000Z")
  );
  assert.strictEqual(claimed.ok, true);
  assert.strictEqual(claimed.meta.summaryEmailStatus, "SENDING");

  const finalized = await finalizeSummaryEmail(
    okDdb,
    "WorkTasksTable",
    "batch-ok",
    SUMMARY_SENT,
    { nowIso: "2026-09-20T12:00:01.000Z" }
  );
  assert.strictEqual(finalized.ok, true);
  assert.strictEqual(finalized.meta.summaryEmailStatus, SUMMARY_SENT);

  const {
    sendCompletedImportSummaryEmail,
    claimSummaryEmail: claimSummaryFresh,
    EMAIL_CLAIM_MAX_ATTEMPTS,
    SUMMARY_FAILED,
    SUMMARY_SKIPPED,
    SUMMARY_SENDING,
  } = require("./taskImportSummary");
  const { IMPORT_STATUSES, META_SK, importPk } = require("./taskImport");
  assert.strictEqual(EMAIL_CLAIM_MAX_ATTEMPTS, 5);

  function createSummaryStore(overrides = {}) {
    const store = {
      PK: importPk("batch-retry"),
      SK: META_SK,
      status: IMPORT_STATUSES.COMPLETED,
      fileName: "a.xlsx",
      uploadedBy: "admin@mydgv.com",
      ...overrides,
    };
    return {
      store,
      send: async (cmd) => {
        assert.ok(cmd instanceof UpdateCommand);
        const values = cmd.input.ExpressionAttributeValues || {};
        const update = String(cmd.input.UpdateExpression || "");
        if (update.includes("ADD") || (values[":sending"] && !values[":next"])) {
          const status = store.summaryEmailStatus;
          const claimedAt = store.summaryEmailClaimedAt;
          const attempts = Number(store.summaryEmailAttempts || 0);
          const staleOk =
            status === "SENDING" &&
            claimedAt &&
            String(claimedAt) < String(values[":stale"]);
          const can =
            store.status === IMPORT_STATUSES.COMPLETED &&
            (!status ||
              status === SUMMARY_FAILED ||
              staleOk) &&
            attempts < Number(values[":maxAttempts"]);
          if (!can) throw conditionalFail();
          store.summaryEmailStatus = SUMMARY_SENDING;
          store.summaryEmailClaimedAt = values[":now"];
          store.summaryEmailAttempts = attempts + 1;
          store.updatedAt = values[":now"];
          return { Attributes: { ...store } };
        }
        if (store.summaryEmailStatus !== SUMMARY_SENDING) throw conditionalFail();
        store.summaryEmailStatus = values[":next"];
        store.summaryEmailUpdatedAt = values[":now"];
        if (values[":error"]) store.summaryEmailError = values[":error"];
        if (values[":count"] != null) store.summaryEmailRecipientCount = values[":count"];
        return { Attributes: { ...store } };
      },
    };
  }

  const superRows = async () => [
    { email: "super@mydgv.com", status: "ACTIVE", role: "SUPER_ADMIN" },
    { email: "admin@mydgv.com", status: "ACTIVE", role: "ADMIN" },
    { email: "mgr@mydgv.com", status: "ACTIVE", role: "MANAGER" },
  ];

  const failedStore = createSummaryStore({
    summaryEmailStatus: SUMMARY_FAILED,
    summaryEmailAttempts: 1,
  });
  const summaryRetry = await sendCompletedImportSummaryEmail({
    ddb: failedStore,
    tableName: "WorkTasksTable",
    batchId: "batch-retry",
    tasks: [{ assignmentMode: "IMMEDIATE" }],
    now: "2026-09-20T12:00:00.000Z",
    nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
    listAccessRows: superRows,
    sendEmailFn: async ({ to }) => {
      assert.strictEqual(to, "super@mydgv.com");
      return { ok: true, messageId: "ses-retry" };
    },
  });
  assert.strictEqual(summaryRetry.status, "SENT");
  assert.strictEqual(failedStore.store.summaryEmailStatus, "SENT");
  assert.strictEqual(failedStore.store.summaryEmailAttempts, 2);

  const sentStore = createSummaryStore({ summaryEmailStatus: "SENT", summaryEmailAttempts: 1 });
  const sentSkip = await sendCompletedImportSummaryEmail({
    ddb: sentStore,
    tableName: "WorkTasksTable",
    batchId: "batch-retry",
    listAccessRows: superRows,
    sendEmailFn: async () => {
      throw new Error("should not send");
    },
  });
  assert.strictEqual(sentSkip.skipped, true);
  assert.strictEqual(sentStore.store.summaryEmailStatus, "SENT");

  const sendingStore = createSummaryStore({
    summaryEmailStatus: SUMMARY_SENDING,
    summaryEmailClaimedAt: "2026-09-20T12:00:00.000Z",
    summaryEmailAttempts: 1,
  });
  const fresh = await sendCompletedImportSummaryEmail({
    ddb: sendingStore,
    tableName: "WorkTasksTable",
    batchId: "batch-retry",
    now: "2026-09-20T12:01:00.000Z",
    nowMs: Date.parse("2026-09-20T12:01:00.000Z"),
    listAccessRows: superRows,
    sendEmailFn: async () => {
      throw new Error("should not send");
    },
  });
  assert.strictEqual(fresh.skipped, true);
  assert.strictEqual(sendingStore.store.summaryEmailStatus, SUMMARY_SENDING);

  const staleStore = createSummaryStore({
    summaryEmailStatus: SUMMARY_SENDING,
    summaryEmailClaimedAt: "2026-09-20T11:00:00.000Z",
    summaryEmailAttempts: 1,
  });
  const staleSummary = await sendCompletedImportSummaryEmail({
    ddb: staleStore,
    tableName: "WorkTasksTable",
    batchId: "batch-retry",
    now: "2026-09-20T12:00:00.000Z",
    nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
    listAccessRows: superRows,
    sendEmailFn: async () => ({ ok: true, messageId: "ses-stale" }),
  });
  assert.strictEqual(staleSummary.status, "SENT");

  const skipStore = createSummaryStore({
    summaryEmailStatus: SUMMARY_SKIPPED,
    summaryEmailAttempts: 1,
  });
  const skipStay = await sendCompletedImportSummaryEmail({
    ddb: skipStore,
    tableName: "WorkTasksTable",
    batchId: "batch-retry",
    listAccessRows: superRows,
    sendEmailFn: async () => {
      throw new Error("should not send");
    },
  });
  assert.strictEqual(skipStay.skipped, true);
  assert.strictEqual(skipStore.store.summaryEmailStatus, SUMMARY_SKIPPED);

  const capStore = createSummaryStore({
    summaryEmailStatus: SUMMARY_FAILED,
    summaryEmailAttempts: EMAIL_CLAIM_MAX_ATTEMPTS,
  });
  const cap = await sendCompletedImportSummaryEmail({
    ddb: capStore,
    tableName: "WorkTasksTable",
    batchId: "batch-retry",
    listAccessRows: superRows,
    sendEmailFn: async () => {
      throw new Error("should not send");
    },
  });
  assert.strictEqual(cap.skipped, true);
  assert.strictEqual(capStore.store.summaryEmailStatus, SUMMARY_FAILED);

  const failAgain = createSummaryStore({
    summaryEmailStatus: SUMMARY_FAILED,
    summaryEmailAttempts: 1,
  });
  const stillFailed = await sendCompletedImportSummaryEmail({
    ddb: failAgain,
    tableName: "WorkTasksTable",
    batchId: "batch-retry",
    listAccessRows: superRows,
    sendEmailFn: async () => ({ ok: false, error: "MessageRejected" }),
  });
  assert.strictEqual(stillFailed.status, "FAILED");
  assert.strictEqual(failAgain.store.summaryEmailStatus, "FAILED");
  assert.ok(failAgain.store.summaryEmailAttempts < EMAIL_CLAIM_MAX_ATTEMPTS);

  const raceStore = createSummaryStore();
  const [sLeft, sRight] = await Promise.all([
    sendCompletedImportSummaryEmail({
      ddb: raceStore,
      tableName: "WorkTasksTable",
      batchId: "batch-retry",
      listAccessRows: superRows,
      sendEmailFn: async () => ({ ok: true, messageId: "ses-race" }),
    }),
    sendCompletedImportSummaryEmail({
      ddb: raceStore,
      tableName: "WorkTasksTable",
      batchId: "batch-retry",
      listAccessRows: superRows,
      sendEmailFn: async () => ({ ok: true, messageId: "ses-race" }),
    }),
  ]);
  const summaryWins = [sLeft, sRight].filter((row) => !row.skipped);
  assert.strictEqual(summaryWins.length, 1);
  assert.ok([sLeft, sRight].some((row) => row.reason === "ALREADY_CLAIMED"));

  const failedClaim = await claimSummaryFresh(
    createSummaryStore({
      summaryEmailStatus: SUMMARY_FAILED,
      summaryEmailAttempts: 2,
    }),
    "WorkTasksTable",
    "batch-retry",
    "2026-09-20T12:00:00.000Z",
    Date.parse("2026-09-20T12:00:00.000Z")
  );
  assert.strictEqual(failedClaim.ok, true);
  assert.strictEqual(failedClaim.meta.summaryEmailStatus, SUMMARY_SENDING);

  console.log("taskImportSummary tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});


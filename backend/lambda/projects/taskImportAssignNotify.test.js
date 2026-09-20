const assert = require("assert");
const {
  assignedNotifyKey,
  assignedEmailKey,
  adminAssignedNotifyKey,
  adminAssignedEmailKey,
  getAccessRow,
  isActiveAccess,
  AccessLookupError,
} = require("./taskImportAssignNotify");

assert.strictEqual(
  assignedNotifyKey("task-1", "Rahul@mydgv.com"),
  "task-1#rahul@mydgv.com#assigned"
);
assert.notStrictEqual(
  assignedEmailKey("task-1", "rahul@mydgv.com"),
  assignedNotifyKey("task-1", "rahul@mydgv.com")
);
assert.ok(
  adminAssignedNotifyKey("task-1", "rahul@mydgv.com", "super@mydgv.com").includes(
    "admin#super@mydgv.com"
  )
);
assert.notStrictEqual(
  adminAssignedEmailKey("task-1", "rahul@mydgv.com", "super@mydgv.com"),
  adminAssignedNotifyKey("task-1", "rahul@mydgv.com", "super@mydgv.com")
);

async function runAccessLookup() {
  const found = await getAccessRow(
    {
      send: async () => ({ Item: { email: "a@mydgv.com", status: "ACTIVE" } }),
    },
    "access",
    "a@mydgv.com"
  );
  assert.strictEqual(isActiveAccess(found), true);

  const missing = await getAccessRow(
    { send: async () => ({ Item: undefined }) },
    "access",
    "gone@mydgv.com"
  );
  assert.strictEqual(missing, null);
  assert.strictEqual(isActiveAccess(missing), false);
  assert.strictEqual(isActiveAccess({ status: "BLOCKED" }), false);

  await assert.rejects(
    () =>
      getAccessRow(
        {
          send: async () => {
            const err = new Error("boom");
            err.name = "ProvisionedThroughputExceededException";
            throw err;
          },
        },
        "access",
        "a@mydgv.com"
      ),
    (err) => {
      assert.strictEqual(err.name, "AccessLookupError");
      assert.strictEqual(err.retryable, true);
      assert.ok(err instanceof AccessLookupError);
      return true;
    }
  );

  await assert.rejects(
    () =>
      getAccessRow(null, null, "a@mydgv.com"),
    (err) => err instanceof AccessLookupError
  );

  console.log("taskImportAssignNotify tests passed");
}

runAccessLookup().catch((err) => {
  console.error(err);
  process.exit(1);
});

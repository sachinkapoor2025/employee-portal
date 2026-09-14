const assert = require("assert");
const {
  collectBlockedNewAssignees,
  newAssignmentEmails,
  isBlockedAccessStatus,
} = require("./handler");

assert.strictEqual(isBlockedAccessStatus("BLOCKED"), true);
assert.strictEqual(isBlockedAccessStatus("ACTIVE"), false);
assert.strictEqual(isBlockedAccessStatus("PENDING"), false);

assert.deepStrictEqual(
  newAssignmentEmails(
    ["new@mydgv.com", "keep@mydgv.com"],
    ["keep@mydgv.com"]
  ),
  ["new@mydgv.com"]
);

{
  const blocked = collectBlockedNewAssignees(
    ["blocked@mydgv.com", "active@mydgv.com"],
    [],
    {
      "blocked@mydgv.com": "BLOCKED",
      "active@mydgv.com": "ACTIVE",
    }
  );
  assert.deepStrictEqual(blocked, ["blocked@mydgv.com"]);
}

{
  const blocked = collectBlockedNewAssignees(
    ["active@mydgv.com"],
    [],
    { "active@mydgv.com": "ACTIVE" }
  );
  assert.deepStrictEqual(blocked, []);
}

{
  const blocked = collectBlockedNewAssignees(
    ["blocked@mydgv.com", "peer@mydgv.com"],
    ["blocked@mydgv.com"],
    {
      "blocked@mydgv.com": "BLOCKED",
      "peer@mydgv.com": "ACTIVE",
    }
  );
  assert.deepStrictEqual(blocked, []);
}

console.log("blocked assignee validation tests passed");

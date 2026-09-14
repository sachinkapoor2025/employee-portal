const assert = require("assert");
const {
  resolveAccess,
  requestAccessForExistingItem,
} = require("./handler");

function user(email, isAdmin) {
  return { email, isAdmin, groups: isAdmin ? ["Admin"] : ["Employee"] };
}

function record(status, role) {
  return {
    status: { S: status },
    role: { S: role },
  };
}

{
  const blocked = record("BLOCKED", "EMPLOYEE");
  const resolved = resolveAccess(user("pat@mydgv.com", false), blocked);
  assert.strictEqual(resolved.access, "BLOCKED");
  const decision = requestAccessForExistingItem(
    user("pat@mydgv.com", false),
    blocked
  );
  assert.strictEqual(decision.mutate, false);
  assert.strictEqual(decision.body.access, "BLOCKED");
  assert.notStrictEqual(decision.body.access, "PENDING");
}

{
  const active = record("ACTIVE", "EMPLOYEE");
  const resolved = resolveAccess(user("pat@mydgv.com", false), active);
  assert.strictEqual(resolved.access, "USER");
  const decision = requestAccessForExistingItem(
    user("pat@mydgv.com", false),
    active
  );
  assert.strictEqual(decision.mutate, false);
  assert.strictEqual(decision.body.access, "USER");
}

{
  const pending = record("PENDING", "EMPLOYEE");
  const decision = requestAccessForExistingItem(
    user("pat@mydgv.com", false),
    pending
  );
  assert.strictEqual(decision.mutate, false);
  assert.strictEqual(decision.body.access, "PENDING");
}

{
  const missingStatus = { role: { S: "EMPLOYEE" } };
  const decision = requestAccessForExistingItem(
    user("pat@mydgv.com", false),
    missingStatus
  );
  assert.strictEqual(decision.mutate, true);
  assert.strictEqual(decision.body.access, "PENDING");
}

console.log("access request-access blocked tests passed");

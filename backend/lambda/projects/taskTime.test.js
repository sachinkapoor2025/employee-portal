const assert = require("assert");
const {
  parseRequiredHours,
  parseOptionalHours,
  assignmentPlanLocked,
  HOURS_INVALID,
} = require("./taskTime");

assert.strictEqual(parseRequiredHours("").ok, false);
assert.strictEqual(parseRequiredHours(null).ok, false);
assert.strictEqual(parseRequiredHours(0).ok, false);
assert.strictEqual(parseRequiredHours(-1).ok, false);
assert.strictEqual(parseRequiredHours("abc").ok, false);
assert.strictEqual(parseRequiredHours(NaN).ok, false);
assert.strictEqual(parseRequiredHours(Infinity).ok, false);
assert.strictEqual(parseRequiredHours("1.5").value, 1.5);
assert.strictEqual(parseRequiredHours(2).value, 2);
assert.strictEqual(parseRequiredHours("2.25").value, 2.25);
assert.strictEqual(parseRequiredHours(2.5).value, 2.5);
assert.strictEqual(parseRequiredHours(24.5).value, 24.5);
assert.strictEqual(parseRequiredHours(100).value, 100);
assert.strictEqual(parseRequiredHours(0).error, HOURS_INVALID);

assert.strictEqual(parseOptionalHours(null).ok, true);
assert.strictEqual(parseOptionalHours(null).value, null);
assert.strictEqual(parseOptionalHours("").value, null);
assert.strictEqual(parseOptionalHours("  ").value, null);
assert.strictEqual(parseOptionalHours(2.5).value, 2.5);
assert.strictEqual(parseOptionalHours(24.5).value, 24.5);
assert.strictEqual(parseOptionalHours(0).ok, false);
assert.strictEqual(parseOptionalHours("abc").ok, false);

assert.strictEqual(assignmentPlanLocked({ status: "TODO" }), false);
assert.strictEqual(assignmentPlanLocked({ status: "BACKLOG" }), false);
assert.strictEqual(assignmentPlanLocked({ status: "IN_PROGRESS" }), true);

console.log("taskTime tests passed");

const assert = require("assert");
const {
  ESTIMATED_HOURS_INVALID,
  parseEstimatedHours,
} = require("./estimatedHours");

function ok(value) {
  return { ok: true, value };
}

assert.deepStrictEqual(parseEstimatedHours(null), ok(null));
assert.deepStrictEqual(parseEstimatedHours(undefined), ok(null));
assert.deepStrictEqual(parseEstimatedHours(""), ok(null));
assert.deepStrictEqual(parseEstimatedHours("   "), ok(null));
assert.deepStrictEqual(parseEstimatedHours(1.5), ok(1.5));
assert.deepStrictEqual(parseEstimatedHours("1.5"), ok(1.5));
assert.deepStrictEqual(parseEstimatedHours("2.25"), ok(2.25));
assert.deepStrictEqual(parseEstimatedHours(2), ok(2));
assert.deepStrictEqual(parseEstimatedHours("2"), ok(2));
assert.deepStrictEqual(parseEstimatedHours("1.234"), ok(1.23));
assert.strictEqual(parseEstimatedHours(0).ok, false);
assert.strictEqual(parseEstimatedHours("0").ok, false);
assert.strictEqual(parseEstimatedHours(-1).ok, false);
assert.strictEqual(parseEstimatedHours("-1").ok, false);
assert.strictEqual(parseEstimatedHours("abc").ok, false);
assert.strictEqual(parseEstimatedHours("1.5h").ok, false);
assert.strictEqual(parseEstimatedHours("1e2").ok, false);
assert.strictEqual(parseEstimatedHours(NaN).ok, false);
assert.strictEqual(parseEstimatedHours(Infinity).ok, false);
assert.strictEqual(parseEstimatedHours(0).error, ESTIMATED_HOURS_INVALID);
console.log("estimatedHours tests passed");

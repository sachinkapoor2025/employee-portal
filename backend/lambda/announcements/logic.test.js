const assert = require("assert");
const logic = require("./logic");

const now = Date.parse("2026-08-25T12:00:00.000Z");

assert.strictEqual(
  logic.announcementStatus({ expiresAt: "2026-08-25T11:59:00.000Z" }, now),
  "EXPIRED"
);
assert.strictEqual(
  logic.announcementStatus({ expiresAt: "2026-08-25T13:00:00.000Z" }, now),
  "ACTIVE"
);
assert.strictEqual(logic.announcementStatus({}, now), "NO_EXPIRY");
assert.strictEqual(logic.isPubliclyVisible({ expiresAt: "2026-08-25T11:59:00.000Z" }, now), false);
assert.strictEqual(logic.isPubliclyVisible({ expiresAt: "2026-08-25T13:00:00.000Z" }, now), true);
assert.strictEqual(logic.isPubliclyVisible({ active: false, expiresAt: "2026-08-25T13:00:00.000Z" }, now), false);
assert.ok(logic.isPubliclyVisible({ title: "legacy" }, now));

assert.strictEqual(logic.withAnnouncementStatus({ expiresAt: null }, now).status, "NO_EXPIRY");

assert.strictEqual(logic.displayNameFromEmail("nitesh.kumar@mydgv.com"), "Nitesh Kumar");
assert.strictEqual(
  logic.resolveAuthorName({
    profileName: "Nitesh Kumar",
    claimsName: "Nitesh",
    email: "nitesh.kumar@mydgv.com",
  }),
  "Nitesh Kumar"
);
assert.strictEqual(
  logic.resolveAuthorName({ email: "nitesh.kumar@mydgv.com" }),
  "Nitesh Kumar"
);
assert.strictEqual(
  logic.withAnnouncementStatus({ createdBy: "nitesh.kumar@mydgv.com" }, now)
    .createdByName,
  "Nitesh Kumar"
);
assert.strictEqual(
  logic.withAnnouncementStatus(
    { createdBy: "nitesh.kumar@mydgv.com", createdByName: "Nitesh Kumar" },
    now
  ).createdByName,
  "Nitesh Kumar"
);

console.log("announcement logic tests passed");

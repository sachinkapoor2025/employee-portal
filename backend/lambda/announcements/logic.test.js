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

assert.strictEqual(logic.displayNameFromEmail("rahul.verma@mydgv.com"), "Rahul Verma");
assert.strictEqual(
  logic.resolveAuthorName({
    profileName: "Rahul Verma",
    claimsName: "Rahul",
    email: "rahul.verma@mydgv.com",
  }),
  "Rahul Verma"
);
assert.strictEqual(
  logic.resolveAuthorName({ email: "rahul.verma@mydgv.com" }),
  "Rahul Verma"
);
assert.strictEqual(
  logic.withAnnouncementStatus({ createdBy: "rahul.verma@mydgv.com" }, now)
    .createdByName,
  "Rahul Verma"
);
assert.strictEqual(
  logic.withAnnouncementStatus(
    { createdBy: "rahul.verma@mydgv.com", createdByName: "Rahul Verma" },
    now
  ).createdByName,
  "Rahul Verma"
);

console.log("announcement logic tests passed");

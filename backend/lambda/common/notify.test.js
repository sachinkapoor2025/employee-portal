const assert = require("assert");
const { parseFrom } = require("./email");
const { shouldSkip, reminderKey, MAX_ATTEMPTS } = require("./notify");

assert.deepStrictEqual(parseFrom("noreply@mydgv.com"), {
  name: "DGV Portal",
  address: "noreply@mydgv.com",
});
assert.strictEqual(
  parseFrom("DGV Portal <noreply@mydgv.com>").address,
  "noreply@mydgv.com"
);

assert.strictEqual(reminderKey("ATTENDANCE_MISSED", "2026-08-10"), "REMINDER#ATTENDANCE_MISSED#2026-08-10");

assert.strictEqual(shouldSkip(null, 0, Date.now()), false);
assert.strictEqual(
  shouldSkip({ status: "SENT", sentAt: new Date().toISOString() }, 0, Date.now()),
  true
);
assert.strictEqual(
  shouldSkip(
    { status: "SENT", sentAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() },
    7 * 24 * 60 * 60 * 1000,
    Date.now()
  ),
  false
);
assert.strictEqual(
  shouldSkip({ status: "FAILED", attempts: MAX_ATTEMPTS }, 0, Date.now()),
  true
);
assert.strictEqual(
  shouldSkip({ status: "FAILED", attempts: 1 }, 0, Date.now()),
  false
);

process.env.NOTIFICATION_FROM_EMAIL = "";
const { sendEmail } = require("./email");
sendEmail({ to: "a@mydgv.com", subject: "t", text: "t" }).then((res) => {
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "EMAIL_CONFIG_MISSING");
  console.log("notify helper tests passed");
});

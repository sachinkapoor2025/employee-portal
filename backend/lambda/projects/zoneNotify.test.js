const assert = require("assert");
const { zoneNotifyCopy, formatWhen } = require("./zoneNotify");

const orange = zoneNotifyCopy({
  orange: true,
  title: "Prepare Monthly Report",
  deadline: "2026-08-25T11:30:00.000Z",
  zoneStartedAt: "2026-08-25T11:30:00.000Z",
  timeZone: "Asia/Kolkata",
});
assert.strictEqual(orange.type, "TASK_ORANGE");
assert.strictEqual(orange.category, "TASK_MOVED_TO_ORANGE");
assert.ok(orange.title.includes("Orange Zone"));
assert.ok(orange.message.includes("Prepare Monthly Report"));
assert.ok(orange.message.includes("Orange Zone started"));
assert.ok(!orange.message.toLowerCase().includes("red zone"));

const red = zoneNotifyCopy({
  orange: false,
  title: "Prepare Monthly Report",
  deadline: "2026-08-25T11:30:00.000Z",
  zoneStartedAt: "2026-08-26T11:30:00.000Z",
  timeZone: "Asia/Kolkata",
});
assert.strictEqual(red.type, "TASK_RED");
assert.strictEqual(red.category, "TASK_MOVED_TO_RED");
assert.ok(red.title.includes("Red Zone"));
assert.ok(red.message.includes("24-hour"));
assert.ok(red.message.includes("Red Zone started"));

assert.ok(formatWhen("2026-08-25T11:30:00.000Z", "Asia/Kolkata").includes("2026"));

console.log("zone notify tests passed");

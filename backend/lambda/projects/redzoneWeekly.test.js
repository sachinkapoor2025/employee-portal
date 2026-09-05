const assert = require("assert");
const escalation = require("./escalation");
const weekly = require("./redzoneWeekly");

const now = Date.parse("2026-08-25T12:00:00.000Z");
const redDue = new Date(now - 26 * 60 * 60 * 1000).toISOString();
const orangeDue = new Date(now - 2 * 60 * 60 * 1000).toISOString();
const greenDue = new Date(now + 6 * 60 * 60 * 1000).toISOString();

const redTask = {
  taskId: "11111111-1111-1111-1111-111111111111",
  title: "Update Website",
  description: "Fix homepage banner",
  priority: "HIGH",
  status: "TODO",
  dueDate: redDue,
  createdAt: "2026-08-20T04:30:00.000Z",
  assignments: [
    { email: "amit@mydgv.com", status: "TODO" },
    { email: "rahul@mydgv.com", status: "DONE", completedAt: "2026-08-24T10:00:00.000Z" },
    { email: "priya@mydgv.com", status: "TODO" },
  ],
};

const orangeTask = {
  taskId: "22222222-2222-2222-2222-222222222222",
  title: "Orange only",
  dueDate: orangeDue,
  assignments: [{ email: "amit@mydgv.com", status: "TODO" }],
};

const greenTask = {
  taskId: "33333333-3333-3333-3333-333333333333",
  title: "Still green",
  dueDate: greenDue,
  assignments: [{ email: "amit@mydgv.com", status: "TODO" }],
};

const rows = weekly.collectRedZoneRows([redTask, orangeTask, greenTask], now);
assert.strictEqual(rows.length, 2, "only incomplete red assignments");
assert.ok(rows.every((r) => r.assignment.email !== "rahul@mydgv.com"));
assert.ok(rows.every((r) => r.assignment.zone === escalation.ZONES.RED));

const profiles = weekly.indexProfiles([
  { email: "amit@mydgv.com", name: "Amit Sharma", groupLead: "lead@mydgv.com" },
  { email: "priya@mydgv.com", name: "Priya Singh", manager: "Lead Name" },
  { email: "lead@mydgv.com", name: "Lead Name" },
  { PK: "USER#dgv@mydgv.com", name: "DGV" },
]);
assert.strictEqual(
  weekly.resolveTeamLeadEmail(profiles.byEmail["amit@mydgv.com"], profiles),
  "lead@mydgv.com"
);
assert.strictEqual(
  weekly.resolveTeamLeadEmail(profiles.byEmail["priya@mydgv.com"], profiles),
  "lead@mydgv.com"
);

const enriched = weekly.enrichRows(rows, profiles, now);
const amitRecipients = weekly.recipientsForRow(
  enriched.find((r) => r.assigneeEmail === "amit@mydgv.com")
);
assert.deepStrictEqual(amitRecipients, [
  "amit@mydgv.com",
  "lead@mydgv.com",
  "dgv@mydgv.com",
]);

const grouped = weekly.groupByRecipient(enriched);
assert.ok(grouped["amit@mydgv.com"].length === 1);
assert.ok(grouped["priya@mydgv.com"].length === 1);
assert.ok(grouped["lead@mydgv.com"].length === 2, "lead gets both red assignments");
assert.ok(grouped["dgv@mydgv.com"].length === 2);
assert.ok(!grouped["rahul@mydgv.com"]);

const emptyGroup = weekly.groupByRecipient([]);
assert.deepStrictEqual(Object.keys(emptyGroup), ["dgv@mydgv.com"]);
assert.strictEqual(emptyGroup["dgv@mydgv.com"].length, 0);

const html = weekly.buildReportHtml(enriched, "dgv@mydgv.com");
assert.ok(html.includes("Weekly Red-Zone Ticket Report"));
assert.ok(html.includes("2"));
assert.ok(html.includes("Update Website"));
assert.ok(html.includes("Red Zone"));

const emptyHtml = weekly.buildReportHtml([], "dgv@mydgv.com");
assert.ok(emptyHtml.toLowerCase().includes("no red-zone"));

const mondayMorning = new Date("2026-08-24T03:40:00.000Z"); // 09:10 IST
const mondayEarly = new Date("2026-08-24T03:00:00.000Z"); // 08:30 IST
const tuesday = new Date("2026-08-25T03:40:00.000Z");
assert.strictEqual(weekly.normalizeConfig({}).enabled, false);
assert.strictEqual(weekly.normalizeConfig({}).dgvEmail, "dgv@mydgv.com");
const cfg = weekly.normalizeConfig({ enabled: true, weekday: 1, sendTime: "09:00" });
assert.strictEqual(weekly.shouldSendNow(cfg, mondayMorning, "Asia/Kolkata"), true);
assert.strictEqual(weekly.shouldSendNow(cfg, mondayEarly, "Asia/Kolkata"), false);
assert.strictEqual(weekly.shouldSendNow(cfg, tuesday, "Asia/Kolkata"), false);
assert.strictEqual(
  weekly.shouldSendNow({ ...cfg, enabled: false }, mondayMorning, "Asia/Kolkata"),
  false
);

const weekId = weekly.weekIdFor(mondayMorning, "Asia/Kolkata", 1);
assert.strictEqual(weekId, "2026-08-24");
assert.strictEqual(weekly.weekIdFor(tuesday, "Asia/Kolkata", 1), "2026-08-24");

assert.strictEqual(weekly.alreadySent({ status: "SENT" }), true);
assert.strictEqual(weekly.canRetry({ status: "FAILED" }), true);
assert.deepStrictEqual(
  weekly.emailsToSend(
    { "a@mydgv.com": [], "b@mydgv.com": [] },
    {
      status: "PARTIAL",
      results: [
        { email: "a@mydgv.com", status: "SENT" },
        { email: "b@mydgv.com", status: "FAILED" },
      ],
    }
  ),
  ["b@mydgv.com"]
);

assert.ok(weekly.uniqueEmails(["A@mydgv.com", "a@mydgv.com", "dgv@mydgv.com"]).length === 2);

console.log("redzone weekly tests passed");

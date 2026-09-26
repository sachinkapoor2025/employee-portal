const assert = require("assert");
const {
  buildProfessionalEmail,
  escapeHtml,
  EMAIL_VARIANTS,
} = require("./emailLayout");
const { redAdminNotifyCopy } = require("../projects/zoneNotify");

const html = buildProfessionalEmail({
  variant: "info",
  title: "Task assigned",
  intro: "A new task is ready for you.",
  sections: [
    {
      heading: "TASK DETAILS",
      rows: [
        { label: "Task", value: "Homepage Update" },
        { label: "Project", value: "Client Website" },
      ],
    },
  ],
  cta: { href: "https://login.mydgv.com/work/task-1", label: "View Task" },
  footer: "This is an automated message from DGV Portal.",
});

assert.ok(html.includes("Task assigned"), "required title renders");
assert.ok(html.includes("A new task is ready for you."), "intro renders");
assert.ok(html.includes("TASK DETAILS"), "section heading renders");
assert.ok(html.includes("Homepage Update"), "section values render");
assert.ok(html.includes("Client Website"), "section values render");
assert.ok(html.includes("View Task"), "CTA label renders");
assert.ok(
  html.includes('href="https://login.mydgv.com/work/task-1"'),
  "CTA href renders"
);
assert.ok(html.includes("This is an automated message from DGV Portal."), "footer renders");

const omitted = buildProfessionalEmail({
  variant: "info",
  title: "Leave update",
  intro: "Your request was updated.",
  sections: [{ heading: "EMPTY", rows: [{ label: "Skip", value: "" }] }],
});
assert.ok(!omitted.includes("EMPTY"), "empty optional sections are omitted");
assert.ok(!omitted.includes("View Task"), "CTA omitted when not provided");
assert.ok(!omitted.includes("automated message"), "footer omitted when not provided");
assert.ok(!omitted.includes("Skip"), "empty row values are omitted");

assert.strictEqual(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");

const injected = buildProfessionalEmail({
  title: '<img src=x onerror="alert(1)">',
  intro: "Hello <b>there</b>",
  sections: [
    {
      heading: "DETAILS",
      rows: [{ label: "Note", value: "A & B" }],
    },
  ],
  cta: {
    href: 'https://login.mydgv.com/?q="><script>',
    label: 'Open <portal>',
  },
  footer: "Footer <script>",
});
assert.ok(!injected.includes("<script>"), "dynamic HTML is escaped");
assert.ok(!injected.includes("<img src=x"));
assert.ok(injected.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
assert.ok(injected.includes("Hello &lt;b&gt;there&lt;/b&gt;"));
assert.ok(injected.includes("A &amp; B"));
assert.ok(injected.includes("Open &lt;portal&gt;"));
assert.ok(injected.includes("Footer &lt;script&gt;"));
assert.ok(injected.includes("&quot;&gt;&lt;script&gt;"));

const redThroughLayout = buildProfessionalEmail({
  variant: "urgent",
  title: "🔴 TASK ENTERED RED ZONE",
  intro:
    "A task assignment has remained incomplete for 24-hour after its original deadline and has now entered the Red Zone.",
  sections: [
    {
      heading: "TASK DETAILS",
      rows: [
        { label: "Task", value: "Website Homepage Update" },
        { label: "Assigned To", value: "Priya Yadav" },
      ],
    },
    {
      heading: "ACTION REQUIRED",
      body: "This assignment has not been completed within the required deadline. Please review the task and take the necessary action.",
    },
  ],
  cta: {
    href: "https://login.mydgv.com/admin/tasks/task-1",
    label: "VIEW TASK",
  },
});
assert.ok(redThroughLayout.includes("🔴 TASK ENTERED RED ZONE"));
assert.ok(redThroughLayout.includes("background:#991b1b"));
assert.ok(redThroughLayout.includes("border:1px solid #fecaca"));
assert.ok(redThroughLayout.includes("VIEW TASK"));
assert.ok(redThroughLayout.includes("Website Homepage Update"));
assert.ok(
  redThroughLayout.includes("https://login.mydgv.com/admin/tasks/task-1")
);
assert.ok(!redThroughLayout.includes("PK#"));
assert.ok(!redThroughLayout.includes("SK#"));

const emptyish = buildProfessionalEmail({
  variant: null,
  title: undefined,
  intro: null,
  sections: [null, { heading: undefined, rows: [{ label: null, value: undefined }] }],
  alert: { heading: null, body: "" },
  cta: { href: null, label: undefined },
  footer: undefined,
  brand: null,
});
assert.ok(!emptyish.includes(">undefined<"), "null/undefined do not render as text");
assert.ok(!emptyish.includes(">null<"), "null/undefined do not render as text");
assert.ok(!emptyish.includes("undefined<"));
assert.ok(!emptyish.includes("null<"));
assert.ok(emptyish.includes("font-family:Arial,sans-serif"));
assert.ok(emptyish.includes("<h1 style=\"margin:0;font-size:20px\"></h1>"));

assert.ok(EMAIL_VARIANTS.urgent);
assert.ok(EMAIL_VARIANTS.success);
assert.ok(EMAIL_VARIANTS.warning);
assert.ok(EMAIL_VARIANTS.info);
assert.ok(EMAIL_VARIANTS.alert);

const warning = buildProfessionalEmail({ variant: "warning", title: "Warning" });
assert.ok(warning.includes("background:#b45309"));
const success = buildProfessionalEmail({ variant: "success", title: "Done" });
assert.ok(success.includes("background:#047857"));
const alertMail = buildProfessionalEmail({
  variant: "alert",
  title: "Ops",
  alert: { heading: "Note", body: "Please review." },
});
assert.ok(alertMail.includes("background:#1e3a5f"));
assert.ok(alertMail.includes("Please review."));

const adminCopy = redAdminNotifyCopy({
  employeeName: "Priya Yadav",
  employeeEmail: "priya.yadav@mydgv.com",
  title: "Website Homepage Update",
  projectName: "Client Website",
  status: "IN_PROGRESS",
  deadline: "2026-08-31T10:30:00.000Z",
  redZoneStartedAt: "2026-09-01T10:30:00.000Z",
  overdueLabel: "1 day",
  priority: "High",
  description: "Update homepage banner and CTA.",
  viewTaskUrl: "https://login.mydgv.com/admin/tasks/task-1",
  timeZone: "Asia/Kolkata",
});
assert.strictEqual(
  adminCopy.subject,
  "🔴 Task Entered Red Zone – Action Required: Website Homepage Update"
);
assert.strictEqual(adminCopy.type, "TASK_RED_ADMIN");
assert.ok(adminCopy.html.includes("font-family:Arial,sans-serif"));
assert.ok(adminCopy.html.includes("background:#991b1b"));
assert.ok(adminCopy.html.includes("🔴 TASK ENTERED RED ZONE"));
assert.ok(adminCopy.html.includes("TASK DETAILS"));
assert.ok(adminCopy.html.includes("ACTION REQUIRED"));
assert.ok(adminCopy.html.includes("VIEW TASK"));
assert.ok(adminCopy.html.includes("Priya Yadav"));
assert.ok(!adminCopy.html.includes("PK#"));
assert.ok(!adminCopy.html.includes("SK#"));
assert.ok(
  adminCopy.message.includes("A task assignment has remained incomplete")
);

const xssCopy = redAdminNotifyCopy({
  employeeName: "<script>x</script>",
  title: 'Task "One"',
  status: "TODO",
  deadline: "2026-08-31T10:30:00.000Z",
  viewTaskUrl: "https://login.mydgv.com/admin/tasks/ab&c",
  timeZone: "Asia/Kolkata",
});
assert.ok(xssCopy.html.includes("&lt;script&gt;x&lt;/script&gt;"));
assert.ok(!xssCopy.html.includes("<script>x</script>"));
assert.ok(xssCopy.html.includes("ab&amp;c"));

console.log("email layout tests passed");

const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
const {
  TYPE_REVIEW_SUBMITTED_EMAIL,
  reviewSubmittedEmailKey,
  reviewSubmittedCopy,
  notifyTaskSubmittedForReview,
} = require("./taskReviewNotify");

process.env.WORK_TABLE = "work-table";
process.env.USER_ACCESS_TABLE = "access-table";
process.env.PORTAL_URL = "https://login.mydgv.com";
process.env.TASK_NOTIFY_FROM_EMAIL = "noreply@mydgv.com";

const WORK = process.env.WORK_TABLE;
const ACCESS = process.env.USER_ACCESS_TABLE;

function createMemoryDdb() {
  const items = [];
  function keyOf(tableName, item) {
    return `${tableName}|${item.PK}|${item.SK}`;
  }
  return {
    items,
    seed(tableName, item) {
      const idx = items.findIndex(
        (row) => keyOf(row.TableName, row.Item) === keyOf(tableName, item)
      );
      const entry = { TableName: tableName, Item: { ...item } };
      if (idx >= 0) items[idx] = entry;
      else items.push(entry);
    },
    of(tableName) {
      return items
        .filter((row) => row.TableName === tableName)
        .map((row) => ({ ...row.Item }));
    },
    async send(command) {
      if (command instanceof GetCommand) {
        const { TableName, Key } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        return { Item: found ? { ...found.Item } : undefined };
      }
      if (command instanceof PutCommand) {
        this.seed(command.input.TableName, command.input.Item);
        return {};
      }
      if (command instanceof QueryCommand) {
        const { TableName, ExpressionAttributeValues = {} } = command.input;
        const pk = ExpressionAttributeValues[":pk"];
        const skPrefix = ExpressionAttributeValues[":sk"];
        const found = items
          .filter((row) => row.TableName === TableName && row.Item.PK === pk)
          .filter((row) =>
            skPrefix ? String(row.Item.SK).startsWith(skPrefix) : true
          )
          .map((row) => ({ ...row.Item }));
        return { Items: found };
      }
      if (command instanceof ScanCommand) {
        const { TableName } = command.input;
        return {
          Items: items
            .filter((row) => row.TableName === TableName)
            .map((row) => ({ ...row.Item })),
        };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

function seedAccess(ddb, emailAddr, role, status = "ACTIVE") {
  ddb.seed(ACCESS, {
    PK: emailAddr,
    SK: emailAddr,
    email: emailAddr,
    role,
    status,
  });
}

const copy = reviewSubmittedCopy({
  title: "Banner update",
  projectName: "DGV Employee Portal",
  priority: "HIGH",
  category: "Marketing",
  employeeName: "Priya Yadav",
  employeeEmail: "priya@mydgv.com",
  startDate: "2099-12-31T18:00:00+05:30",
  dueDate: "2099-12-31T19:00:00+05:30",
  completionRemark: "Uploaded all 50 products.",
  viewTaskUrl: "https://login.mydgv.com/admin/tasks/task-1",
  timeZone: "Asia/Kolkata",
});
assert.strictEqual(copy.type, TYPE_REVIEW_SUBMITTED_EMAIL);
assert.strictEqual(copy.subject, "Task Submitted for Review: Banner update");
assert.ok(copy.message.includes("Priya Yadav"));
assert.ok(copy.message.includes("Uploaded all 50 products."));
assert.ok(!copy.message.includes("priya@mydgv.com"));
assert.ok(copy.html.includes("font-family:Arial,sans-serif"));
assert.ok(copy.html.includes("background:#b45309"));
assert.ok(copy.html.includes("REVIEW TASK"));
assert.ok(copy.html.includes("/admin/tasks/task-1"));
assert.ok(!copy.html.includes("sourceTaskId"));
assert.ok(!copy.html.includes("PK#"));

const xss = reviewSubmittedCopy({
  title: '<script>x</script>',
  employeeName: '<img src=x>',
  completionRemark: "A & B",
  viewTaskUrl: "https://login.mydgv.com/admin/tasks/ab&c",
});
assert.ok(!xss.html.includes("<script>"));
assert.ok(xss.html.includes("&lt;script&gt;"));
assert.ok(xss.html.includes("A &amp; B"));
assert.ok(xss.html.includes("ab&amp;c"));

assert.ok(
  reviewSubmittedEmailKey("t1", "Priya@mydgv.com", "Admin@mydgv.com").includes(
    "priya@mydgv.com"
  )
);

async function run() {
  const orig = email.sendEmail;
  const mails = [];
  email.sendEmail = async (payload) => {
    mails.push(payload);
    return { ok: true, messageId: `ses-${payload.to}` };
  };

  const ddb = createMemoryDdb();
  seedAccess(ddb, "admin@mydgv.com", "ADMIN");
  seedAccess(ddb, "super@mydgv.com", "SUPER_ADMIN");
  seedAccess(ddb, "mgr@mydgv.com", "MANAGER");
  seedAccess(ddb, "priya@mydgv.com", "EMPLOYEE");
  ddb.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: "PROJECT#open-1",
    projectId: "open-1",
    name: "Open",
    accessMode: "OPEN",
    status: "ACTIVE",
  });
  const open = await notifyTaskSubmittedForReview({
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    task: {
      taskId: "task-1",
      title: "Banner update",
      projectId: "open-1",
      priority: "HIGH",
    },
    employeeEmail: "priya@mydgv.com",
    employeeName: "Priya Yadav",
    completionRemark: "Done.",
    projectName: "Open",
  });
  assert.strictEqual(open.status, "SENT");
  assert.deepStrictEqual(
    mails.map((mail) => mail.to).sort(),
    ["admin@mydgv.com", "super@mydgv.com"]
  );
  assert.ok(!mails.some((mail) => mail.to === "priya@mydgv.com"));
  assert.ok(!mails.some((mail) => mail.to === "mgr@mydgv.com"));

  mails.length = 0;
  const rest = createMemoryDdb();
  seedAccess(rest, "super@mydgv.com", "SUPER_ADMIN");
  seedAccess(rest, "pa@mydgv.com", "ADMIN");
  seedAccess(rest, "priya@mydgv.com", "EMPLOYEE");
  rest.seed(WORK, {
    PK: "ENTITY#PROJECT",
    SK: "PROJECT#secret-1",
    projectId: "secret-1",
    name: "Secret",
    accessMode: "RESTRICTED",
    status: "ACTIVE",
  });
  rest.seed(WORK, {
    PK: "PROJECT#secret-1",
    SK: "PROJECT_ADMIN#pa@mydgv.com",
    type: "PROJECT_ADMIN",
    projectId: "secret-1",
    email: "pa@mydgv.com",
    status: "ACTIVE",
  });
  const restricted = await notifyTaskSubmittedForReview({
    ddb: rest,
    tableName: WORK,
    accessTable: ACCESS,
    task: {
      taskId: "task-rest",
      title: "Secret Task",
      projectId: "secret-1",
    },
    employeeEmail: "priya@mydgv.com",
    employeeName: "Priya Yadav",
    completionRemark: "Ready.",
  });
  assert.strictEqual(restricted.status, "SENT");
  assert.deepStrictEqual(
    mails.map((mail) => mail.to),
    ["pa@mydgv.com"]
  );

  email.sendEmail = async () => ({ ok: false, error: "MessageRejected" });
  const failed = await notifyTaskSubmittedForReview({
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    task: { taskId: "task-fail", title: "X", projectId: "open-1" },
    employeeEmail: "priya@mydgv.com",
    completionRemark: "x",
  });
  assert.strictEqual(failed.status, "FAILED");
  email.sendEmail = orig;
  console.log("task review notify tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

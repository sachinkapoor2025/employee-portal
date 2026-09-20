const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const emailCalls = [];
const email = require("../common/email");
email.sendEmail = async (payload) => {
  emailCalls.push(payload);
  return { ok: true, messageId: "test-ses" };
};

const { activeCompletionAdminEmailsFromAccess, activeAdminEmailsFromAccess } =
  require("../common/roles");
const {
  notifyTaskCompleted,
  buildCompletionEmail,
  escapeHtml,
  TYPE_COMPLETED_EMAIL,
  claimCompletionEmail,
  EMAIL_CLAIM_MAX_ATTEMPTS,
} = require("./taskCompleteNotify");

const WORK_TABLE = "work-table";
const ACCESS_TABLE = "access-table";
process.env.WORK_TABLE = WORK_TABLE;
process.env.USER_ACCESS_TABLE = ACCESS_TABLE;
process.env.TASK_NOTIFY_FROM_EMAIL = "notify@mydgv.com";
process.env.PORTAL_URL = "https://login.mydgv.com";

function failConditional() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  throw err;
}

function resolveAttrName(token, names = {}) {
  const key = String(token || "").trim();
  if (key.startsWith("#")) return names[key] || key.slice(1);
  return key;
}

function evalCondition(item, expr, names, values) {
  if (!expr) return true;
  const s = String(expr);
  let i = 0;
  function skip() {
    while (i < s.length && s[i] === " ") i += 1;
  }
  function parseOr() {
    let left = parseAnd();
    skip();
    while (/^OR\b/i.test(s.slice(i))) {
      i += 2;
      skip();
      left = parseAnd() || left;
      skip();
    }
    return left;
  }
  function parseAnd() {
    let left = parsePrimary();
    skip();
    while (/^AND\b/i.test(s.slice(i))) {
      i += 3;
      skip();
      left = parsePrimary() && left;
      skip();
    }
    return left;
  }
  function parsePrimary() {
    skip();
    if (s[i] === "(") {
      i += 1;
      const value = parseOr();
      skip();
      if (s[i] === ")") i += 1;
      return value;
    }
    const rest = s.slice(i);
    const notExists = rest.match(/^attribute_not_exists\(([^)]+)\)/i);
    if (notExists) {
      i += notExists[0].length;
      const attr = resolveAttrName(notExists[1], names);
      return item[attr] === undefined || item[attr] === null;
    }
    const cmp = rest.match(/^([#A-Za-z0-9_]+)\s*(<>|=|<=|<|>=|>)\s*(:[A-Za-z0-9_]+)/);
    if (!cmp) throw new Error(`unparsed condition: ${rest}`);
    i += cmp[0].length;
    const left = item[resolveAttrName(cmp[1], names)];
    const right = values[cmp[3]];
    if (cmp[2] === "=") return left === right;
    if (cmp[2] === "<>") return left !== right;
    if (cmp[2] === "<") return left < right;
    if (cmp[2] === "<=") return left <= right;
    if (cmp[2] === ">") return left > right;
    if (cmp[2] === ">=") return left >= right;
    return false;
  }
  const ok = parseOr();
  skip();
  if (i < s.length) throw new Error(`trailing condition: ${s.slice(i)}`);
  return ok;
}

function applyUpdateExpression(item, updateExpression, names, values) {
  const next = { ...item };
  const raw = String(updateExpression || "");
  const setMatch = raw.match(/SET\s+(.+?)(?=\s+ADD\s+|$)/i);
  if (setMatch) {
    for (const part of setMatch[1].split(",")) {
      const [rawLeft, rawRight] = part.split("=").map((piece) => piece.trim());
      next[resolveAttrName(rawLeft, names)] = values[rawRight];
    }
  }
  const addMatch = raw.match(/ADD\s+(.+)/i);
  if (addMatch) {
    const tokens = addMatch[1].trim().split(/\s+/);
    const attr = resolveAttrName(tokens[0], names);
    next[attr] = Number(next[attr] || 0) + Number(values[tokens[1]] || 0);
  }
  return next;
}

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
      return items.filter((row) => row.TableName === tableName).map((row) => ({ ...row.Item }));
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
        const { TableName, Item, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues } =
          command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Item.PK &&
            row.Item.SK === Item.SK
        );
        if (ConditionExpression) {
          const current = found ? found.Item : {};
          if (
            !evalCondition(
              current,
              ConditionExpression,
              ExpressionAttributeNames || {},
              ExpressionAttributeValues || {}
            )
          ) {
            failConditional();
          }
        }
        this.seed(TableName, Item);
        return {};
      }
      if (command instanceof UpdateCommand) {
        const {
          TableName,
          Key,
          ConditionExpression,
          UpdateExpression,
          ExpressionAttributeNames = {},
          ExpressionAttributeValues = {},
        } = command.input;
        const found = items.find(
          (row) =>
            row.TableName === TableName &&
            row.Item.PK === Key.PK &&
            row.Item.SK === Key.SK
        );
        if (!found) failConditional();
        if (
          ConditionExpression &&
          !evalCondition(
            found.Item,
            ConditionExpression,
            ExpressionAttributeNames,
            ExpressionAttributeValues
          )
        ) {
          failConditional();
        }
        found.Item = applyUpdateExpression(
          found.Item,
          UpdateExpression,
          ExpressionAttributeNames,
          ExpressionAttributeValues
        );
        return { Attributes: { ...found.Item } };
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

function seedAccess(ddb) {
  const rows = [
    { email: "super@mydgv.com", status: "ACTIVE", role: "SUPER_ADMIN" },
    { email: "admin@mydgv.com", status: "ACTIVE", role: "ADMIN" },
    { email: "oldadmin@mydgv.com", status: "BLOCKED", role: "ADMIN" },
    { email: "oldsuper@mydgv.com", status: "BLOCKED", role: "SUPER_ADMIN" },
    { email: "mgr@mydgv.com", status: "ACTIVE", role: "MANAGER" },
    { email: "doer@mydgv.com", status: "ACTIVE", role: "EMPLOYEE" },
    { email: "super@mydgv.com", status: "ACTIVE", role: "SUPER_ADMIN" },
  ];
  for (const row of rows) {
    ddb.seed(ACCESS_TABLE, {
      PK: row.email,
      SK: row.email,
      email: row.email,
      status: row.status,
      role: row.role,
    });
  }
}

function seedTask(ddb, overrides = {}) {
  const task = {
    PK: "ENTITY#TASK",
    SK: "TASK#task-1",
    taskId: "task-1",
    title: "Homepage Update",
    status: "DONE",
    assignee: "doer@mydgv.com",
    assignees: ["doer@mydgv.com"],
    projectId: "proj-1",
    completedDate: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
  ddb.seed(WORK_TABLE, task);
  return task;
}

function notifyItems(ddb) {
  return ddb.of(WORK_TABLE).filter((item) => String(item.SK || "").startsWith("NOTIFY#"));
}

async function run() {
  const recipientRows = [
    { email: "super@mydgv.com", status: "ACTIVE", role: "SUPER_ADMIN" },
    { email: "admin@mydgv.com", status: "ACTIVE", role: "ADMIN" },
    { email: "oldadmin@mydgv.com", status: "BLOCKED", role: "ADMIN" },
    { email: "oldsuper@mydgv.com", status: "BLOCKED", role: "SUPER_ADMIN" },
    { email: "mgr@mydgv.com", status: "ACTIVE", role: "MANAGER" },
    { email: "super@mydgv.com", status: "ACTIVE", role: "SUPER_ADMIN" },
  ];
  const completionRecipients = activeCompletionAdminEmailsFromAccess(recipientRows);
  assert.deepStrictEqual(completionRecipients, ["super@mydgv.com", "admin@mydgv.com"]);
  const portalAdmins = activeAdminEmailsFromAccess(recipientRows);
  assert.ok(portalAdmins.includes("mgr@mydgv.com"));
  assert.ok(!completionRecipients.includes("mgr@mydgv.com"));

  const copy = buildCompletionEmail({
    title: `Ship <script>alert(1)</script>`,
    assigneeEmail: "doer@mydgv.com",
    completedByName: `Admin "Boss"`,
    completedByEmail: "admin@mydgv.com",
    projectName: "Portal",
    completedAt: "2026-09-20T12:00:00.000Z",
    taskId: "task-1",
  });
  assert.ok(copy.subject.startsWith("Task completed:"));
  assert.ok(!copy.html.includes("<script>"));
  assert.ok(copy.html.includes("&lt;script&gt;"));
  assert.ok(copy.html.includes("&quot;"));
  assert.strictEqual(escapeHtml("<x>"), "&lt;x&gt;");

  emailCalls.length = 0;
  const ddb = createMemoryDdb();
  seedAccess(ddb);
  const task = seedTask(ddb);
  const first = await notifyTaskCompleted({
    ddb,
    tableName: WORK_TABLE,
    accessTable: ACCESS_TABLE,
    task,
    completedBy: "doer@mydgv.com",
    completedAt: "2026-09-20T12:00:00.000Z",
    projectName: "DGV Employee Portal",
  });
  assert.strictEqual(first.status, "SENT");
  const tos = emailCalls.map((call) => call.to).sort();
  assert.deepStrictEqual(tos, ["admin@mydgv.com", "super@mydgv.com"]);
  assert.ok(emailCalls.every((call) => call.from === "notify@mydgv.com"));
  assert.ok(emailCalls.every((call) => call.subject.includes("Homepage Update")));
  assert.ok(!emailCalls.some((call) => call.to === "mgr@mydgv.com"));
  assert.ok(!emailCalls.some((call) => call.to === "oldadmin@mydgv.com"));
  assert.ok(!emailCalls.some((call) => call.to === "oldsuper@mydgv.com"));
  assert.ok(!emailCalls.some((call) => call.to === "doer@mydgv.com"));
  assert.strictEqual(notifyItems(ddb).length, 0);
  const stored = ddb.of(WORK_TABLE).find((item) => item.taskId === "task-1");
  assert.strictEqual(stored.status, "DONE");
  assert.strictEqual(stored.completionEmailStatus, "SENT");

  const before = emailCalls.length;
  const second = await notifyTaskCompleted({
    ddb,
    tableName: WORK_TABLE,
    accessTable: ACCESS_TABLE,
    task: { ...task, status: "DONE" },
    completedBy: "doer@mydgv.com",
  });
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(emailCalls.length, before);

  const notDone = createMemoryDdb();
  seedAccess(notDone);
  seedTask(notDone, { status: "IN_PROGRESS" });
  const skipped = await notifyTaskCompleted({
    ddb: notDone,
    tableName: WORK_TABLE,
    accessTable: ACCESS_TABLE,
    task: { taskId: "task-1", status: "IN_PROGRESS", title: "x" },
  });
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(skipped.reason, "NOT_COMPLETED");

  emailCalls.length = 0;
  const failDdb = createMemoryDdb();
  seedAccess(failDdb);
  seedTask(failDdb);
  const origMail = email.sendEmail;
  email.sendEmail = async (payload) => {
    emailCalls.push(payload);
    return { ok: false, error: "MessageRejected" };
  };
  const failed = await notifyTaskCompleted({
    ddb: failDdb,
    tableName: WORK_TABLE,
    accessTable: ACCESS_TABLE,
    task,
    completedBy: "doer@mydgv.com",
  });
  email.sendEmail = origMail;
  assert.strictEqual(failed.status, "FAILED");
  const failedTask = failDdb.of(WORK_TABLE).find((item) => item.taskId === "task-1");
  assert.strictEqual(failedTask.status, "DONE");
  assert.strictEqual(failedTask.completionEmailStatus, "FAILED");
  assert.strictEqual(notifyItems(failDdb).length, 0);
  assert.ok(
    failDdb
      .of(WORK_TABLE)
      .some(
        (item) =>
          String(item.SK || "").startsWith("REMINDER#") &&
          item.type === TYPE_COMPLETED_EMAIL &&
          item.status === "FAILED"
      )
  );

  email.sendEmail = origMail;
  emailCalls.length = 0;
  const retried = await notifyTaskCompleted({
    ddb: failDdb,
    tableName: WORK_TABLE,
    accessTable: ACCESS_TABLE,
    task,
    completedBy: "doer@mydgv.com",
  });
  assert.strictEqual(retried.status, "SENT");
  const afterRetry = failDdb.of(WORK_TABLE).find((item) => item.taskId === "task-1");
  assert.strictEqual(afterRetry.completionEmailStatus, "SENT");
  assert.ok(Number(afterRetry.completionEmailAttempts) >= 2);
  assert.ok(emailCalls.length >= 2);

  const sendingDdb = createMemoryDdb();
  seedAccess(sendingDdb);
  seedTask(sendingDdb, {
    completionEmailStatus: "SENDING",
    completionEmailClaimedAt: "2026-09-20T12:00:00.000Z",
    completionEmailAttempts: 1,
  });
  const freshSending = await notifyTaskCompleted({
    ddb: sendingDdb,
    tableName: WORK_TABLE,
    accessTable: ACCESS_TABLE,
    task: { taskId: "task-1", status: "DONE", title: "x" },
    nowMs: Date.parse("2026-09-20T12:01:00.000Z"),
  });
  assert.strictEqual(freshSending.skipped, true);
  assert.strictEqual(freshSending.reason, "ALREADY_CLAIMED");
  assert.strictEqual(
    sendingDdb.of(WORK_TABLE).find((item) => item.taskId === "task-1").completionEmailStatus,
    "SENDING"
  );

  const staleDdb = createMemoryDdb();
  seedAccess(staleDdb);
  seedTask(staleDdb, {
    completionEmailStatus: "SENDING",
    completionEmailClaimedAt: "2026-09-20T11:00:00.000Z",
    completionEmailAttempts: 1,
  });
  const stale = await notifyTaskCompleted({
    ddb: staleDdb,
    tableName: WORK_TABLE,
    accessTable: ACCESS_TABLE,
    task: { taskId: "task-1", status: "DONE", title: "Homepage Update" },
    nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
  });
  assert.strictEqual(stale.status, "SENT");
  assert.strictEqual(
    staleDdb.of(WORK_TABLE).find((item) => item.taskId === "task-1").completionEmailStatus,
    "SENT"
  );

  const skippedDdb = createMemoryDdb();
  seedAccess(skippedDdb);
  seedTask(skippedDdb, {
    completionEmailStatus: "SKIPPED",
    completionEmailAttempts: 1,
  });
  const staySkipped = await notifyTaskCompleted({
    ddb: skippedDdb,
    tableName: WORK_TABLE,
    accessTable: ACCESS_TABLE,
    task: { taskId: "task-1", status: "DONE", title: "x" },
  });
  assert.strictEqual(staySkipped.skipped, true);
  assert.strictEqual(
    skippedDdb.of(WORK_TABLE).find((item) => item.taskId === "task-1").completionEmailStatus,
    "SKIPPED"
  );

  const capDdb = createMemoryDdb();
  seedAccess(capDdb);
  seedTask(capDdb, {
    completionEmailStatus: "FAILED",
    completionEmailAttempts: EMAIL_CLAIM_MAX_ATTEMPTS,
  });
  const capped = await notifyTaskCompleted({
    ddb: capDdb,
    tableName: WORK_TABLE,
    accessTable: ACCESS_TABLE,
    task: { taskId: "task-1", status: "DONE", title: "x" },
  });
  assert.strictEqual(capped.skipped, true);
  assert.strictEqual(EMAIL_CLAIM_MAX_ATTEMPTS, 5);
  assert.strictEqual(
    capDdb.of(WORK_TABLE).find((item) => item.taskId === "task-1").completionEmailStatus,
    "FAILED"
  );

  const raceDdb = createMemoryDdb();
  seedAccess(raceDdb);
  seedTask(raceDdb);
  const [left, right] = await Promise.all([
    notifyTaskCompleted({
      ddb: raceDdb,
      tableName: WORK_TABLE,
      accessTable: ACCESS_TABLE,
      task: { taskId: "task-1", status: "DONE", title: "Homepage Update" },
    }),
    notifyTaskCompleted({
      ddb: raceDdb,
      tableName: WORK_TABLE,
      accessTable: ACCESS_TABLE,
      task: { taskId: "task-1", status: "DONE", title: "Homepage Update" },
    }),
  ]);
  const claimedSends = [left, right].filter((row) => !row.skipped);
  assert.strictEqual(claimedSends.length, 1);
  assert.strictEqual(claimedSends[0].status, "SENT");
  assert.ok([left, right].some((row) => row.reason === "ALREADY_CLAIMED"));

  const claimOnly = createMemoryDdb();
  seedTask(claimOnly, { completionEmailStatus: "FAILED", completionEmailAttempts: 1 });
  const reclaimed = await claimCompletionEmail(
    claimOnly,
    WORK_TABLE,
    "task-1",
    "2026-09-20T12:00:00.000Z",
    Date.parse("2026-09-20T12:00:00.000Z")
  );
  assert.strictEqual(reclaimed.ok, true);
  assert.strictEqual(reclaimed.task.completionEmailStatus, "SENDING");
  assert.strictEqual(reclaimed.task.completionEmailAttempts, 2);

  console.log("taskCompleteNotify tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

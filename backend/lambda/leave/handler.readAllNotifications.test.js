process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.ATTENDANCE_TABLE = "Attendance";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.WORK_TABLE = "WorkTasks";
process.env.AWS_REGION = "ap-south-1";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const emailLib = require("../common/email");
emailLib.sendEmail = async () => ({ ok: true, messageId: "ses-test" });
const {
  handler,
  setDocumentClientForTests,
  setNowMsForTests,
} = require("./handler");
const { queryStore } = require("../common/memoryTransact");

const EMAIL = "worker@mydgv.com";
const OTHER = "other@mydgv.com";
const READ_AT = "2026-09-29T06:30:00.000Z";
const PAGE_SIZE = 2;

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function putEvent(email, body) {
  return {
    path: "/leave",
    httpMethod: "PUT",
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: {
          email,
          "cognito:groups": ["Employee"],
        },
      },
    },
  };
}

function notifyItem(email, id, extra = {}) {
  const sk = extra.SK || `NOTIFY#2026-09-01T00:00:00.000Z#${id}`;
  return {
    PK: `USER#${email}`,
    SK: sk,
    notifyId: id,
    email,
    title: extra.title || `Notify ${id}`,
    message: extra.message || "Hello",
    read: extra.read === true,
    createdAt: extra.createdAt || "2026-09-01T00:00:00.000Z",
    readAt: extra.readAt || null,
    ...extra,
    SK: sk,
    PK: `USER#${email}`,
  };
}

function createFakeDdb(work = {}) {
  const workStore = { ...work };
  const updates = [];
  const queries = [];
  return {
    workStore,
    updates,
    queries,
    send: async (cmd) => {
      const name = cmd.constructor?.name || "";
      const input = cmd.input || {};
      if (name === "UpdateCommand" && input.Key) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        const row = workStore[key];
        if (!row) return {};
        const values = input.ExpressionAttributeValues || {};
        const next = {
          ...row,
          read: values[":read"] === true ? true : row.read,
          readAt: values[":readAt"] || row.readAt,
        };
        workStore[key] = next;
        updates.push({ key: input.Key, item: next, input });
        return {};
      }
      if (input.KeyConditionExpression) {
        queries.push(input);
        let items = queryStore(workStore, input);
        items.sort((a, b) => String(a.SK || "").localeCompare(String(b.SK || "")));
        const start = input.ExclusiveStartKey;
        if (start?.PK && start?.SK) {
          const idx = items.findIndex(
            (row) => row.PK === start.PK && row.SK === start.SK
          );
          items = idx >= 0 ? items.slice(idx + 1) : items;
        }
        const page = items.slice(0, PAGE_SIZE);
        const last = page[page.length - 1];
        return {
          Items: page,
          LastEvaluatedKey:
            items.length > PAGE_SIZE && last
              ? { PK: last.PK, SK: last.SK }
              : undefined,
        };
      }
      if (input.Item) {
        const item = { ...input.Item };
        workStore[`${item.PK}|${item.SK}`] = item;
        return {};
      }
      if (input.Key) {
        return {
          Item: workStore[`${input.Key.PK}|${input.Key.SK}`] || null,
        };
      }
      return { Items: [] };
    },
  };
}

function seed(db, items) {
  for (const item of items) {
    db.workStore[`${item.PK}|${item.SK}`] = { ...item };
  }
}

async function markAll(email, extraBody = {}) {
  return parse(
    await handler(
      putEvent(email, { action: "readAllNotifications", ...extraBody })
    )
  );
}

(async () => {
  setNowMsForTests(() => Date.parse(READ_AT));

  {
    const db = createFakeDdb();
    setDocumentClientForTests(db);
    const res = await markAll(EMAIL);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true, updated: 0 });
    assert.strictEqual(db.updates.length, 0);
  }

  {
    const db = createFakeDdb();
    seed(db, [notifyItem(EMAIL, "one")]);
    setDocumentClientForTests(db);
    const res = await markAll(EMAIL);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true, updated: 1 });
    const row = db.workStore[`${notifyItem(EMAIL, "one").PK}|${notifyItem(EMAIL, "one").SK}`];
    assert.strictEqual(row.read, true);
    assert.strictEqual(row.readAt, READ_AT);
    assert.strictEqual(db.updates.length, 1);
    assert.match(db.updates[0].input.UpdateExpression || "", /SET/);
  }

  {
    const db = createFakeDdb();
    seed(db, [
      notifyItem(EMAIL, "a"),
      notifyItem(EMAIL, "b"),
      notifyItem(EMAIL, "c"),
    ]);
    setDocumentClientForTests(db);
    const res = await markAll(EMAIL);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.updated, 3);
    assert.strictEqual(db.updates.length, 3);
    for (const id of ["a", "b", "c"]) {
      const item = notifyItem(EMAIL, id);
      assert.strictEqual(db.workStore[`${item.PK}|${item.SK}`].read, true);
    }
  }

  {
    const db = createFakeDdb();
    const already = notifyItem(EMAIL, "done", {
      read: true,
      readAt: "2026-01-01T00:00:00.000Z",
    });
    const unread = notifyItem(EMAIL, "open");
    seed(db, [already, unread]);
    setDocumentClientForTests(db);
    const res = await markAll(EMAIL);
    assert.strictEqual(res.body.updated, 1);
    assert.strictEqual(db.workStore[`${already.PK}|${already.SK}`].readAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(db.workStore[`${unread.PK}|${unread.SK}`].read, true);
  }

  {
    const db = createFakeDdb();
    const many = Array.from({ length: 26 }, (_, i) =>
      notifyItem(EMAIL, `n${String(i).padStart(2, "0")}`)
    );
    seed(db, many);
    setDocumentClientForTests(db);
    const res = await markAll(EMAIL);
    assert.strictEqual(res.body.updated, 26);
    assert.strictEqual(db.updates.length, 26);
    assert.ok(db.queries.length >= 2);
  }

  {
    const db = createFakeDdb();
    seed(db, [
      notifyItem(EMAIL, "p1"),
      notifyItem(EMAIL, "p2"),
      notifyItem(EMAIL, "p3"),
      notifyItem(EMAIL, "p4"),
      notifyItem(EMAIL, "p5"),
    ]);
    setDocumentClientForTests(db);
    const res = await markAll(EMAIL);
    assert.strictEqual(res.body.updated, 5);
    assert.ok(db.queries.some((q) => q.ExclusiveStartKey));
    assert.ok(db.queries.length >= 3);
  }

  {
    const db = createFakeDdb();
    const mine = notifyItem(EMAIL, "mine");
    const theirs = notifyItem(OTHER, "theirs");
    seed(db, [mine, theirs]);
    setDocumentClientForTests(db);
    const res = await markAll(EMAIL);
    assert.strictEqual(res.body.updated, 1);
    assert.strictEqual(db.workStore[`${mine.PK}|${mine.SK}`].read, true);
    assert.strictEqual(db.workStore[`${theirs.PK}|${theirs.SK}`].read, false);
  }

  {
    const db = createFakeDdb();
    const reminder = {
      PK: `USER#${EMAIL}`,
      SK: "REMINDER#TASK_ASSIGNED#task-1",
      type: "TASK_ASSIGNED",
      status: "SENT",
      read: false,
    };
    seed(db, [notifyItem(EMAIL, "bell"), reminder]);
    setDocumentClientForTests(db);
    const res = await markAll(EMAIL);
    assert.strictEqual(res.body.updated, 1);
    assert.strictEqual(
      db.workStore[`${reminder.PK}|${reminder.SK}`].status,
      "SENT"
    );
    assert.strictEqual(db.workStore[`${reminder.PK}|${reminder.SK}`].read, false);
    assert.ok(
      !db.updates.some((row) => row.key.SK.startsWith("REMINDER#"))
    );
  }

  {
    const db = createFakeDdb();
    const victim = notifyItem(OTHER, "victim");
    const mine = notifyItem(EMAIL, "self");
    seed(db, [victim, mine]);
    setDocumentClientForTests(db);
    const res = await markAll(EMAIL, { email: OTHER });
    assert.strictEqual(res.body.updated, 1);
    assert.strictEqual(db.workStore[`${mine.PK}|${mine.SK}`].read, true);
    assert.strictEqual(db.workStore[`${victim.PK}|${victim.SK}`].read, false);
  }

  {
    const db = createFakeDdb();
    seed(db, [notifyItem(EMAIL, "again")]);
    setDocumentClientForTests(db);
    const first = await markAll(EMAIL);
    assert.strictEqual(first.body.updated, 1);
    const second = await markAll(EMAIL);
    assert.strictEqual(second.statusCode, 200);
    assert.deepStrictEqual(second.body, { ok: true, updated: 0 });
  }

  {
    const db = createFakeDdb();
    const item = notifyItem(EMAIL, "single");
    seed(db, [item]);
    setDocumentClientForTests(db);
    const res = parse(
      await handler(
        putEvent(EMAIL, { action: "readNotification", sk: item.SK })
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.read, true);
    assert.strictEqual(db.workStore[`${item.PK}|${item.SK}`].read, true);
  }

  {
    const db = createFakeDdb();
    const leaveRow = {
      PK: `USER#${EMAIL}`,
      SK: "LEAVE#not-a-notify",
      status: "APPROVED",
      read: false,
    };
    seed(db, [leaveRow, notifyItem(EMAIL, "ok")]);
    setDocumentClientForTests(db);
    const res = await markAll(EMAIL, { sk: leaveRow.SK });
    assert.strictEqual(res.body.updated, 1);
    assert.strictEqual(db.workStore[`${leaveRow.PK}|${leaveRow.SK}`].read, false);
    assert.ok(!db.updates.some((row) => row.key.SK === leaveRow.SK));
  }

  {
    const db = createFakeDdb();
    setDocumentClientForTests(db);
    const res = parse(
      await handler(
        putEvent(EMAIL, { action: "readNotification", sk: "REMINDER#x" })
      )
    );
    assert.strictEqual(res.statusCode, 400);
  }

  setNowMsForTests();
  console.log("handler.readAllNotifications.test.js ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

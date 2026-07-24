const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { getRequestMeta, todayKey } = require("../common/requestMeta");
const { resolveLocation } = require("../common/geo");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

async function fetchProfileName(email) {
  if (!process.env.USER_PROFILE_TABLE) {
    return email.split("@")[0];
  }
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: { PK: `USER#${email}`, SK: "PROFILE" },
      })
    );
    return res.Item?.name || email.split("@")[0];
  } catch {
    return email.split("@")[0];
  }
}

async function locationFromEvent(ev, ipCache) {
  if (ev.location && ev.location !== "Unknown") return ev.location;
  const ip = ev.ip;
  if (!ip || ip === "unknown") return "Unknown";
  if (!ipCache[ip]) {
    ipCache[ip] = await resolveLocation(ip);
  }
  return ipCache[ip];
}

async function logEvent(email, type, meta = {}, body = {}) {
  const now = new Date().toISOString();
  const date = todayKey();
  const id = randomUUID();
  const ip = meta.ip || body.ip || "unknown";
  const location =
    body.location && body.location !== "Unknown"
      ? body.location
      : await resolveLocation(ip);

  await ddb.send(
    new PutCommand({
      TableName: process.env.ACTIVITY_TABLE,
      Item: {
        PK: `USER#${email}`,
        SK: `EVENT#${now}#${id}`,
        GSI1PK: `DATE#${date}`,
        GSI1SK: `${now}#${email}`,
        email,
        type,
        timestamp: now,
        date,
        ip,
        device: meta.device || body.device || "unknown",
        browser: meta.browser || body.browser || "unknown",
        userAgent: meta.userAgent || body.userAgent || "",
        page: body.page || null,
        location,
        sessionMinutes: body.sessionMinutes || null,
      },
    })
  );

  await ddb.send(
    new UpdateCommand({
      TableName: process.env.ACTIVITY_TABLE,
      Key: { PK: `SUMMARY#${email}`, SK: `DAY#${date}` },
      UpdateExpression:
        "SET email = :email, #d = :date, lastSeen = :now, eventCount = if_not_exists(eventCount, :zero) + :one, totalMinutes = if_not_exists(totalMinutes, :zero) + :mins",
      ExpressionAttributeNames: { "#d": "date" },
      ExpressionAttributeValues: {
        ":email": email,
        ":date": date,
        ":now": now,
        ":zero": 0,
        ":one": 1,
        ":mins": body.sessionMinutes || 0,
      },
    })
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  const meta = getRequestMeta(event);
  const path = event.path || "";

  try {
    if (path.endsWith("/activity") && event.httpMethod === "POST") {
      if (!user.email) return json(401, { error: "Unauthorized" });

      const body = JSON.parse(event.body || "{}");
      const type = body.type || "heartbeat";

      await logEvent(user.email, type, meta, {
        ...body,
        ip: meta.ip,
        device: body.device || meta.device,
        browser: body.browser || meta.browser,
        userAgent: meta.userAgent,
      });

      return json(200, { ok: true });
    }

    if (path.endsWith("/activity/today") && event.httpMethod === "GET") {
      if (!user.email) return json(401, { error: "Unauthorized" });

      const date = event.queryStringParameters?.date || todayKey();
      const summary = await ddb.send(
        new GetCommand({
          TableName: process.env.ACTIVITY_TABLE,
          Key: { PK: `SUMMARY#${user.email}`, SK: `DAY#${date}` },
        })
      );

      const events = await ddb.send(
        new QueryCommand({
          TableName: process.env.ACTIVITY_TABLE,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `USER#${user.email}`,
            ":prefix": "EVENT#",
          },
          ScanIndexForward: false,
          Limit: 50,
        })
      );

      return json(200, {
        summary: summary.Item || { totalMinutes: 0, eventCount: 0 },
        events: events.Items || [],
      });
    }

    if (path.endsWith("/admin/activity") && event.httpMethod === "GET") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });

      const date = event.queryStringParameters?.date || todayKey();

      const dayEvents = await ddb.send(
        new QueryCommand({
          TableName: process.env.ACTIVITY_TABLE,
          IndexName: "DateIndex",
          KeyConditionExpression: "GSI1PK = :date",
          ExpressionAttributeValues: { ":date": `DATE#${date}` },
        })
      );

      const byUser = {};
      for (const ev of dayEvents.Items || []) {
        if (!byUser[ev.email]) {
          byUser[ev.email] = {
            email: ev.email,
            events: [],
            lastSeen: ev.timestamp,
            devices: new Set(),
          };
        }
        byUser[ev.email].events.push(ev);
        byUser[ev.email].devices.add(ev.device);
        if (ev.timestamp > byUser[ev.email].lastSeen) {
          byUser[ev.email].lastSeen = ev.timestamp;
        }
      }

      const ipCache = {};
      const users = await Promise.all(
        Object.values(byUser).map(async (u) => {
          const locations = new Set();
          for (const ev of u.events) {
            locations.add(await locationFromEvent(ev, ipCache));
          }
          return {
            email: u.email,
            name: await fetchProfileName(u.email),
            lastSeen: u.lastSeen,
            eventCount: u.events.length,
            locations: [...locations],
            devices: [...u.devices],
            logins: u.events.filter((e) => e.type === "login").length,
          };
        })
      );

      return json(200, { date, users, events: dayEvents.Items || [] });
    }

    if (path.endsWith("/admin/dashboard") && event.httpMethod === "GET") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });

      const date = todayKey();

      const [activity, projects, tasks, leaves] = await Promise.all([
        ddb.send(
          new QueryCommand({
            TableName: process.env.ACTIVITY_TABLE,
            IndexName: "DateIndex",
            KeyConditionExpression: "GSI1PK = :d",
            ExpressionAttributeValues: { ":d": `DATE#${date}` },
          })
        ),
        ddb.send(
          new QueryCommand({
            TableName: process.env.WORK_TABLE,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": "ENTITY#PROJECT" },
          })
        ),
        ddb.send(
          new QueryCommand({
            TableName: process.env.WORK_TABLE,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
          })
        ),
        ddb.send(
          new QueryCommand({
            TableName: process.env.WORK_TABLE,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": "ENTITY#LEAVE" },
          })
        ),
      ]);

      const activeUsers = new Set((activity.Items || []).map((i) => i.email));
      const openTasks = (tasks.Items || []).filter(
        (t) => t.status !== "DONE" && t.status !== "Done"
      );
      const pendingLeave = (leaves.Items || []).filter((l) => l.status === "PENDING");

      const ipCache = {};
      const recentActivity = await Promise.all(
        (activity.Items || []).slice(0, 20).map(async (ev) => ({
          timestamp: ev.timestamp,
          email: ev.email,
          name: await fetchProfileName(ev.email),
          type: ev.type,
          location: await locationFromEvent(ev, ipCache),
          device: ev.device,
        }))
      );

      return json(200, {
        date,
        stats: {
          activeUsersToday: activeUsers.size,
          totalProjects: (projects.Items || []).length,
          openTasks: openTasks.length,
          pendingLeave: pendingLeave.length,
        },
        recentActivity,
        overdueTasks: openTasks.filter(
          (t) => t.dueDate && t.dueDate < date
        ),
      });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Activity error:", err);
    return json(500, { error: "Internal server error" });
  }
};

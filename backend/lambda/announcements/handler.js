const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const logic = require("./logic");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

function isAdminPath(event) {
  return (event.path || "").includes("/admin/");
}

function isScheduleEvent(event) {
  if (!event || event.httpMethod) return false;
  if (event.expireAnnouncements === true || event.source === "announcement-expiry") {
    return true;
  }
  if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
    return true;
  }
  return false;
}

async function listAnnouncements() {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "ENTITY#ANNOUNCE" },
      ScanIndexForward: false,
    })
  );
  return res.Items || [];
}

async function getAnnouncement(announceId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: { PK: "ENTITY#ANNOUNCE", SK: `ANN#${announceId}` },
    })
  );
  return res.Item || null;
}

function resolveExpiresAt(body) {
  if (body.noExpiry === true || body.expiresAt === null || body.expiresAt === "") {
    return { ok: true, expiresAt: null };
  }
  if (body.expiresAt === undefined) {
    return { ok: true, expiresAt: null };
  }
  const ms = logic.parseExpiresAt(body.expiresAt);
  if (!Number.isFinite(ms)) {
    return { ok: false, error: "Invalid expiry date and time." };
  }
  return { ok: true, expiresAt: new Date(ms).toISOString() };
}

function decorate(items, nowMs = Date.now()) {
  return items.map((item) => logic.withAnnouncementStatus(item, nowMs));
}

async function lookupProfileName(email) {
  if (!email || !process.env.USER_PROFILE_TABLE) return "";
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: { PK: `USER#${String(email).toLowerCase()}`, SK: "PROFILE" },
      })
    );
    return String(res.Item?.name || "").trim();
  } catch {
    return "";
  }
}

async function actorName(event, user) {
  const claims = event.requestContext?.authorizer?.claims || {};
  const profileName = await lookupProfileName(user.email);
  return logic.resolveAuthorName({
    profileName,
    claimsName: logic.nameFromClaims(claims),
    email: user.email,
  });
}

async function runExpirySweep() {
  const nowMs = Date.now();
  const items = await listAnnouncements();
  const expired = items.filter((item) => logic.isExpired(item, nowMs)).length;
  console.log(
    "ANNOUNCEMENT_EXPIRY_SWEEP",
    JSON.stringify({ total: items.length, expired })
  );
  return json(200, { ok: true, total: items.length, expired });
}

exports.handler = async (event) => {
  if (isScheduleEvent(event)) {
    try {
      return await runExpirySweep();
    } catch (err) {
      console.error("Announcement expiry sweep error:", err);
      return json(500, { error: "Internal server error" });
    }
  }

  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  const body = event.body ? JSON.parse(event.body) : {};
  const adminPath = isAdminPath(event);
  const nowMs = Date.now();

  try {
    if (event.httpMethod === "GET") {
      const items = await listAnnouncements();
      if (adminPath) {
        if (!user.isAdmin) return json(403, { error: "Admin required" });
        return json(200, decorate(items, nowMs));
      }
      const visible = items.filter((item) => logic.isPubliclyVisible(item, nowMs));
      return json(200, decorate(visible, nowMs));
    }

    if (event.httpMethod === "POST" && adminPath) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const title = String(body.title || "").trim();
      const message = String(body.message || "").trim();
      if (!title) return json(400, { error: "Title is required." });
      if (!message) return json(400, { error: "Message is required." });
      const expiry = resolveExpiresAt(body);
      if (!expiry.ok) return json(400, { error: expiry.error });
      const id = randomUUID();
      const now = new Date().toISOString();
      const author = await actorName(event, user);
      const item = {
        PK: "ENTITY#ANNOUNCE",
        SK: `ANN#${id}`,
        announceId: id,
        title,
        message,
        active: true,
        expiresAt: expiry.expiresAt,
        createdAt: now,
        createdBy: user.email,
        createdByName: author,
        updatedAt: now,
        updatedBy: user.email,
        updatedByName: author,
      };
      await ddb.send(
        new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
      );
      return json(201, logic.withAnnouncementStatus(item, nowMs));
    }

    if (event.httpMethod === "PUT" && adminPath) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const announceId = body.announceId;
      if (!announceId) return json(400, { error: "announceId required" });
      const existing = await getAnnouncement(announceId);
      if (!existing) return json(404, { error: "Announcement not found" });
      const title =
        body.title !== undefined ? String(body.title || "").trim() : existing.title;
      const message =
        body.message !== undefined
          ? String(body.message || "").trim()
          : existing.message;
      if (!title) return json(400, { error: "Title is required." });
      if (!message) return json(400, { error: "Message is required." });
      let expiresAt = existing.expiresAt || null;
      if (body.noExpiry === true || body.expiresAt === null) {
        expiresAt = null;
      } else if (body.expiresAt !== undefined) {
        const expiry = resolveExpiresAt(body);
        if (!expiry.ok) return json(400, { error: expiry.error });
        expiresAt = expiry.expiresAt;
      }
      const now = new Date().toISOString();
      const editor = await actorName(event, user);
      const item = {
        ...existing,
        title,
        message,
        expiresAt,
        createdByName:
          existing.createdByName ||
          logic.resolveAuthorName({ email: existing.createdBy }),
        updatedAt: now,
        updatedBy: user.email,
        updatedByName: editor,
      };
      await ddb.send(
        new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
      );
      return json(200, logic.withAnnouncementStatus(item, Date.now()));
    }

    if (event.httpMethod === "DELETE" && adminPath) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      await ddb.send(
        new DeleteCommand({
          TableName: process.env.WORK_TABLE,
          Key: { PK: "ENTITY#ANNOUNCE", SK: `ANN#${body.announceId}` },
        })
      );
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Announcements error:", err);
    return json(500, { error: "Internal server error" });
  }
};

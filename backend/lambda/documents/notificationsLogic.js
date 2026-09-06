const { json } = require("../common/response");
const { createDocumentsStorage } = require("../common/documentsStorage");
const { normalizePath } = require("./folderRules");

const defaultStorage = createDocumentsStorage();
const DEFAULT_FEED_LIMIT = 50;

function parseNotificationRoute(path) {
  const p = normalizePath(path);
  if (/\/documents\/notifications\/feed$/.test(p)) return { kind: "feed" };
  if (/\/documents\/notifications\/mark-seen$/.test(p)) return { kind: "mark-seen" };
  return null;
}

function unreadCount(keys, lastSeenAt) {
  if (!lastSeenAt) return keys.length;
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return keys.length;
  return keys.filter((key) => {
    const name = String(key).split("/").pop() || "";
    const timestamp = name.split("_")[0];
    const ms = Date.parse(timestamp);
    return Number.isFinite(ms) && ms > seen;
  }).length;
}

async function getFeed(storage, user, query = {}) {
  const limit = query.limit != null ? Number(query.limit) : DEFAULT_FEED_LIMIT;
  const listed = await storage.listNotificationEvents({
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_FEED_LIMIT,
  });
  const cursor = await storage.readNotificationCursor(user.email);
  return json(200, {
    events: listed.events,
    unreadCount: unreadCount(listed.keys, cursor.lastSeenAt),
    lastSeenAt: cursor.lastSeenAt,
  });
}

async function markSeen(storage, user, body = {}) {
  const lastSeenAt = body.lastSeenAt || new Date().toISOString();
  const parsed = Date.parse(lastSeenAt);
  if (!Number.isFinite(parsed)) {
    return json(400, { error: "Invalid lastSeenAt" });
  }
  const iso = new Date(parsed).toISOString();
  await storage.writeNotificationCursor(user.email, iso);
  return json(200, { ok: true, lastSeenAt: iso });
}

async function handleNotificationRequest({
  user,
  method,
  body = {},
  query = {},
  route,
  storage,
}) {
  const store = storage || defaultStorage;
  try {
    if (route.kind === "feed") {
      if (method !== "GET") return json(405, { error: "Method not allowed" });
      return getFeed(store, user, query);
    }
    if (route.kind === "mark-seen") {
      if (method !== "POST") return json(405, { error: "Method not allowed" });
      return markSeen(store, user, body);
    }
    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("Document notifications error:", err);
    return json(500, { error: "Internal server error" });
  }
}

module.exports = {
  parseNotificationRoute,
  handleNotificationRequest,
  unreadCount,
};

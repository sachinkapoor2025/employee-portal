const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const {
  computeStatus,
  canJoinMeeting,
  joinLeadMinutesFromEnv,
  validateMeetingPayload,
  inviteMessage,
  cancelMessage,
  updateMessage,
  reminderMessage,
  dueReminderKinds,
  participantDisplayStatus,
  startsInMs,
  detailsChanged,
  timeChanged,
} = require("./logic");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

const TABLE = () => process.env.WORK_TABLE;
const TZ = process.env.COMPANY_TIMEZONE || "Asia/Kolkata";
const JOIN_LEAD = joinLeadMinutesFromEnv();

function normalizePath(path) {
  return String(path || "").replace(/^\/prod(?=\/)/, "");
}

function meetingRoute(path) {
  const p = normalizePath(path);
  const join = p.match(/\/meetings\/([^/]+)\/join$/);
  if (join) return { meetingId: decodeURIComponent(join[1]), action: "join" };
  const cancel = p.match(/\/admin\/meetings\/([^/]+)\/cancel$/);
  if (cancel) {
    return { meetingId: decodeURIComponent(cancel[1]), action: "cancel" };
  }
  const one = p.match(/\/(?:admin\/)?meetings\/([^/]+)$/);
  if (one) return { meetingId: decodeURIComponent(one[1]), action: "get" };
  return null;
}

function isReminderEvent(event) {
  if (!event || event.httpMethod) return false;
  if (event.reminders === true || event.source === "meeting-reminders") return true;
  if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
    return true;
  }
  return false;
}

async function putItem(item) {
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: item }));
}

async function getItem(pk, sk) {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE(), Key: { PK: pk, SK: sk } })
  );
  return res.Item || null;
}

async function deleteItem(pk, sk) {
  await ddb.send(
    new DeleteCommand({ TableName: TABLE(), Key: { PK: pk, SK: sk } })
  );
}

async function queryPk(pk, skPrefix) {
  const params = {
    TableName: TABLE(),
    KeyConditionExpression: skPrefix
      ? "PK = :pk AND begins_with(SK, :sk)"
      : "PK = :pk",
    ExpressionAttributeValues: skPrefix
      ? { ":pk": pk, ":sk": skPrefix }
      : { ":pk": pk },
  };
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({ ...params, ExclusiveStartKey })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getMeeting(meetingId) {
  if (!meetingId) return null;
  return getItem("ENTITY#MEETING", `MEETING#${meetingId}`);
}

async function listParticipants(meetingId) {
  return queryPk(`MEETING#${meetingId}`, "PARTICIPANT#");
}

async function writeNotification(email, payload) {
  if (!email) return;
  const now = new Date().toISOString();
  const id = randomUUID();
  await putItem({
    PK: `USER#${email}`,
    SK: `NOTIFY#${now}#${id}`,
    notifyId: id,
    email,
    read: false,
    createdAt: now,
    module: "MEETING",
    ...payload,
  });
}

async function notifyMany(emails, payload) {
  for (const email of emails) {
    await writeNotification(email, payload);
  }
}

function displayName(email, names = {}) {
  if (names[email]) return names[email];
  const local = String(email || "").split("@")[0] || "";
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ") || email;
}

function nameMapFromBody(body = {}) {
  const map = {};
  const src = body.participantNames || {};
  Object.keys(src).forEach((k) => {
    const email = String(k || "").trim().toLowerCase();
    const name = String(src[k] || "").trim();
    if (email && name) map[email] = name;
  });
  (body.participants || []).forEach((p) => {
    if (p && typeof p === "object") {
      const email = String(p.email || p.employeeId || "").trim().toLowerCase();
      const name = String(p.name || p.employeeName || "").trim();
      if (email && name) map[email] = name;
    }
  });
  return map;
}

async function upsertParticipant(meeting, email, names, existing) {
  const now = new Date().toISOString();
  const prev = existing || null;
  const item = {
    PK: `MEETING#${meeting.meetingId}`,
    SK: `PARTICIPANT#${email}`,
    meetingParticipantId: prev?.meetingParticipantId || randomUUID(),
    meetingId: meeting.meetingId,
    employeeId: email,
    employeeName: prev?.employeeName || displayName(email, names),
    invitedAt: prev?.invitedAt || now,
    joinTime: prev?.joinTime || null,
    leaveTime: prev?.leaveTime || null,
    attendanceStatus: prev?.attendanceStatus || "INVITED",
  };
  await putItem(item);
  await putItem({
    PK: `USER#${email}`,
    SK: `MEETING#${meeting.meetingId}`,
    meetingId: meeting.meetingId,
    email,
    invitedAt: item.invitedAt,
  });
  return { item, isNew: !prev };
}

async function removeParticipant(meetingId, email) {
  await deleteItem(`MEETING#${meetingId}`, `PARTICIPANT#${email}`);
  await deleteItem(`USER#${email}`, `MEETING#${meetingId}`);
}

async function syncParticipants(meeting, emails, names) {
  const current = await listParticipants(meeting.meetingId);
  const currentMap = new Map(
    current.map((p) => [String(p.employeeId || "").toLowerCase(), p])
  );
  const wanted = new Set(emails);
  const added = [];
  const kept = [];
  const removed = [];

  for (const email of emails) {
    const result = await upsertParticipant(
      meeting,
      email,
      names,
      currentMap.get(email)
    );
    if (result.isNew) added.push(email);
    else kept.push(email);
  }
  for (const [email] of currentMap) {
    if (!wanted.has(email)) {
      await removeParticipant(meeting.meetingId, email);
      removed.push(email);
    }
  }
  return { added, kept, removed };
}

async function clearReminders(meetingId) {
  for (const kind of ["24H", "30M", "10M"]) {
    await deleteItem(`MEETING#${meetingId}`, `REMINDER#${kind}`);
  }
}

function publicMeeting(item, opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const status = computeStatus(item, nowMs);
  const includeLink = opts.includeLink === true;
  const out = {
    meetingId: item.meetingId,
    title: item.title,
    description: item.description || "",
    meetingType: item.meetingType,
    date: item.date,
    startTime: item.startTime,
    endTime: item.endTime,
    startDateTime: item.startDateTime,
    endDateTime: item.endDateTime,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    cancelledAt: item.cancelledAt || null,
    participantCount: item.participantCount || 0,
    status,
    canJoin: canJoinMeeting(item, nowMs, JOIN_LEAD),
    joinLeadMinutes: JOIN_LEAD,
    startsInMs: startsInMs(item, nowMs),
    recurrence: item.recurrence || null,
  };
  if (includeLink) out.meetingLink = item.meetingLink;
  if (opts.ownParticipant) {
    out.myAttendanceStatus = opts.ownParticipant.attendanceStatus || "INVITED";
    out.myJoinTime = opts.ownParticipant.joinTime || null;
  }
  return out;
}

function withParticipants(meeting, participants, nowMs) {
  const status = computeStatus(meeting, nowMs);
  return participants
    .map((p) => ({
      meetingParticipantId: p.meetingParticipantId,
      employeeId: p.employeeId,
      employeeName: p.employeeName || displayName(p.employeeId),
      invitedAt: p.invitedAt,
      joinTime: p.joinTime || null,
      leaveTime: p.leaveTime || null,
      attendanceStatus: p.attendanceStatus || "INVITED",
      displayStatus: participantDisplayStatus(p, status),
    }))
    .sort((a, b) =>
      String(a.employeeName || "").localeCompare(String(b.employeeName || ""))
    );
}

async function createMeeting(user, body) {
  const parsed = validateMeetingPayload(body);
  if (parsed.error) return json(400, { error: parsed.error });
  const v = parsed.value;
  const now = new Date().toISOString();
  const id = randomUUID();
  const names = nameMapFromBody(body);
  const meeting = {
    PK: "ENTITY#MEETING",
    SK: `MEETING#${id}`,
    meetingId: id,
    title: v.title,
    description: v.description,
    meetingType: v.meetingType,
    meetingLink: v.meetingLink,
    date: v.date,
    startTime: v.startTime,
    endTime: v.endTime,
    startDateTime: v.startDateTime,
    endDateTime: v.endDateTime,
    createdBy: user.email,
    status: "SCHEDULED",
    participantCount: v.participantEmails.length,
    recurrence: null,
    createdAt: now,
    updatedAt: now,
  };
  await putItem(meeting);
  const { added } = await syncParticipants(meeting, v.participantEmails, names);
  await notifyMany(added, {
    type: "MEETING_INVITE",
    title: "Meeting invitation",
    message: inviteMessage(meeting, TZ),
    meetingId: id,
  });
  return json(201, publicMeeting(meeting, { includeLink: true }));
}

async function updateMeeting(user, body) {
  const meetingId = String(body.meetingId || "").trim();
  if (!meetingId) return json(400, { error: "meetingId is required." });
  const existing = await getMeeting(meetingId);
  if (!existing) return json(404, { error: "Meeting not found." });
  if (computeStatus(existing) === "CANCELLED") {
    return json(400, { error: "Cancelled meetings cannot be edited." });
  }
  const parsed = validateMeetingPayload(body);
  if (parsed.error) return json(400, { error: parsed.error });
  const v = parsed.value;
  const now = new Date().toISOString();
  const names = nameMapFromBody(body);
  const updated = {
    ...existing,
    PK: "ENTITY#MEETING",
    SK: `MEETING#${meetingId}`,
    title: v.title,
    description: v.description,
    meetingType: v.meetingType,
    meetingLink: v.meetingLink,
    date: v.date,
    startTime: v.startTime,
    endTime: v.endTime,
    startDateTime: v.startDateTime,
    endDateTime: v.endDateTime,
    participantCount: v.participantEmails.length,
    updatedAt: now,
    updatedBy: user.email,
  };
  await putItem(updated);
  const { added, kept } = await syncParticipants(
    updated,
    v.participantEmails,
    names
  );
  if (timeChanged(existing, updated)) {
    await clearReminders(meetingId);
  }
  await notifyMany(added, {
    type: "MEETING_INVITE",
    title: "Meeting invitation",
    message: inviteMessage(updated, TZ),
    meetingId,
  });
  if (detailsChanged(existing, updated) && kept.length) {
    await notifyMany(kept, {
      type: "MEETING_UPDATED",
      title: "Meeting updated",
      message: updateMessage(updated),
      meetingId,
    });
  }
  return json(200, publicMeeting(updated, { includeLink: true }));
}

async function cancelMeeting(user, meetingId) {
  const existing = await getMeeting(meetingId);
  if (!existing) return json(404, { error: "Meeting not found." });
  if (computeStatus(existing) === "CANCELLED") {
    return json(400, { error: "Meeting is already cancelled." });
  }
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    PK: "ENTITY#MEETING",
    SK: `MEETING#${meetingId}`,
    status: "CANCELLED",
    cancelledAt: now,
    cancelledBy: user.email,
    updatedAt: now,
  };
  await putItem(updated);
  const participants = await listParticipants(meetingId);
  const emails = participants.map((p) => p.employeeId).filter(Boolean);
  await notifyMany(emails, {
    type: "MEETING_CANCELLED",
    title: "Meeting cancelled",
    message: cancelMessage(updated, TZ),
    meetingId,
  });
  return json(200, publicMeeting(updated, { includeLink: true }));
}

async function listAdminMeetings() {
  const items = await queryPk("ENTITY#MEETING", "MEETING#");
  const nowMs = Date.now();
  const meetings = items
    .map((item) => publicMeeting(item, { includeLink: true, nowMs }))
    .sort((a, b) =>
      String(a.startDateTime || "").localeCompare(String(b.startDateTime || ""))
    );
  return json(200, meetings);
}

async function getMeetingForUser(user, meetingId, isAdminPath) {
  const item = await getMeeting(meetingId);
  if (!item) return json(404, { error: "Meeting not found." });
  const participants = await listParticipants(meetingId);
  const mine = participants.find(
    (p) => String(p.employeeId || "").toLowerCase() === user.email
  );
  if (user.isAdmin && isAdminPath) {
    return json(200, {
      ...publicMeeting(item, { includeLink: true }),
      participants: withParticipants(item, participants),
    });
  }
  if (!mine) return json(404, { error: "Meeting not found." });
  return json(200, publicMeeting(item, { ownParticipant: mine }));
}

async function listMyMeetings(user) {
  if (!user.email) return json(401, { error: "Unauthorized" });
  const index = await queryPk(`USER#${user.email}`, "MEETING#");
  const nowMs = Date.now();
  const meetings = [];
  for (const row of index) {
    const item = await getMeeting(row.meetingId);
    if (!item) continue;
    const own = await getItem(
      `MEETING#${row.meetingId}`,
      `PARTICIPANT#${user.email}`
    );
    meetings.push(publicMeeting(item, { nowMs, ownParticipant: own }));
  }
  meetings.sort((a, b) =>
    String(a.startDateTime || "").localeCompare(String(b.startDateTime || ""))
  );
  return json(200, meetings);
}

async function joinMeeting(user, meetingId) {
  if (!user.email) return json(401, { error: "Unauthorized" });
  const item = await getMeeting(meetingId);
  if (!item) return json(404, { error: "Meeting not found." });
  const participant = await getItem(
    `MEETING#${meetingId}`,
    `PARTICIPANT#${user.email}`
  );
  if (!participant) return json(404, { error: "Meeting not found." });
  if (!canJoinMeeting(item, Date.now(), JOIN_LEAD)) {
    const status = computeStatus(item);
    if (status === "CANCELLED") {
      return json(400, { error: "This meeting has been cancelled." });
    }
    if (status === "COMPLETED") {
      return json(400, { error: "This meeting has already ended." });
    }
    return json(400, {
      error: `Join opens ${JOIN_LEAD} minutes before the meeting starts.`,
    });
  }
  const now = new Date().toISOString();
  const updated = {
    ...participant,
    joinTime: participant.joinTime || now,
    attendanceStatus: "JOINED",
  };
  await putItem(updated);
  return json(200, {
    ok: true,
    meetingLink: item.meetingLink,
    joinTime: updated.joinTime,
    attendanceStatus: "JOINED",
  });
}

async function sendReminders() {
  const items = await queryPk("ENTITY#MEETING", "MEETING#");
  const nowMs = Date.now();
  let sent = 0;
  for (const meeting of items) {
    if (computeStatus(meeting, nowMs) === "CANCELLED") continue;
    const startMs = new Date(meeting.startDateTime).getTime();
    const kinds = dueReminderKinds(startMs, nowMs);
    if (!kinds.length) continue;
    const participants = await listParticipants(meeting.meetingId);
    const emails = participants.map((p) => p.employeeId).filter(Boolean);
    for (const kind of kinds) {
      const already = await getItem(
        `MEETING#${meeting.meetingId}`,
        `REMINDER#${kind}`
      );
      if (already) continue;
      await putItem({
        PK: `MEETING#${meeting.meetingId}`,
        SK: `REMINDER#${kind}`,
        kind,
        meetingId: meeting.meetingId,
        sentAt: new Date(nowMs).toISOString(),
      });
      await notifyMany(emails, {
        type: `MEETING_REMINDER_${kind}`,
        title: "Meeting reminder",
        message: reminderMessage(meeting, kind, TZ),
        meetingId: meeting.meetingId,
      });
      sent += emails.length;
    }
  }
  return { scanned: items.length, notifications: sent };
}

/**
 * Compat entry used by LeaveFunction on the already-deployed GET/POST/PUT /leave
 * routes so Meetings works before /admin/meetings exists on API Gateway.
 */
async function handleCompat(event, user, body = {}) {
  const qs = event.queryStringParameters || {};
  const action = String(body.action || qs.action || "").toLowerCase();
  const meetingId = String(body.meetingId || qs.meetingId || "").trim();
  const adminView = !!(user.isAdmin && qs.all === "true");

  if (event.httpMethod === "GET") {
    if (meetingId) return getMeetingForUser(user, meetingId, adminView);
    if (adminView) return listAdminMeetings();
    return listMyMeetings(user);
  }

  if (event.httpMethod === "POST") {
    if (action === "join") return joinMeeting(user, meetingId);
    if (!user.isAdmin) return json(403, { error: "Admin required" });
    if (action === "cancel") return cancelMeeting(user, meetingId);
    return createMeeting(user, body);
  }

  if (event.httpMethod === "PUT") {
    if (!user.isAdmin) return json(403, { error: "Admin required" });
    if (action === "cancel") return cancelMeeting(user, meetingId);
    return updateMeeting(user, body);
  }

  return json(405, { error: "Method not allowed" });
}

exports.handleCompat = handleCompat;
exports.sendReminders = sendReminders;

exports.handler = async (event) => {
  if (isReminderEvent(event)) {
    try {
      const result = await sendReminders();
      console.log("Meeting reminders", result);
      return json(200, result);
    } catch (err) {
      console.error("Meeting reminders error:", err);
      return json(500, { error: "Reminder run failed" });
    }
  }

  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  const path = event.path || "";
  const isAdminPath = normalizePath(path).includes("/admin/");
  const route = meetingRoute(path);
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  try {
    if (event.httpMethod === "GET" && isAdminPath && !route) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      return await listAdminMeetings();
    }

    if (event.httpMethod === "GET" && route?.action === "get") {
      if (isAdminPath && !user.isAdmin) {
        return json(403, { error: "Admin required" });
      }
      return await getMeetingForUser(user, route.meetingId, isAdminPath);
    }

    if (event.httpMethod === "GET" && !isAdminPath) {
      return await listMyMeetings(user);
    }

    if (event.httpMethod === "POST" && isAdminPath && !route) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      return await createMeeting(user, body);
    }

    if (event.httpMethod === "PUT" && isAdminPath && !route) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      if (String(body.action || "").toLowerCase() === "cancel") {
        return await cancelMeeting(user, body.meetingId);
      }
      return await updateMeeting(user, body);
    }

    if (
      event.httpMethod === "POST" &&
      isAdminPath &&
      route?.action === "cancel"
    ) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      return await cancelMeeting(user, route.meetingId);
    }

    if (event.httpMethod === "POST" && route?.action === "join") {
      return await joinMeeting(user, route.meetingId);
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Meetings error:", err);
    return json(500, { error: "Internal server error" });
  }
};

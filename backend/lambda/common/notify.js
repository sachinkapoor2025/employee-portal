const { randomUUID } = require("crypto");
const {
  GetCommand,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");
const { sendEmail } = require("./email");

const MAX_ATTEMPTS = 5;

function reminderKey(type, dedupKey) {
  return `REMINDER#${type}#${dedupKey}`;
}

async function writeInAppNotification(ddb, email, payload) {
  if (!email || !process.env.WORK_TABLE) return;
  const now = new Date().toISOString();
  const id = randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: process.env.WORK_TABLE,
      Item: {
        PK: `USER#${email}`,
        SK: `NOTIFY#${now}#${id}`,
        notifyId: id,
        email,
        read: false,
        createdAt: now,
        ...payload,
      },
    })
  );
}

async function getReminder(ddb, email, type, dedupKey) {
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: {
        PK: `USER#${email}`,
        SK: reminderKey(type, dedupKey),
      },
    })
  );
  return res.Item || null;
}

function resolveChannels({ channel, emailEnabled, inAppEnabled }) {
  const mode = String(channel || "").toLowerCase();
  if (mode === "email") return { emailEnabled: true, inAppEnabled: false };
  if (mode === "inapp" || mode === "in-app") {
    return { emailEnabled: false, inAppEnabled: true };
  }
  return {
    emailEnabled: emailEnabled !== false,
    inAppEnabled: inAppEnabled !== false,
  };
}

function shouldSkip(existing, cooldownMs, nowMs, { requireMessageId = false } = {}) {
  if (!existing) return false;
  const attempts = Number(existing.attempts || 0);
  const status = String(existing.status || "").toUpperCase();
  if (status === "SENT") {
    if (requireMessageId && !existing.messageId) return false;
    if (!cooldownMs) return true;
    const sentAt = existing.sentAt ? Date.parse(existing.sentAt) : 0;
    return Number.isFinite(sentAt) && nowMs - sentAt < cooldownMs;
  }
  if (attempts >= MAX_ATTEMPTS) return true;
  return false;
}

async function saveReminder(ddb, item) {
  await ddb.send(
    new PutCommand({
      TableName: process.env.WORK_TABLE,
      Item: item,
    })
  );
}

/**
 * Send a tracked email + in-app notification.
 * Dedupes on WORK_TABLE REMINDER#{type}#{dedupKey}.
 * Marks SENT only when SES returns a MessageId.
 */
async function dispatchNotification(ddb, {
  email,
  type,
  title,
  subject,
  message,
  html,
  reason,
  dedupKey,
  cooldownMs = 0,
  extra = {},
  channel,
  emailEnabled,
  inAppEnabled,
}) {
  const channels = resolveChannels({ channel, emailEnabled, inAppEnabled });
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !type || !dedupKey) {
    return { skipped: true, status: "FAILED", error: "INVALID_NOTIFICATION" };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const existing = await getReminder(ddb, normalized, type, dedupKey);

  if (shouldSkip(existing, cooldownMs, nowMs, { requireMessageId: channels.emailEnabled })) {
    console.log(
      "NOTIFICATION_SKIPPED",
      JSON.stringify({
        type,
        employee: normalized,
        reason,
        status: existing.status || "SENT",
      })
    );
    return { skipped: true, status: existing.status || "SENT" };
  }

  const attempts = Number(existing?.attempts || 0) + 1;
  const nextStatus = existing ? "RETRYING" : "PENDING";
  const baseItem = {
    PK: `USER#${normalized}`,
    SK: reminderKey(type, dedupKey),
    email: normalized,
    type,
    reason: reason || message,
    dedupKey,
    status: nextStatus,
    attempts,
    updatedAt: nowIso,
    createdAt: existing?.createdAt || nowIso,
    inAppWritten: existing?.inAppWritten || false,
    channel: channels.emailEnabled && channels.inAppEnabled
      ? "both"
      : channels.emailEnabled
        ? "email"
        : "inapp",
    meta: extra,
  };

  await saveReminder(ddb, baseItem);

  let result = { ok: true, messageId: "" };
  if (channels.emailEnabled) {
    result = await sendEmail({
      to: normalized,
      subject: subject || title,
      text: message,
      html,
    });
    console.log(
      "EMAIL_ATTEMPT",
      JSON.stringify({
        type,
        employee: normalized,
        reason,
        ok: !!result.ok,
        error: result.error || null,
        messageId: result.messageId || null,
      })
    );
  }

  if (channels.inAppEnabled && !baseItem.inAppWritten) {
    try {
      await writeInAppNotification(ddb, normalized, {
        type,
        title,
        message,
        ...extra,
      });
      baseItem.inAppWritten = true;
    } catch (err) {
      console.error("IN_APP_NOTIFY_FAILED", err?.name);
    }
  }

  const emailOk = !channels.emailEnabled || result.ok;
  const inAppOk = !channels.inAppEnabled || baseItem.inAppWritten;
  if (!emailOk || !inAppOk) {
    const error = result.error || (!inAppOk ? "IN_APP_NOTIFY_FAILED" : "SEND_FAILED");
    await saveReminder(ddb, {
      ...baseItem,
      status: "FAILED",
      lastError: error,
      messageId: result.messageId || null,
    });
    console.error(
      "NOTIFICATION_FAILED",
      JSON.stringify({
        type,
        employee: normalized,
        reason,
        status: "FAILED",
        messageId: result.messageId || null,
        error,
        attempts,
      })
    );
    return { skipped: false, status: "FAILED", error, attempts };
  }

  await saveReminder(ddb, {
    ...baseItem,
    status: "SENT",
    sentAt: nowIso,
    messageId: result.messageId || null,
    lastError: null,
  });

  console.log(
    "NOTIFICATION_SENT",
    JSON.stringify({
      type,
      employee: normalized,
      reason,
      status: "SENT",
      messageId: result.messageId,
      attempts,
    })
  );

  return {
    skipped: false,
    status: "SENT",
    messageId: result.messageId,
    attempts,
  };
}

module.exports = {
  dispatchNotification,
  writeInAppNotification,
  reminderKey,
  shouldSkip,
  MAX_ATTEMPTS,
};

const { PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const escalation = require("./escalation");
const { redAdminNotifyCopy } = require("./zoneNotify");
const { sendEmail } = require("../common/email");

function isConditionalCheckFailed(err) {
  return String(err?.name || "") === "ConditionalCheckFailedException";
}

function staleBeforeIso(nowIso, nowMs, staleMs) {
  const ms = Number.isFinite(nowMs) ? nowMs : Date.parse(nowIso);
  const windowMs = Number.isFinite(staleMs)
    ? staleMs
    : escalation.RED_ADMIN_CLAIM_STALE_MS;
  return new Date(ms - windowMs).toISOString();
}

function recipientHasMessageId(map, email) {
  const addr = escalation.normalizeEmail(email);
  if (!addr) return false;
  const entry = map && map[addr];
  return !!(entry && String(entry.messageId || "").trim());
}

function normalizeRecipientMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const addr = escalation.normalizeEmail(key);
    if (!addr || !value || typeof value !== "object") continue;
    const messageId = String(value.messageId || "").trim();
    if (!messageId) continue;
    out[addr] = {
      messageId,
      notifiedAt: value.notifiedAt || "",
    };
  }
  return out;
}

function allIntendedRecipientsDelivered(map, emails) {
  const intended = [];
  const seen = new Set();
  for (const email of emails || []) {
    const addr = escalation.normalizeEmail(email);
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    intended.push(addr);
  }
  if (!intended.length) return false;
  return intended.every((addr) => recipientHasMessageId(map, addr));
}

/**
 * Exclusive DynamoDB claim: NOT_SENT/PENDING/FAILED → SENDING.
 * Concurrent claimants lose the conditional put and must not send.
 * Recipients map is copied from the loaded item so retries keep MessageIds.
 */
async function claimRedAdminNotify(ddb, {
  tableName,
  item,
  nowIso,
  nowMs = Date.now(),
  staleMs = escalation.RED_ADMIN_CLAIM_STALE_MS,
}) {
  if (!tableName || !item || !item.PK || !item.SK) return { ok: false, reason: "INVALID_ITEM" };
  const claimed = {
    ...item,
    redAdminNotifyStatus: "SENDING",
    redAdminNotifyClaimedAt: nowIso,
    redAdminNotifyRecipients: normalizeRecipientMap(item.redAdminNotifyRecipients),
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: claimed,
        ConditionExpression:
          "attribute_not_exists(redAdminNotifyStatus) OR attribute_type(redAdminNotifyStatus, :nullType) OR redAdminNotifyStatus = :pending OR redAdminNotifyStatus = :failed OR (redAdminNotifyStatus = :sending AND redAdminNotifyClaimedAt < :staleBefore)",
        ExpressionAttributeValues: {
          ":nullType": "NULL",
          ":pending": "PENDING",
          ":failed": "FAILED",
          ":sending": "SENDING",
          ":staleBefore": staleBeforeIso(nowIso, nowMs, staleMs),
        },
      })
    );
    return { ok: true, item: claimed };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { ok: false, reason: "ALREADY_CLAIMED" };
    }
    throw err;
  }
}

/** Persist SENT or FAILED only while this invocation still owns SENDING. */
async function finalizeRedAdminNotify(ddb, { tableName, item, status, nowIso }) {
  if (!tableName || !item || !item.PK || !item.SK) {
    return { ok: false, reason: "INVALID_ITEM" };
  }
  const nextStatus = String(status || "").toUpperCase() === "SENT" ? "SENT" : "FAILED";
  const names = {};
  const values = { ":sending": "SENDING", ":next": nextStatus };
  let update = "SET redAdminNotifyStatus = :next";
  if (nextStatus === "SENT") {
    update += ", redAdminNotifiedAt = if_not_exists(redAdminNotifiedAt, :notifiedAt)";
    values[":notifiedAt"] = item.redAdminNotifiedAt || nowIso;
  }
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: update,
        ConditionExpression: "redAdminNotifyStatus = :sending",
        ExpressionAttributeValues: values,
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ReturnValues: "ALL_NEW",
      })
    );
    return {
      ok: true,
      item: res.Attributes || { ...item, redAdminNotifyStatus: nextStatus },
      status: nextStatus,
    };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { ok: false, reason: "NOT_OWNER", status: nextStatus };
    }
    throw err;
  }
}

/** Record one admin MessageId without clearing other recipients. Requires SENDING. */
async function persistRedAdminRecipient(ddb, {
  tableName,
  key,
  email,
  messageId,
  notifiedAt,
}) {
  const addr = escalation.normalizeEmail(email);
  const id = String(messageId || "").trim();
  if (!tableName || !key || !addr || !id) return { ok: false, reason: "INVALID_RECIPIENT" };
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: "SET redAdminNotifyRecipients.#addr = :entry",
        ConditionExpression:
          "redAdminNotifyStatus = :sending AND attribute_not_exists(redAdminNotifyRecipients.#addr.messageId)",
        ExpressionAttributeNames: { "#addr": addr },
        ExpressionAttributeValues: {
          ":sending": "SENDING",
          ":entry": { messageId: id, notifiedAt: notifiedAt || new Date().toISOString() },
        },
        ReturnValues: "ALL_NEW",
      })
    );
    return { ok: true, item: res.Attributes };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { ok: false, reason: "ALREADY_RECORDED" };
    }
    throw err;
  }
}

/**
 * Red Zone alert: SES email to every active admin. Never writes an in-app bell.
 * Skips admins who already have a persisted MessageId for this assignment.
 */
async function notifyAdminsTaskEnteredRed({
  task,
  assignment,
  redAt,
  adminEmails,
  getAssigneeProfile,
  getProjectName,
  sendEmail: sendEmailFn,
  persistRecipient,
  existingRecipients,
  nowMs = Date.now(),
  nowIso,
}) {
  const mailer = typeof sendEmailFn === "function" ? sendEmailFn : sendEmail;
  const taskId = task.taskId;
  const title = task.title || "";
  const assignmentEmail = escalation.normalizeEmail(assignment.email);
  const emails = Array.isArray(adminEmails) ? adminEmails : [];
  const delivered = normalizeRecipientMap(
    existingRecipients || assignment.redAdminNotifyRecipients
  );
  const notifiedAt = nowIso || new Date(nowMs).toISOString();
  if (!emails.length) {
    console.log(
      "RED_ADMIN_NOTIFY_SKIPPED",
      JSON.stringify({
        taskId,
        assignmentEmail,
        title,
        reason: "no active administrators",
      })
    );
    return "FAILED";
  }

  let profile = {};
  if (typeof getAssigneeProfile === "function") {
    profile = (await getAssigneeProfile(assignment.email)) || {};
  }
  const employeeName =
    escalation.pickPersonName(profile.name) ||
    escalation.displayNameFromEmail(assignment.email);
  let projectName = "";
  if (typeof getProjectName === "function" && task.projectId) {
    try {
      projectName = (await getProjectName(task.projectId)) || "";
    } catch {
      projectName = "";
    }
  }
  const deadlineMs = escalation.parseDeadlineMs(task.dueDate);
  const overdueLabel = Number.isFinite(deadlineMs)
    ? escalation.formatDuration(Math.max(0, nowMs - deadlineMs))
    : "";
  const portalBase = String(process.env.PORTAL_URL || "https://login.mydgv.com").replace(
    /\/$/,
    ""
  );
  const viewTaskUrl = taskId ? `${portalBase}/admin/tasks/${encodeURIComponent(taskId)}` : "";
  const copy = redAdminNotifyCopy({
    employeeName,
    employeeEmail: assignmentEmail,
    title: task.title,
    projectName,
    status: assignment.status || "",
    deadline: task.dueDate,
    redZoneStartedAt: redAt,
    overdueLabel,
    priority: task.priority ? escalation.priorityLabel(task.priority) : "",
    description: task.description || "",
    viewTaskUrl,
  });
  console.log(
    "RED_ADMIN_NOTIFY_TRIGGERED",
    JSON.stringify({
      taskId,
      assignmentEmail,
      title,
      recipients: emails.length,
    })
  );

  let failed = 0;
  let sent = 0;
  let skipped = 0;
  for (const email of emails) {
    const recipient = escalation.normalizeEmail(email);
    if (!recipient) continue;
    if (recipientHasMessageId(delivered, recipient)) {
      skipped += 1;
      console.log(
        "RED_ADMIN_EMAIL_SKIPPED",
        JSON.stringify({
          taskId,
          recipient,
          reason: "already delivered",
        })
      );
      continue;
    }
    try {
      const result = await mailer({
        to: recipient,
        subject: copy.subject || copy.title,
        text: copy.message,
        html: copy.html,
      });
      if (!result || !result.ok || !result.messageId) {
        failed += 1;
        console.error(
          "EMAIL_SEND_FAILED",
          JSON.stringify({
            taskId,
            assignmentEmail,
            title,
            recipient,
            status: "FAILED",
            error: result?.error || "EMAIL_NO_MESSAGE_ID",
          })
        );
        continue;
      }
      const entry = {
        messageId: String(result.messageId).trim(),
        notifiedAt,
      };
      delivered[recipient] = entry;
      sent += 1;
      if (typeof persistRecipient === "function") {
        try {
          await persistRecipient(recipient, entry);
        } catch (persistErr) {
          console.error(
            "RED_ADMIN_RECIPIENT_PERSIST_FAILED",
            JSON.stringify({ taskId, recipient })
          );
          console.error(persistErr);
        }
      }
      console.log(
        "RED_ADMIN_EMAIL_SENT",
        JSON.stringify({
          taskId,
          recipient,
          messageId: entry.messageId,
        })
      );
    } catch (err) {
      failed += 1;
      console.error(
        "EMAIL_SEND_FAILED",
        JSON.stringify({
          taskId,
          assignmentEmail,
          title,
          recipient,
          status: "FAILED",
        })
      );
      console.error(err);
    }
  }

  if (allIntendedRecipientsDelivered(delivered, emails)) {
    console.log(
      "RED_ADMIN_NOTIFY_SENT",
      JSON.stringify({
        taskId,
        assignmentEmail,
        title,
        recipients: emails.length,
        sent,
        skipped,
      })
    );
    return "SENT";
  }
  console.error(
    "RED_ADMIN_EMAIL_FAILED",
    JSON.stringify({
      taskId,
      assignmentEmail,
      title,
      status: "FAILED",
      sent,
      skipped,
      failed,
    })
  );
  return "FAILED";
}

module.exports = {
  notifyAdminsTaskEnteredRed,
  claimRedAdminNotify,
  finalizeRedAdminNotify,
  persistRedAdminRecipient,
  isConditionalCheckFailed,
  recipientHasMessageId,
  normalizeRecipientMap,
  allIntendedRecipientsDelivered,
};

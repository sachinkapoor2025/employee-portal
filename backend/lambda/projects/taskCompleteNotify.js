const { ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { dispatchNotification } = require("../common/notify");
const { adminNotifyRecipientsForTask } = require("./workflowAccess");
const { activeCompletionAdminEmailsFromAccess } = require("../common/roles");
const { isConditionalCheckFailed } = require("./taskNotifyPersist");
const { notifyFromAddress, notifyFromName } = require("./notifyFrom");
const escalation = require("./escalation");

const TYPE_COMPLETED_EMAIL = "TASK_COMPLETED_EMAIL";
const STATUS_SENDING = "SENDING";
const STATUS_SENT = "SENT";
const STATUS_FAILED = "FAILED";
const STATUS_SKIPPED = "SKIPPED";
const CLAIM_STALE_MS = 180000;
const EMAIL_CLAIM_MAX_ATTEMPTS = 5;

function portalBaseUrl() {
  return String(process.env.PORTAL_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function adminTaskUrl(taskId) {
  const base = portalBaseUrl();
  const id = String(taskId || "").trim();
  if (!base || !id) return "";
  return `${base}/admin/tasks/${encodeURIComponent(id)}`;
}

function safeLine(raw, fallback = "") {
  return String(raw || fallback)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function displayName(name, email) {
  const n = safeLine(name);
  const e = safeLine(email);
  if (n && e && n.toLowerCase() !== e.toLowerCase()) return `${n} (${e})`;
  return n || e;
}

function completedEmailKey(taskId, adminEmail) {
  return `${taskId}#${escalation.normalizeEmail(adminEmail)}#task-completed`;
}

async function scanAccessRows(ddb, accessTable) {
  if (!ddb || !accessTable) return [];
  const items = [];
  let lastKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: accessTable,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

function buildCompletionEmail({
  title,
  assigneeName,
  assigneeEmail,
  completedByName,
  completedByEmail,
  projectName,
  completedAt,
  taskId,
}) {
  const safeTitle = safeLine(title, "a task");
  const assignee = displayName(assigneeName, assigneeEmail);
  const completer = displayName(completedByName, completedByEmail);
  const project = safeLine(projectName);
  const when = safeLine(completedAt);
  const subject = `Task completed: ${safeTitle}`;
  const lines = [
    `Task "${safeTitle}" was marked completed.`,
    assignee ? `Assigned to: ${assignee}` : "",
    completer ? `Completed by: ${completer}` : "",
    project ? `Project: ${project}` : "",
    when ? `Completed at: ${when}` : "",
  ].filter(Boolean);
  const portal = adminTaskUrl(taskId);
  if (portal) lines.push(`Portal: ${portal}`);
  const text = lines.join("\n");
  const html = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  return { subject, title: subject, text, html };
}

async function claimCompletionEmail(ddb, tableName, taskId, nowIso, nowMs) {
  const staleIso = new Date(
    (Number.isFinite(nowMs) ? nowMs : Date.now()) - CLAIM_STALE_MS
  ).toISOString();
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: "ENTITY#TASK", SK: `TASK#${taskId}` },
        ConditionExpression:
          "#taskStatus = :done AND (attribute_not_exists(#emailStatus) OR #emailStatus = :failed OR (#emailStatus = :sending AND #claimed < :stale)) AND (attribute_not_exists(#attempts) OR #attempts < :maxAttempts)",
        UpdateExpression:
          "SET #emailStatus = :sending, #claimed = :now, updatedAt = :now ADD #attempts :one",
        ExpressionAttributeNames: {
          "#taskStatus": "status",
          "#emailStatus": "completionEmailStatus",
          "#claimed": "completionEmailClaimedAt",
          "#attempts": "completionEmailAttempts",
        },
        ExpressionAttributeValues: {
          ":done": "DONE",
          ":sending": STATUS_SENDING,
          ":failed": STATUS_FAILED,
          ":stale": staleIso,
          ":now": nowIso,
          ":one": 1,
          ":maxAttempts": EMAIL_CLAIM_MAX_ATTEMPTS,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    return { ok: true, task: res.Attributes || {} };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { ok: false, reason: "ALREADY_CLAIMED" };
    }
    throw err;
  }
}

async function finalizeCompletionEmail(ddb, tableName, taskId, status, extra = {}) {
  const nowIso = extra.nowIso || new Date().toISOString();
  const values = {
    ":sending": STATUS_SENDING,
    ":next": status,
    ":now": nowIso,
  };
  let update =
    "SET completionEmailStatus = :next, completionEmailUpdatedAt = :now, updatedAt = :now";
  if (extra.error) {
    update += ", completionEmailError = :error";
    values[":error"] = String(extra.error).slice(0, 180);
  }
  if (extra.recipientCount != null) {
    update += ", completionEmailRecipientCount = :count";
    values[":count"] = Number(extra.recipientCount) || 0;
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: "ENTITY#TASK", SK: `TASK#${taskId}` },
        ConditionExpression: "completionEmailStatus = :sending",
        UpdateExpression: update,
        ExpressionAttributeValues: values,
      })
    );
    return { ok: true };
  } catch (err) {
    if (isConditionalCheckFailed(err)) return { ok: false, reason: "NOT_OWNER" };
    throw err;
  }
}

async function notifyTaskCompleted({
  ddb,
  tableName = process.env.WORK_TABLE,
  accessTable = process.env.USER_ACCESS_TABLE,
  task = {},
  completedBy,
  completedByName,
  completedAt,
  nowMs,
  listAccessRows,
  projectName,
} = {}) {
  const taskId = task.taskId;
  if (!ddb || !tableName || !taskId) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }
  if (!escalation.isComplete(task.status)) {
    return { skipped: true, reason: "NOT_COMPLETED" };
  }
  const nowIso = completedAt || task.completedDate || new Date().toISOString();
  const clock = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

  let claimed;
  try {
    claimed = await claimCompletionEmail(ddb, tableName, taskId, nowIso, clock);
  } catch (err) {
    console.error(
      "TASK_COMPLETED_EMAIL_CLAIM_ERROR",
      JSON.stringify({ taskId })
    );
    console.error(err);
    return { skipped: true, reason: "CLAIM_ERROR" };
  }
  if (!claimed.ok) {
    console.log(
      "TASK_COMPLETED_EMAIL_SKIPPED",
      JSON.stringify({ taskId, reason: claimed.reason || "already sent" })
    );
    return { skipped: true, reason: claimed.reason || "ALREADY_CLAIMED" };
  }

  let recipients = [];
  try {
    const rows =
      typeof listAccessRows === "function"
        ? await listAccessRows()
        : await scanAccessRows(ddb, accessTable);
    recipients = activeCompletionAdminEmailsFromAccess(rows);
    const scoped = await adminNotifyRecipientsForTask({
      ddb,
      tableName,
      projectId: task.projectId,
      fallbackEmails: recipients,
    });
    if (!scoped.ok) {
      throw new Error("RESTRICTED_RECIPIENT_LOOKUP_FAILED");
    }
    recipients = scoped.emails;
  } catch (err) {
    console.error(
      "TASK_COMPLETED_EMAIL_RECIPIENT_ERROR",
      JSON.stringify({ taskId })
    );
    console.error(err);
    await finalizeCompletionEmail(ddb, tableName, taskId, STATUS_FAILED, {
      nowIso,
      error: "RECIPIENT_LOOKUP_FAILED",
      recipientCount: 0,
    });
    return { skipped: false, status: STATUS_FAILED, error: "RECIPIENT_LOOKUP_FAILED" };
  }

  if (!recipients.length) {
    console.warn(
      "TASK_COMPLETED_EMAIL_NO_RECIPIENTS",
      JSON.stringify({ taskId })
    );
    await finalizeCompletionEmail(ddb, tableName, taskId, STATUS_SKIPPED, {
      nowIso,
      error: "NO_ADMIN_RECIPIENTS",
      recipientCount: 0,
    });
    return { skipped: false, status: STATUS_SKIPPED, reason: "NO_ADMIN_RECIPIENTS" };
  }

  const copy = buildCompletionEmail({
    title: task.title,
    assigneeEmail: task.assignee || (task.assignees || [])[0],
    completedByEmail: completedBy,
    completedByName,
    projectName,
    completedAt: nowIso,
    taskId,
  });
  const from = notifyFromAddress();
  const fromName = notifyFromName();
  let sent = 0;
  let failed = 0;
  for (const to of recipients) {
    try {
      const result = await dispatchNotification(ddb, {
        email: to,
        type: TYPE_COMPLETED_EMAIL,
        title: copy.title,
        subject: copy.subject,
        message: copy.text,
        html: copy.html,
        reason: TYPE_COMPLETED_EMAIL,
        dedupKey: completedEmailKey(taskId, to),
        extra: { taskId },
        channel: "email",
        emailEnabled: true,
        inAppEnabled: false,
        from,
        fromName,
      });
      if (result?.status === "SENT" && result.messageId) sent += 1;
      else if (result?.skipped && result.status === "SENT") sent += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      console.error(
        "TASK_COMPLETED_EMAIL_FAILED",
        JSON.stringify({ taskId, to, error: err?.name || "SEND_FAILED" })
      );
    }
  }

  const nextStatus = sent > 0 ? STATUS_SENT : STATUS_FAILED;
  await finalizeCompletionEmail(ddb, tableName, taskId, nextStatus, {
    nowIso,
    error: sent > 0 ? null : "SEND_FAILED",
    recipientCount: recipients.length,
  });
  return {
    skipped: false,
    status: nextStatus,
    sent,
    failed,
    recipients: recipients.length,
  };
}

module.exports = {
  TYPE_COMPLETED_EMAIL,
  EMAIL_CLAIM_MAX_ATTEMPTS,
  completedEmailKey,
  escapeHtml,
  buildCompletionEmail,
  claimCompletionEmail,
  notifyTaskCompleted,
};

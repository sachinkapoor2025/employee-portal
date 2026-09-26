const { ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { dispatchNotification } = require("../common/notify");
const { buildProfessionalEmail } = require("../common/emailLayout");
const { adminNotifyRecipientsForTask } = require("./workflowAccess");
const { activeCompletionAdminEmailsFromAccess } = require("../common/roles");
const { isConditionalCheckFailed } = require("./taskNotifyPersist");
const { notifyFromAddress, notifyFromName } = require("./notifyFrom");
const { formatWhen } = require("./zoneNotify");
const escalation = require("./escalation");

const TYPE_COMPLETED_EMAIL = "TASK_COMPLETED_EMAIL";
const STATUS_SENDING = "SENDING";
const STATUS_SENT = "SENT";
const STATUS_FAILED = "FAILED";
const STATUS_SKIPPED = "SKIPPED";
const CLAIM_STALE_MS = 180000;
const EMAIL_CLAIM_MAX_ATTEMPTS = 5;

function portalBaseUrl() {
  return String(process.env.PORTAL_URL || "https://login.mydgv.com")
    .trim()
    .replace(/\/+$/, "");
}

function adminTaskUrl(taskId) {
  const base = portalBaseUrl();
  const id = String(taskId || "").trim();
  if (!base || !id) return "";
  return `${base}/admin/tasks/${encodeURIComponent(id)}`;
}

function employeeTaskUrl(taskId) {
  const base = portalBaseUrl();
  const id = String(taskId || "").trim();
  if (!base || !id) return "";
  return `${base}/work/${encodeURIComponent(id)}`;
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

function personLabel(name, email) {
  return (
    escalation.pickPersonName(name) ||
    escalation.displayNameFromEmail(email)
  );
}

function textField(label, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return `${label}:\n${text}\n\n`;
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
  employeeName,
  employeeEmail,
  assigneeName,
  assigneeEmail,
  completedByName,
  completedByEmail,
  projectName,
  priority,
  category,
  startDate,
  dueDate,
  completedAt,
  completionRemark,
  taskId,
  recipientKind = "admin",
  timeZone,
} = {}) {
  const taskName = safeLine(title, "Untitled task") || "Untitled task";
  const employee = personLabel(
    employeeName || assigneeName,
    employeeEmail || assigneeEmail
  );
  const completer = personLabel(completedByName, completedByEmail);
  const priorityText = priority ? escalation.priorityLabel(priority) : "";
  const startLabel = startDate ? formatWhen(startDate, timeZone) : "";
  const dueLabel = dueDate ? formatWhen(dueDate, timeZone) : "";
  const when = completedAt ? formatWhen(completedAt, timeZone) : "";
  const remark = String(completionRemark || "").trim();
  const isEmployee = String(recipientKind || "").toLowerCase() === "employee";
  const link = isEmployee ? employeeTaskUrl(taskId) : adminTaskUrl(taskId);
  const subject = `Task Completed: ${taskName}`;
  const intro = `${taskName} has been completed and approved.`;

  const message =
    `${subject}\n\n` +
    `${intro}\n\n` +
    `TASK DETAILS\n\n` +
    `Task:\n${taskName}\n\n` +
    textField("Project", projectName) +
    textField("Priority", priorityText) +
    textField("Category", category) +
    textField("Employee", employee) +
    textField("Completed By", completer) +
    textField("Completed At", when) +
    textField("Start", startLabel) +
    textField("Due", dueLabel) +
    (remark ? `Completion Remark:\n${remark}\n\n` : "") +
    (link ? `View Task:\n${link}` : "");

  const html = buildProfessionalEmail({
    variant: "success",
    title: "Task completed",
    intro,
    sections: [
      {
        heading: "TASK DETAILS",
        rows: [
          { label: "Task", value: taskName },
          { label: "Project", value: projectName },
          { label: "Priority", value: priorityText },
          { label: "Category", value: category },
          { label: "Employee", value: employee },
          { label: "Completed By", value: completer },
          { label: "Completed At", value: when },
          { label: "Start", value: startLabel },
          { label: "Due", value: dueLabel },
        ],
      },
      remark ? { heading: "COMPLETION REMARK", body: remark } : null,
    ].filter(Boolean),
    cta: link ? { href: link, label: "VIEW TASK" } : undefined,
  });

  return { subject, title: subject, text: message, html };
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

async function sendCompletionCopy(ddb, { to, copy, taskId, from, fromName }) {
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
  if (result?.status === "SENT" && result.messageId) return "sent";
  if (result?.skipped && result.status === "SENT") return "sent";
  return "failed";
}

async function notifyTaskCompleted({
  ddb,
  tableName = process.env.WORK_TABLE,
  accessTable = process.env.USER_ACCESS_TABLE,
  task = {},
  assignment,
  employeeEmail,
  employeeName,
  completedBy,
  completedByName,
  completedAt,
  completionRemark,
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
  const nowIso = completedAt || assignment?.completedAt || task.completedDate || new Date().toISOString();
  const clock = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const employee = escalation.normalizeEmail(
    employeeEmail || assignment?.email || ""
  );
  const remark = String(
    completionRemark || assignment?.completionRemark || ""
  ).trim();

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

  let adminRecipients = [];
  try {
    const rows =
      typeof listAccessRows === "function"
        ? await listAccessRows()
        : await scanAccessRows(ddb, accessTable);
    const fallback = activeCompletionAdminEmailsFromAccess(rows);
    const scoped = await adminNotifyRecipientsForTask({
      ddb,
      tableName,
      projectId: task.projectId,
      fallbackEmails: fallback,
    });
    if (!scoped.ok) {
      throw new Error("RESTRICTED_RECIPIENT_LOOKUP_FAILED");
    }
    adminRecipients = [...new Set(scoped.emails || [])]
      .map((email) => escalation.normalizeEmail(email))
      .filter((email) => email && email !== employee);
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

  if (!adminRecipients.length && !employee) {
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

  const copyFields = {
    title: task.title,
    employeeName,
    employeeEmail: employee,
    assigneeEmail: employee || task.assignee || (task.assignees || [])[0],
    completedByEmail: completedBy,
    completedByName,
    projectName,
    priority: task.priority,
    category: task.category,
    startDate: task.startDate,
    dueDate: task.dueDate,
    completedAt: nowIso,
    completionRemark: remark,
    taskId,
  };
  const from = notifyFromAddress();
  const fromName = notifyFromName();
  let sent = 0;
  let failed = 0;

  async function sendKind(to, recipientKind) {
    const copy = buildCompletionEmail({ ...copyFields, recipientKind });
    try {
      const outcome = await sendCompletionCopy(ddb, {
        to,
        copy,
        taskId,
        from,
        fromName,
      });
      if (outcome === "sent") sent += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      console.error(
        "TASK_COMPLETED_EMAIL_FAILED",
        JSON.stringify({ taskId, to, error: err?.name || "SEND_FAILED" })
      );
    }
  }

  if (employee) {
    await sendKind(employee, "employee");
  }
  for (const to of adminRecipients) {
    await sendKind(to, "admin");
  }

  const recipientCount = adminRecipients.length + (employee ? 1 : 0);
  const nextStatus = sent > 0 ? STATUS_SENT : STATUS_FAILED;
  await finalizeCompletionEmail(ddb, tableName, taskId, nextStatus, {
    nowIso,
    error: sent > 0 ? null : "SEND_FAILED",
    recipientCount,
  });
  return {
    skipped: false,
    status: nextStatus,
    sent,
    failed,
    recipients: recipientCount,
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
  adminTaskUrl,
  employeeTaskUrl,
};

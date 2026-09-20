const { GetCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { dispatchNotification } = require("../common/notify");
const { activeSuperAdminEmailsFromAccess } = require("../common/roles");
const { notifyFromAddress, notifyFromName } = require("./notifyFrom");
const escalation = require("./escalation");

const TYPE_EMPLOYEE_INAPP = "TASK_ASSIGNED";
const TYPE_EMPLOYEE_EMAIL = "TASK_IMPORT_ASSIGNED_EMAIL";
const TYPE_ADMIN_INAPP = "TASK_ASSIGNED";
const TYPE_ADMIN_EMAIL = "TASK_IMPORT_ASSIGNED_ADMIN_EMAIL";

function assignedNotifyKey(taskId, email) {
  return `${taskId}#${escalation.normalizeEmail(email)}#assigned`;
}

function assignedEmailKey(taskId, email) {
  return `${taskId}#${escalation.normalizeEmail(email)}#assigned-email`;
}

function adminAssignedNotifyKey(taskId, assigneeEmail, adminEmail) {
  return `${taskId}#${escalation.normalizeEmail(assigneeEmail)}#admin#${escalation.normalizeEmail(adminEmail)}#assigned`;
}

function adminAssignedEmailKey(taskId, assigneeEmail, adminEmail) {
  return `${taskId}#${escalation.normalizeEmail(assigneeEmail)}#admin#${escalation.normalizeEmail(adminEmail)}#assigned-email`;
}

function portalBaseUrl() {
  return String(process.env.PORTAL_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function employeePortalUrl() {
  const base = portalBaseUrl();
  return base ? `${base}/work` : "";
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

class AccessLookupError extends Error {
  constructor(message, extra = {}) {
    super(message || "UserAccess lookup failed");
    this.name = "AccessLookupError";
    this.retryable = true;
    this.email = extra.email || "";
    if (extra.cause) this.cause = extra.cause;
  }
}

function wrapAccessLookupError(err, email) {
  if (err instanceof AccessLookupError) return err;
  return new AccessLookupError("UserAccess lookup failed", {
    email,
    cause: err,
  });
}

async function getAccessRow(ddb, accessTable, email, loadUserAccess) {
  const normalized = escalation.normalizeEmail(email);
  if (!normalized) return null;
  if (typeof loadUserAccess === "function") {
    try {
      return await loadUserAccess(normalized);
    } catch (err) {
      console.error(
        "TASK_IMPORT_ASSIGN_ACCESS_ERROR",
        JSON.stringify({ email: normalized })
      );
      console.error(err);
      throw wrapAccessLookupError(err, normalized);
    }
  }
  if (!ddb || !accessTable) {
    throw new AccessLookupError("UserAccess table is not configured", {
      email: normalized,
    });
  }
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: accessTable,
        Key: { PK: normalized, SK: normalized },
      })
    );
    return res.Item || null;
  } catch (err) {
    console.error(
      "TASK_IMPORT_ASSIGN_ACCESS_ERROR",
      JSON.stringify({ email: normalized })
    );
    console.error(err);
    throw wrapAccessLookupError(err, normalized);
  }
}

function isActiveAccess(row) {
  return String(row?.status || "").toUpperCase() === "ACTIVE";
}

async function listSuperAdminEmails({ ddb, accessTable, listAccessRows }) {
  const rows =
    typeof listAccessRows === "function"
      ? await listAccessRows()
      : await scanAccessRows(ddb, accessTable);
  return activeSuperAdminEmailsFromAccess(rows);
}

function employeeCopy({ title, batchId, kind }) {
  const safeTitle = safeLine(title, "a task");
  const subject = `New task assigned: ${safeTitle}`;
  const lines = [
    `You have been assigned "${safeTitle}".`,
    kind === "scheduled"
      ? "This scheduled Excel task is now active."
      : "This task was assigned from an Excel import.",
  ];
  if (batchId) lines.push(`Import reference: ${safeLine(batchId)}`);
  const portal = employeePortalUrl();
  if (portal) lines.push(`Portal: ${portal}`);
  const text = lines.join("\n");
  const html = `<p>${escapeHtml(lines[0])}</p><p>${escapeHtml(lines[1])}</p>${
    batchId
      ? `<p>Import reference: ${escapeHtml(batchId)}</p>`
      : ""
  }${portal ? `<p>Portal: ${escapeHtml(portal)}</p>` : ""}`;
  return { title: subject, subject, text, html };
}

function adminCopy({
  title,
  assigneeName,
  assigneeEmail,
  batchId,
  assignedByName,
  assignedByEmail,
  kind,
  taskId,
}) {
  const safeTitle = safeLine(title, "a task");
  const assignee = displayName(assigneeName, assigneeEmail);
  const assigner = displayName(assignedByName, assignedByEmail);
  const subject =
    kind === "scheduled"
      ? `Scheduled task assigned: ${safeTitle}`
      : `Excel task assigned: ${safeTitle}`;
  const lines = [
    `Task "${safeTitle}" was assigned to ${assignee}.`,
    kind === "scheduled"
      ? "The scheduled activation time was reached and the employee is active."
      : "The task was assigned from a completed Excel import.",
  ];
  if (assigner) lines.push(`Assigned by: ${assigner}`);
  if (batchId) lines.push(`Import reference: ${safeLine(batchId)}`);
  const portal = adminTaskUrl(taskId);
  if (portal) lines.push(`Portal: ${portal}`);
  const text = lines.join("\n");
  const html = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  return {
    title: subject,
    subject,
    text,
    html,
    inAppTitle: `Task assigned: ${safeTitle}`,
    inAppMessage: `${assignee} was assigned "${safeTitle}".`,
  };
}

async function sendChannel(ddb, payload) {
  try {
    return await dispatchNotification(ddb, payload);
  } catch (err) {
    console.error(
      "TASK_IMPORT_ASSIGN_NOTIFY_ERROR",
      JSON.stringify({
        type: payload?.type || null,
        email: payload?.email || null,
      })
    );
    console.error(err);
    return { skipped: true, status: "FAILED", error: err?.name || "NOTIFY_ERROR" };
  }
}

async function notifyExcelAssignment({
  ddb,
  accessTable,
  task = {},
  assigneeEmails = [],
  kind = "immediate",
  listAccessRows,
} = {}) {
  const taskId = task.taskId;
  const title = task.title || "a task";
  const batchId = task.importBatchId || "";
  const assignedByEmail = escalation.normalizeEmail(task.createdBy || task.assignedBy);
  const assignedByName = task.createdByName || "";
  const emails = [
    ...new Set(
      (assigneeEmails || [])
        .map((email) => escalation.normalizeEmail(email))
        .filter(Boolean)
    ),
  ];
  if (!ddb || !taskId || !emails.length) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }

  let superAdmins = [];
  try {
    superAdmins = await listSuperAdminEmails({ ddb, accessTable, listAccessRows });
  } catch (err) {
    console.error(
      "TASK_IMPORT_ASSIGN_RECIPIENT_ERROR",
      JSON.stringify({ taskId })
    );
    console.error(err);
  }

  const from = notifyFromAddress();
  const fromName = notifyFromName();
  const results = [];

  for (const assignee of emails) {
    const employee = employeeCopy({ title, batchId, kind });
    results.push(
      await sendChannel(ddb, {
        email: assignee,
        type: TYPE_EMPLOYEE_INAPP,
        title: employee.title,
        subject: employee.subject,
        message: employee.text,
        html: employee.html,
        reason: TYPE_EMPLOYEE_INAPP,
        dedupKey: assignedNotifyKey(taskId, assignee),
        extra: { taskId, importBatchId: batchId || undefined },
        channel: "inapp",
        emailEnabled: false,
        inAppEnabled: true,
        inAppSk: `NOTIFY#TASK_ASSIGNED#${assignedNotifyKey(taskId, assignee)}`,
      })
    );
    results.push(
      await sendChannel(ddb, {
        email: assignee,
        type: TYPE_EMPLOYEE_EMAIL,
        title: employee.title,
        subject: employee.subject,
        message: employee.text,
        html: employee.html,
        reason: TYPE_EMPLOYEE_EMAIL,
        dedupKey: assignedEmailKey(taskId, assignee),
        extra: { taskId, importBatchId: batchId || undefined },
        channel: "email",
        emailEnabled: true,
        inAppEnabled: false,
        from,
        fromName,
      })
    );

    const admin = adminCopy({
      title,
      assigneeEmail: assignee,
      batchId,
      assignedByName,
      assignedByEmail,
      kind,
      taskId,
    });
    for (const adminEmail of superAdmins) {
      if (adminEmail === assignee) continue;
      results.push(
        await sendChannel(ddb, {
          email: adminEmail,
          type: TYPE_ADMIN_INAPP,
          title: admin.inAppTitle,
          subject: admin.subject,
          message: admin.inAppMessage,
          html: admin.html,
          reason: TYPE_ADMIN_INAPP,
          dedupKey: adminAssignedNotifyKey(taskId, assignee, adminEmail),
          extra: { taskId, importBatchId: batchId || undefined, assigneeEmail: assignee },
          channel: "inapp",
          emailEnabled: false,
          inAppEnabled: true,
          inAppSk: `NOTIFY#TASK_ASSIGNED#${adminAssignedNotifyKey(taskId, assignee, adminEmail)}`,
        })
      );
      results.push(
        await sendChannel(ddb, {
          email: adminEmail,
          type: TYPE_ADMIN_EMAIL,
          title: admin.title,
          subject: admin.subject,
          message: admin.text,
          html: admin.html,
          reason: TYPE_ADMIN_EMAIL,
          dedupKey: adminAssignedEmailKey(taskId, assignee, adminEmail),
          extra: { taskId, importBatchId: batchId || undefined, assigneeEmail: assignee },
          channel: "email",
          emailEnabled: true,
          inAppEnabled: false,
          from,
          fromName,
        })
      );
    }
  }

  return { skipped: false, results };
}

module.exports = {
  TYPE_EMPLOYEE_EMAIL,
  TYPE_ADMIN_EMAIL,
  assignedNotifyKey,
  assignedEmailKey,
  adminAssignedNotifyKey,
  adminAssignedEmailKey,
  AccessLookupError,
  getAccessRow,
  isActiveAccess,
  listSuperAdminEmails,
  notifyExcelAssignment,
};

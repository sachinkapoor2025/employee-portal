const { ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { dispatchNotification } = require("../common/notify");
const { buildProfessionalEmail } = require("../common/emailLayout");
const { adminNotifyRecipientsForTask } = require("./workflowAccess");
const { activeCompletionAdminEmailsFromAccess } = require("../common/roles");
const { notifyFromAddress, notifyFromName } = require("./notifyFrom");
const { formatWhen } = require("./zoneNotify");
const { getProjectName } = require("./projectManage");
const escalation = require("./escalation");

const TYPE_BLOCKER_REPORTED = "TASK_BLOCKER_REPORTED";
const TYPE_BLOCKER_REPORTED_EMAIL = "TASK_BLOCKER_REPORTED_EMAIL";
const TYPE_BLOCKER_RESOLVED = "TASK_BLOCKER_RESOLVED";
const TYPE_BLOCKER_RESOLVED_EMAIL = "TASK_BLOCKER_RESOLVED_EMAIL";
const ADMIN_BLOCKERS_PATH = "/admin/blockers";
const EMPLOYEE_WORK_PATH = "/work";

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
  return `${base}${EMPLOYEE_WORK_PATH}/${encodeURIComponent(id)}`;
}

function blockerNotifyKey(taskId, assignmentEmail, reportedAt) {
  return `${String(taskId || "").trim()}#${escalation.normalizeEmail(assignmentEmail)}#${reportedAt || ""}#blocker-reported`;
}

function blockerReportedEmailKey(taskId, assignmentEmail, recipientEmail) {
  return `${String(taskId || "").trim()}#${escalation.normalizeEmail(assignmentEmail)}#${escalation.normalizeEmail(recipientEmail)}#blocker-reported`;
}

function blockerResolvedNotifyKey(taskId, assignmentEmail, resolvedAt) {
  return `${String(taskId || "").trim()}#${escalation.normalizeEmail(assignmentEmail)}#${resolvedAt || ""}#blocker-resolved`;
}

function blockerResolvedEmailKey(taskId, assignmentEmail, resolvedAt) {
  return `${String(taskId || "").trim()}#${escalation.normalizeEmail(assignmentEmail)}#${resolvedAt || ""}#blocker-resolved`;
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

function employeeLabel(email) {
  return (
    escalation.displayNameFromEmail(email) ||
    escalation.normalizeEmail(email) ||
    "Employee"
  );
}

function personLabel(name, email) {
  return (
    escalation.pickPersonName(name) ||
    employeeLabel(email)
  );
}

function textField(label, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return `${label}:\n${text}\n\n`;
}

function blockerReportedCopy({
  title,
  projectName,
  priority,
  category,
  employeeName,
  employeeEmail,
  startDate,
  dueDate,
  blockerRemark,
  reportedAt,
  viewTaskUrl,
  timeZone,
} = {}) {
  const taskName = String(title || "Untitled task").trim() || "Untitled task";
  const employee = personLabel(employeeName, employeeEmail);
  const priorityText = priority ? escalation.priorityLabel(priority) : "";
  const startLabel = startDate ? formatWhen(startDate, timeZone) : "";
  const dueLabel = dueDate ? formatWhen(dueDate, timeZone) : "";
  const reportedLabel = reportedAt ? formatWhen(reportedAt, timeZone) : "";
  const remark = String(blockerRemark || "").trim();
  const link = String(viewTaskUrl || "").trim();
  const subject = `Task Blocker Reported: ${taskName}`;
  const intro = `${employee || "An employee"} reported a blocker on "${taskName}". Admin action may be required.`;

  const message =
    `${subject}\n\n` +
    `${intro}\n\n` +
    `TASK DETAILS\n\n` +
    `Task:\n${taskName}\n\n` +
    textField("Project", projectName) +
    textField("Priority", priorityText) +
    textField("Category", category) +
    textField("Employee", employee) +
    textField("Start", startLabel) +
    textField("Due", dueLabel) +
    textField("Reported At", reportedLabel) +
    (remark ? `Blocker Remark:\n${remark}\n\n` : "") +
    (link ? `View Task:\n${link}` : "");

  const html = buildProfessionalEmail({
    variant: "urgent",
    title: "Task blocker reported",
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
          { label: "Start", value: startLabel },
          { label: "Due", value: dueLabel },
          { label: "Reported At", value: reportedLabel },
        ],
      },
      remark
        ? {
            heading: "BLOCKER REMARK",
            body: remark,
          }
        : null,
    ].filter(Boolean),
    cta: link ? { href: link, label: "VIEW TASK" } : undefined,
  });

  return {
    type: TYPE_BLOCKER_REPORTED_EMAIL,
    title: subject,
    subject,
    message,
    html,
  };
}

async function sendBlockerReportedEmails({
  ddb,
  tableName,
  taskId,
  task,
  employee,
  employeeName,
  remark,
  reportedAt,
  projectName,
  emailRecipients,
}) {
  const resolvedProjectName =
    String(projectName || "").trim() ||
    (await getProjectName(ddb, tableName, task.projectId));
  const copy = blockerReportedCopy({
    title: task.title,
    projectName: resolvedProjectName,
    priority: task.priority,
    category: task.category,
    employeeName,
    employeeEmail: employee,
    startDate: task.startDate,
    dueDate: task.dueDate,
    blockerRemark: remark,
    reportedAt,
    viewTaskUrl: adminTaskUrl(taskId),
  });
  const from = notifyFromAddress();
  const fromName = notifyFromName();
  let sent = 0;
  let failed = 0;
  for (const to of emailRecipients) {
    try {
      const result = await dispatchNotification(ddb, {
        email: to,
        type: copy.type,
        title: copy.title,
        subject: copy.subject,
        message: copy.message,
        html: copy.html,
        reason: copy.type,
        dedupKey: blockerReportedEmailKey(taskId, employee, to),
        extra: { taskId, assignmentEmail: employee },
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
        "TASK_BLOCKER_REPORTED_EMAIL_FAILED",
        JSON.stringify({ taskId, to, error: err?.name || "SEND_FAILED" })
      );
    }
  }
  return {
    sent,
    failed,
    recipients: emailRecipients.length,
    status: sent > 0 ? "SENT" : emailRecipients.length ? "FAILED" : "SKIPPED",
  };
}

/**
 * Best-effort in-app alert after a blocker is already persisted.
 * Failures are logged and never thrown to the caller.
 */
async function notifyBlockerReported({
  ddb,
  tableName = process.env.WORK_TABLE,
  accessTable = process.env.USER_ACCESS_TABLE,
  task = {},
  assignmentEmail,
  employeeName,
  remark,
  reportedAt,
  projectName,
  listAccessRows,
} = {}) {
  const taskId = String(task.taskId || "").trim();
  const employee = escalation.normalizeEmail(assignmentEmail);
  if (!ddb || !taskId || !employee) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }
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
      console.error(
        "TASK_BLOCKER_REPORTED_RECIPIENT_ERROR",
        JSON.stringify({ taskId })
      );
      return { skipped: true, reason: "RECIPIENT_LOOKUP_FAILED" };
    }
    const adminEmails = [...new Set(scoped.emails || [])]
      .map((email) => escalation.normalizeEmail(email))
      .filter(Boolean);
    const recipients = adminEmails.filter((email) => email !== employee);
    const taskTitle = String(task.title || taskId).trim() || taskId;
    const title = "Task Blocker Reported";
    const message = `${employeeLabel(employee)} reported a blocker on "${taskTitle}".`;
    const extra = {
      taskId,
      assignmentEmail: employee,
      taskTitle,
      blockerRemark: String(remark || "").trim() || null,
      path: ADMIN_BLOCKERS_PATH,
    };
    const key = blockerNotifyKey(taskId, employee, reportedAt);
    const results = [];
    for (const adminEmail of recipients) {
      results.push(
        await dispatchNotification(ddb, {
          email: adminEmail,
          type: TYPE_BLOCKER_REPORTED,
          title,
          subject: title,
          message,
          reason: TYPE_BLOCKER_REPORTED,
          dedupKey: `${key}#${adminEmail}`,
          extra,
          channel: "inapp",
          emailEnabled: false,
          inAppEnabled: true,
          inAppSk: `NOTIFY#${TYPE_BLOCKER_REPORTED}#${key}#${adminEmail}`,
        })
      );
    }
    let emailResult = { sent: 0, failed: 0, recipients: 0, status: "SKIPPED" };
    try {
      emailResult = await sendBlockerReportedEmails({
        ddb,
        tableName,
        taskId,
        task,
        employee,
        employeeName,
        remark,
        reportedAt,
        projectName,
        emailRecipients: adminEmails,
      });
    } catch (err) {
      console.error(
        "TASK_BLOCKER_REPORTED_EMAIL_ERROR",
        JSON.stringify({ taskId })
      );
      console.error(err);
    }
    return { skipped: false, recipients, results, email: emailResult };
  } catch (err) {
    console.error(
      "TASK_BLOCKER_REPORTED_NOTIFY_ERROR",
      JSON.stringify({ taskId })
    );
    console.error(err);
    return { skipped: true, reason: "NOTIFY_FAILED" };
  }
}

function blockerResolvedCopy({
  title,
  projectName,
  blockerRemark,
  resolvedByName,
  resolvedByEmail,
  resolvedAt,
  viewTaskUrl,
  timeZone,
} = {}) {
  const taskName = String(title || "Untitled task").trim() || "Untitled task";
  const resolver = personLabel(resolvedByName, resolvedByEmail);
  const resolvedLabel = resolvedAt ? formatWhen(resolvedAt, timeZone) : "";
  const remark = String(blockerRemark || "").trim();
  const link = String(viewTaskUrl || "").trim();
  const resolution = "The blocker has been resolved.";
  const subject = `Blocker Resolved: ${taskName}`;
  const intro = `The blocker on "${taskName}" has been resolved.`;

  const message =
    `${subject}\n\n` +
    `${intro}\n\n` +
    `TASK DETAILS\n\n` +
    `Task:\n${taskName}\n\n` +
    textField("Project", projectName) +
    (remark ? `Blocker:\n${remark}\n\n` : "") +
    `Resolution:\n${resolution}\n\n` +
    textField("Resolved By", resolver) +
    textField("Resolved", resolvedLabel) +
    (link ? `View Task:\n${link}` : "");

  const html = buildProfessionalEmail({
    variant: "success",
    title: "Blocker resolved",
    intro,
    sections: [
      {
        heading: "TASK DETAILS",
        rows: [
          { label: "Task", value: taskName },
          { label: "Project", value: projectName },
          { label: "Blocker", value: remark },
          { label: "Resolution", value: resolution },
          { label: "Resolved By", value: resolver },
          { label: "Resolved", value: resolvedLabel },
        ],
      },
    ],
    cta: link ? { href: link, label: "VIEW TASK" } : undefined,
  });

  return {
    type: TYPE_BLOCKER_RESOLVED_EMAIL,
    title: subject,
    subject,
    message,
    html,
  };
}

async function sendBlockerResolvedEmail({
  ddb,
  tableName,
  taskId,
  task,
  employee,
  remark,
  resolvedAt,
  resolvedBy,
  resolvedByName,
  projectName,
}) {
  const resolvedProjectName =
    String(projectName || "").trim() ||
    (await getProjectName(ddb, tableName, task.projectId));
  const copy = blockerResolvedCopy({
    title: task.title,
    projectName: resolvedProjectName,
    blockerRemark: remark,
    resolvedByName,
    resolvedByEmail: resolvedBy,
    resolvedAt,
    viewTaskUrl: employeeTaskUrl(taskId),
  });
  const from = notifyFromAddress();
  const fromName = notifyFromName();
  try {
    const result = await dispatchNotification(ddb, {
      email: employee,
      type: copy.type,
      title: copy.title,
      subject: copy.subject,
      message: copy.message,
      html: copy.html,
      reason: copy.type,
      dedupKey: blockerResolvedEmailKey(taskId, employee, resolvedAt),
      extra: { taskId, assignmentEmail: employee },
      channel: "email",
      emailEnabled: true,
      inAppEnabled: false,
      from,
      fromName,
    });
    const sent =
      (result?.status === "SENT" && result.messageId) ||
      (result?.skipped && result.status === "SENT")
        ? 1
        : 0;
    return {
      sent,
      failed: sent ? 0 : 1,
      recipients: 1,
      status: sent ? "SENT" : "FAILED",
    };
  } catch (err) {
    console.error(
      "TASK_BLOCKER_RESOLVED_EMAIL_FAILED",
      JSON.stringify({ taskId, to: employee, error: err?.name || "SEND_FAILED" })
    );
    return { sent: 0, failed: 1, recipients: 1, status: "FAILED" };
  }
}

/**
 * Best-effort employee alert after a blocker is already resolved.
 * Failures are logged and never thrown to the caller.
 */
async function notifyBlockerResolved({
  ddb,
  tableName = process.env.WORK_TABLE,
  task = {},
  assignmentEmail,
  remark,
  resolvedAt,
  resolvedBy,
  resolvedByName,
  projectName,
} = {}) {
  const taskId = String(task.taskId || "").trim();
  const employee = escalation.normalizeEmail(assignmentEmail);
  if (!ddb || !taskId || !employee) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }
  try {
    const taskTitle = String(task.title || taskId).trim() || taskId;
    const title = "Blocker Resolved";
    const message = `The blocker on "${taskTitle}" has been resolved.`;
    const extra = {
      taskId,
      assignmentEmail: employee,
      taskTitle,
      blockerRemark: String(remark || "").trim() || null,
      path: `${EMPLOYEE_WORK_PATH}/${encodeURIComponent(taskId)}`,
    };
    const key = blockerResolvedNotifyKey(taskId, employee, resolvedAt);
    const inApp = await dispatchNotification(ddb, {
      email: employee,
      type: TYPE_BLOCKER_RESOLVED,
      title,
      subject: title,
      message,
      reason: TYPE_BLOCKER_RESOLVED,
      dedupKey: `${key}#${employee}`,
      extra,
      channel: "inapp",
      emailEnabled: false,
      inAppEnabled: true,
      inAppSk: `NOTIFY#${TYPE_BLOCKER_RESOLVED}#${key}#${employee}`,
    });
    let emailResult = { sent: 0, failed: 0, recipients: 0, status: "SKIPPED" };
    try {
      emailResult = await sendBlockerResolvedEmail({
        ddb,
        tableName,
        taskId,
        task,
        employee,
        remark,
        resolvedAt,
        resolvedBy,
        resolvedByName,
        projectName,
      });
    } catch (err) {
      console.error(
        "TASK_BLOCKER_RESOLVED_EMAIL_ERROR",
        JSON.stringify({ taskId })
      );
      console.error(err);
    }
    return {
      skipped: false,
      recipient: employee,
      inApp,
      email: emailResult,
    };
  } catch (err) {
    console.error(
      "TASK_BLOCKER_RESOLVED_NOTIFY_ERROR",
      JSON.stringify({ taskId })
    );
    console.error(err);
    return { skipped: true, reason: "NOTIFY_FAILED" };
  }
}

module.exports = {
  TYPE_BLOCKER_REPORTED,
  TYPE_BLOCKER_REPORTED_EMAIL,
  TYPE_BLOCKER_RESOLVED,
  TYPE_BLOCKER_RESOLVED_EMAIL,
  ADMIN_BLOCKERS_PATH,
  blockerNotifyKey,
  blockerReportedEmailKey,
  blockerResolvedNotifyKey,
  blockerResolvedEmailKey,
  adminTaskUrl,
  employeeTaskUrl,
  blockerReportedCopy,
  blockerResolvedCopy,
  notifyBlockerReported,
  notifyBlockerResolved,
};

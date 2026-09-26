const { ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { dispatchNotification } = require("../common/notify");
const { buildProfessionalEmail } = require("../common/emailLayout");
const { adminNotifyRecipientsForTask } = require("./workflowAccess");
const { activeCompletionAdminEmailsFromAccess } = require("../common/roles");
const { notifyFromAddress, notifyFromName } = require("./notifyFrom");
const { formatWhen } = require("./zoneNotify");
const escalation = require("./escalation");

const TYPE_REVIEW_SUBMITTED_EMAIL = "TASK_SUBMITTED_FOR_REVIEW_EMAIL";

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

function reviewSubmittedEmailKey(taskId, assignmentEmail, adminEmail) {
  return `${taskId}#${escalation.normalizeEmail(assignmentEmail)}#${escalation.normalizeEmail(adminEmail)}#review-submitted`;
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

function reviewSubmittedCopy({
  title,
  projectName,
  priority,
  category,
  employeeName,
  employeeEmail,
  startDate,
  dueDate,
  completionRemark,
  viewTaskUrl,
  timeZone,
} = {}) {
  const taskName = String(title || "Untitled task").trim() || "Untitled task";
  const employee = personLabel(employeeName, employeeEmail);
  const priorityText = priority ? escalation.priorityLabel(priority) : "";
  const startLabel = startDate ? formatWhen(startDate, timeZone) : "";
  const dueLabel = dueDate ? formatWhen(dueDate, timeZone) : "";
  const remark = String(completionRemark || "").trim();
  const link = String(viewTaskUrl || "").trim();
  const subject = `Task Submitted for Review: ${taskName}`;
  const intro = `A task has been submitted by ${employee || "an employee"} and is waiting for your review.`;

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
    (remark ? `Review Submission Remark:\n${remark}\n\n` : "") +
    (link ? `Review Task:\n${link}` : "");

  const html = buildProfessionalEmail({
    variant: "warning",
    title: "Task submitted for review",
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
        ],
      },
      remark
        ? {
            heading: "REVIEW SUBMISSION REMARK",
            body: remark,
          }
        : null,
    ].filter(Boolean),
    cta: link ? { href: link, label: "REVIEW TASK" } : undefined,
  });

  return {
    type: TYPE_REVIEW_SUBMITTED_EMAIL,
    title: subject,
    subject,
    message,
    html,
  };
}

async function notifyTaskSubmittedForReview({
  ddb,
  tableName = process.env.WORK_TABLE,
  accessTable = process.env.USER_ACCESS_TABLE,
  task = {},
  employeeEmail,
  employeeName,
  completionRemark,
  projectName,
  listAccessRows,
} = {}) {
  const taskId = String(task.taskId || "").trim();
  const employee = escalation.normalizeEmail(employeeEmail);
  if (!ddb || !tableName || !taskId || !employee) {
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
        "TASK_REVIEW_SUBMITTED_RECIPIENT_ERROR",
        JSON.stringify({ taskId })
      );
      return { skipped: true, reason: "RECIPIENT_LOOKUP_FAILED" };
    }
    const recipients = [...new Set(scoped.emails || [])]
      .map((email) => escalation.normalizeEmail(email))
      .filter((email) => email && email !== employee);
    if (!recipients.length) {
      console.log(
        "TASK_REVIEW_SUBMITTED_NO_RECIPIENTS",
        JSON.stringify({ taskId })
      );
      return { skipped: true, reason: "NO_ADMIN_RECIPIENTS" };
    }

    const copy = reviewSubmittedCopy({
      title: task.title,
      projectName,
      priority: task.priority,
      category: task.category,
      employeeName,
      employeeEmail: employee,
      startDate: task.startDate,
      dueDate: task.dueDate,
      completionRemark,
      viewTaskUrl: adminTaskUrl(taskId),
    });
    const from = notifyFromAddress();
    const fromName = notifyFromName();
    let sent = 0;
    let failed = 0;
    for (const to of recipients) {
      try {
        const result = await dispatchNotification(ddb, {
          email: to,
          type: copy.type,
          title: copy.title,
          subject: copy.subject,
          message: copy.message,
          html: copy.html,
          reason: copy.type,
          dedupKey: reviewSubmittedEmailKey(taskId, employee, to),
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
          "TASK_REVIEW_SUBMITTED_EMAIL_FAILED",
          JSON.stringify({ taskId, to, error: err?.name || "SEND_FAILED" })
        );
      }
    }
    return {
      skipped: false,
      status: sent > 0 ? "SENT" : "FAILED",
      sent,
      failed,
      recipients: recipients.length,
    };
  } catch (err) {
    console.error(
      "TASK_REVIEW_SUBMITTED_EMAIL_ERROR",
      JSON.stringify({ taskId })
    );
    console.error(err);
    return { skipped: false, status: "FAILED", error: err?.name || "NOTIFY_ERROR" };
  }
}

module.exports = {
  TYPE_REVIEW_SUBMITTED_EMAIL,
  reviewSubmittedEmailKey,
  adminTaskUrl,
  reviewSubmittedCopy,
  notifyTaskSubmittedForReview,
};

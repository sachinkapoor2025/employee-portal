const { dispatchNotification } = require("../common/notify");
const { buildProfessionalEmail } = require("../common/emailLayout");
const { notifyFromAddress, notifyFromName } = require("./notifyFrom");
const { formatWhen } = require("./zoneNotify");
const escalation = require("./escalation");

const TYPE_ASSIGNED_EMAIL = "TASK_ASSIGNED_EMAIL";
const TYPE_REVIEW_REASSIGNED_EMAIL = "TASK_REVIEW_REASSIGNED_EMAIL";

function portalBaseUrl() {
  return String(process.env.PORTAL_URL || "https://login.mydgv.com")
    .trim()
    .replace(/\/+$/, "");
}

function employeeTaskUrl(taskId) {
  const base = portalBaseUrl();
  const id = String(taskId || "").trim();
  if (!base || !id) return "";
  return `${base}/work/${encodeURIComponent(id)}`;
}

function assignedEmailKey(taskId, email, assignedAt) {
  const at = String(assignedAt || "").trim();
  const base = `${taskId}#${escalation.normalizeEmail(email)}#assigned-email`;
  return at ? `${base}#${at}` : base;
}

function reviewReassignedEmailKey(taskId, email) {
  return `${taskId}#${escalation.normalizeEmail(email)}#review-reassigned-email`;
}

function assignedByLabel(name, email) {
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

function assignedEmployeeCopy({
  kind = "assigned",
  title,
  projectName,
  priority,
  category,
  description,
  startDate,
  dueDate,
  assignedByName,
  assignedByEmail,
  reasonLabel,
  remark,
  viewTaskUrl,
  timeZone,
} = {}) {
  const taskName = String(title || "Untitled task").trim() || "Untitled task";
  const isReview = String(kind || "") === "review-reassigned";
  const subject = isReview
    ? `Task Reassigned to You: ${taskName}`
    : `Task Assigned: ${taskName}`;
  const intro = isReview
    ? "A task has been reassigned to you and is ready for action."
    : "You have been assigned a new task and it is ready for action.";
  const assigner = assignedByLabel(assignedByName, assignedByEmail);
  const startLabel = startDate ? formatWhen(startDate, timeZone) : "";
  const dueLabel = dueDate ? formatWhen(dueDate, timeZone) : "";
  const priorityText = priority ? escalation.priorityLabel(priority) : "";
  const link = String(viewTaskUrl || "").trim();
  const reasonText = String(reasonLabel || "").trim();
  const remarkText = String(remark || "").trim();

  const message =
    `${subject}\n\n` +
    `${intro}\n\n` +
    `TASK DETAILS\n\n` +
    `Task:\n${taskName}\n\n` +
    textField("Project", projectName) +
    textField("Priority", priorityText) +
    textField("Category", category) +
    textField("Description", description) +
    textField("Start", startLabel) +
    textField("Due", dueLabel) +
    textField("Assigned By", assigner) +
    (isReview ? textField("Reason", reasonText) : "") +
    (isReview ? textField("Admin Remark", remarkText) : "") +
    (link ? `View Task:\n${link}` : "");

  const rows = [
    { label: "Task", value: taskName },
    { label: "Project", value: projectName },
    { label: "Priority", value: priorityText },
    { label: "Category", value: category },
    { label: "Description", value: description },
    { label: "Start", value: startLabel },
    { label: "Due", value: dueLabel },
    { label: "Assigned By", value: assigner },
  ];
  if (isReview) {
    rows.push({ label: "Reason", value: reasonText });
    rows.push({ label: "Admin Remark", value: remarkText });
  }

  const html = buildProfessionalEmail({
    variant: isReview ? "warning" : "info",
    title: isReview ? "Task reassigned to you" : "New task assigned",
    intro,
    sections: [{ heading: "TASK DETAILS", rows }],
    cta: link ? { href: link, label: "VIEW TASK" } : undefined,
  });

  return {
    type: isReview ? TYPE_REVIEW_REASSIGNED_EMAIL : TYPE_ASSIGNED_EMAIL,
    title: subject,
    subject,
    message,
    html,
  };
}

async function notifyAssignedEmployee({
  ddb,
  task = {},
  assigneeEmail,
  assignedByName,
  assignedByEmail,
  projectName,
  kind = "assigned",
  reasonLabel,
  remark,
  assignedAt,
} = {}) {
  const email = escalation.normalizeEmail(assigneeEmail);
  const taskId = String(task.taskId || "").trim();
  if (!ddb || !email || !taskId) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }
  const isReview = String(kind || "") === "review-reassigned";
  const copy = assignedEmployeeCopy({
    kind: isReview ? "review-reassigned" : "assigned",
    title: task.title,
    projectName,
    priority: task.priority,
    category: task.category,
    description: task.description,
    startDate: task.startDate,
    dueDate: task.dueDate,
    assignedByName,
    assignedByEmail,
    reasonLabel,
    remark,
    viewTaskUrl: employeeTaskUrl(taskId),
  });
  const dedupKey = isReview
    ? reviewReassignedEmailKey(taskId, email)
    : assignedEmailKey(taskId, email, assignedAt);
  try {
    return await dispatchNotification(ddb, {
      email,
      type: copy.type,
      title: copy.title,
      subject: copy.subject,
      message: copy.message,
      html: copy.html,
      reason: copy.type,
      dedupKey,
      extra: { taskId },
      channel: "email",
      emailEnabled: true,
      inAppEnabled: false,
      from: notifyFromAddress(),
      fromName: notifyFromName(),
    });
  } catch (err) {
    console.error(
      "TASK_ASSIGNED_EMAIL_ERROR",
      JSON.stringify({ taskId, email })
    );
    console.error(err);
    return { skipped: false, status: "FAILED", error: err?.name || "NOTIFY_ERROR" };
  }
}

module.exports = {
  TYPE_ASSIGNED_EMAIL,
  TYPE_REVIEW_REASSIGNED_EMAIL,
  assignedEmailKey,
  reviewReassignedEmailKey,
  employeeTaskUrl,
  assignedEmployeeCopy,
  notifyAssignedEmployee,
};

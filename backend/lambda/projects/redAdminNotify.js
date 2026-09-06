const escalation = require("./escalation");
const { redAdminNotifyCopy } = require("./zoneNotify");
const { sendEmail } = require("../common/email");

/**
 * Red Zone alert: SES email to every active admin. Never writes an in-app bell.
 */
async function notifyAdminsTaskEnteredRed({
  task,
  assignment,
  redAt,
  adminEmails,
  getAssigneeProfile,
  getProjectName,
  sendEmail: sendEmailFn,
  nowMs = Date.now(),
}) {
  const mailer = typeof sendEmailFn === "function" ? sendEmailFn : sendEmail;
  const taskId = task.taskId;
  const title = task.title || "";
  const assignmentEmail = escalation.normalizeEmail(assignment.email);
  const emails = Array.isArray(adminEmails) ? adminEmails : [];
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
  for (const email of emails) {
    try {
      const result = await mailer({
        to: email,
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
            recipient: String(email || "").toLowerCase(),
            status: "FAILED",
            error: result?.error || "EMAIL_NO_MESSAGE_ID",
          })
        );
      } else {
        sent += 1;
        console.log(
          "RED_ADMIN_EMAIL_SENT",
          JSON.stringify({
            taskId,
            recipient: String(email || "").toLowerCase(),
            messageId: result.messageId,
          })
        );
      }
    } catch (err) {
      failed += 1;
      console.error(
        "EMAIL_SEND_FAILED",
        JSON.stringify({
          taskId,
          assignmentEmail,
          title,
          recipient: String(email || "").toLowerCase(),
          status: "FAILED",
        })
      );
      console.error(err);
    }
  }

  if (failed > 0) {
    console.error(
      "RED_ADMIN_EMAIL_FAILED",
      JSON.stringify({
        taskId,
        assignmentEmail,
        title,
        status: "FAILED",
        sent,
        failed,
      })
    );
    return "FAILED";
  }
  console.log(
    "RED_ADMIN_NOTIFY_SENT",
    JSON.stringify({
      taskId,
      assignmentEmail,
      title,
      recipients: emails.length,
      sent,
    })
  );
  return "SENT";
}

module.exports = { notifyAdminsTaskEnteredRed };

const escalation = require("./escalation");
const { redAdminNotifyCopy } = require("./zoneNotify");

/**
 * Immediate Red Zone alert to every active portal admin.
 * SENT is returned only when no admin send failed.
 */
async function notifyAdminsTaskEnteredRed({
  task,
  assignment,
  redAt,
  adminEmails,
  getAssigneeProfile,
  getProjectName,
  dispatchNotification,
  nowMs = Date.now(),
}) {
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
  const dedupKey = `${taskId}#${assignmentEmail}#red-admin#${task.dueDate || ""}`;
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
  let skipped = 0;
  let sent = 0;
  for (const email of emails) {
    try {
      const result = await dispatchNotification({
        email,
        type: copy.type,
        title: copy.title,
        subject: copy.subject || copy.title,
        message: copy.message,
        html: copy.html,
        reason: "TASK_RED_ADMIN",
        dedupKey,
        extra: {
          taskId,
          zone: "RED",
          deadline: task.dueDate || null,
          zoneStartedAt: redAt || null,
          assignmentEmail,
        },
      });
      if (result.status === "FAILED") {
        failed += 1;
        console.error(
          "EMAIL_SEND_FAILED",
          JSON.stringify({
            taskId,
            assignmentEmail,
            title,
            recipient: email,
            status: "FAILED",
            error: result.error || null,
          })
        );
      } else if (result.skipped) {
        skipped += 1;
      } else if (result.status === "SENT") {
        sent += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(
        "EMAIL_SEND_FAILED",
        JSON.stringify({
          taskId,
          assignmentEmail,
          title,
          recipient: email,
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
      })
    );
    return "FAILED";
  }
  if (skipped === emails.length) {
    console.log(
      "RED_ADMIN_NOTIFY_SKIPPED",
      JSON.stringify({
        taskId,
        assignmentEmail,
        title,
        reason: "already sent",
      })
    );
  } else {
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
  }
  return "SENT";
}

module.exports = { notifyAdminsTaskEnteredRed };

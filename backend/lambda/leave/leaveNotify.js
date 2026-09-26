const { dispatchNotification } = require("../common/notify");
const { buildProfessionalEmail } = require("../common/emailLayout");
const { notifyFromAddress, notifyFromName } = require("../projects/notifyFrom");
const { formatWhen } = require("../projects/zoneNotify");
const escalation = require("../projects/escalation");

const TYPE_LEAVE_REQUESTED_EMAIL = "LEAVE_REQUESTED_EMAIL";
const TYPE_LEAVE_APPROVED_EMAIL = "LEAVE_APPROVED_EMAIL";
const TYPE_LEAVE_REJECTED_EMAIL = "LEAVE_REJECTED_EMAIL";

function portalBaseUrl() {
  return String(process.env.PORTAL_URL || "https://login.mydgv.com")
    .trim()
    .replace(/\/+$/, "");
}

function adminLeaveUrl() {
  const base = portalBaseUrl();
  return base ? `${base}/admin/leave` : "";
}

function employeeLeaveUrl() {
  const base = portalBaseUrl();
  return base ? `${base}/leave` : "";
}

function personLabel(name, email) {
  return (
    escalation.pickPersonName(name) ||
    escalation.displayNameFromEmail(email) ||
    "Employee"
  );
}

function textField(label, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return `${label}:\n${text}\n\n`;
}

function calendarDateLabel(value) {
  const key = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const [year, month, day] = key.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }
  if (!key) return "";
  const ms = Date.parse(key);
  if (!Number.isFinite(ms)) return key;
  return formatWhen(key);
}

function durationLabel(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return "";
  return n === 1 ? "1 day" : `${n} days`;
}

function leaveTypeLabel(type) {
  const raw = String(type || "").trim();
  if (!raw) return "";
  const titled = raw
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return /leave/i.test(titled) ? titled : `${titled} Leave`;
}

function leaveRequestedEmailKey(leaveId, recipientEmail) {
  return `${String(leaveId || "").trim()}#${escalation.normalizeEmail(recipientEmail)}#requested`;
}

function leaveApprovedEmailKey(leaveId, employeeEmail) {
  return `${String(leaveId || "").trim()}#${escalation.normalizeEmail(employeeEmail)}#approved`;
}

function leaveRejectedEmailKey(leaveId, employeeEmail) {
  return `${String(leaveId || "").trim()}#${escalation.normalizeEmail(employeeEmail)}#rejected`;
}

function leaveRequestedCopy({
  employeeName,
  employeeEmail,
  leaveType,
  startDate,
  endDate,
  days,
  reason,
  submittedAt,
  viewLeaveUrl,
  timeZone,
} = {}) {
  const employee = personLabel(employeeName, employeeEmail);
  const typeLabel = leaveTypeLabel(leaveType);
  const startLabel = calendarDateLabel(startDate);
  const endLabel = calendarDateLabel(endDate);
  const duration = durationLabel(days);
  const when = submittedAt ? formatWhen(submittedAt, timeZone) : "";
  const remark = String(reason || "").trim();
  const link = String(viewLeaveUrl || "").trim();
  const subject = `Leave Request: ${employee}`;
  const intro = `${employee} submitted a leave request that needs your review.`;

  const message =
    `${subject}\n\n` +
    `${intro}\n\n` +
    `LEAVE DETAILS\n\n` +
    textField("Employee", employee) +
    textField("Leave Type", typeLabel) +
    textField("Start Date", startLabel) +
    textField("End Date", endLabel) +
    textField("Duration", duration) +
    textField("Submitted At", when) +
    (remark ? `Reason:\n${remark}\n\n` : "") +
    (link ? `Review Leave:\n${link}` : "");

  const html = buildProfessionalEmail({
    variant: "warning",
    title: "Leave request",
    intro,
    sections: [
      {
        heading: "LEAVE DETAILS",
        rows: [
          { label: "Employee", value: employee },
          { label: "Leave Type", value: typeLabel },
          { label: "Start Date", value: startLabel },
          { label: "End Date", value: endLabel },
          { label: "Duration", value: duration },
          { label: "Submitted At", value: when },
        ],
      },
      remark ? { heading: "REASON", body: remark } : null,
    ].filter(Boolean),
    cta: link ? { href: link, label: "REVIEW LEAVE" } : undefined,
  });

  return {
    type: TYPE_LEAVE_REQUESTED_EMAIL,
    title: subject,
    subject,
    message,
    html,
  };
}

function leaveApprovedCopy({
  employeeName,
  employeeEmail,
  leaveType,
  startDate,
  endDate,
  days,
  reason,
  approvedByName,
  approvedByEmail,
  approvedAt,
  viewLeaveUrl,
  timeZone,
} = {}) {
  const employee = personLabel(employeeName, employeeEmail);
  const typeLabel = leaveTypeLabel(leaveType);
  const startLabel = calendarDateLabel(startDate);
  const endLabel = calendarDateLabel(endDate);
  const duration = durationLabel(days);
  const approver = personLabel(approvedByName, approvedByEmail);
  const when = approvedAt ? formatWhen(approvedAt, timeZone) : "";
  const remark = String(reason || "").trim();
  const link = String(viewLeaveUrl || "").trim();
  const subject = `Leave Approved: ${startLabel || startDate || "Leave"}`;
  const intro = `Your leave request has been approved.`;

  const message =
    `${subject}\n\n` +
    `${intro}\n\n` +
    `LEAVE DETAILS\n\n` +
    textField("Employee", employee) +
    textField("Leave Type", typeLabel) +
    textField("Start Date", startLabel) +
    textField("End Date", endLabel) +
    textField("Duration", duration) +
    textField("Approved By", approver) +
    textField("Approved At", when) +
    (remark ? `Reason:\n${remark}\n\n` : "") +
    (link ? `View Leave:\n${link}` : "");

  const html = buildProfessionalEmail({
    variant: "success",
    title: "Leave approved",
    intro,
    sections: [
      {
        heading: "LEAVE DETAILS",
        rows: [
          { label: "Employee", value: employee },
          { label: "Leave Type", value: typeLabel },
          { label: "Start Date", value: startLabel },
          { label: "End Date", value: endLabel },
          { label: "Duration", value: duration },
          { label: "Approved By", value: approver },
          { label: "Approved At", value: when },
        ],
      },
      remark ? { heading: "REASON", body: remark } : null,
    ].filter(Boolean),
    cta: link ? { href: link, label: "VIEW LEAVE" } : undefined,
  });

  return {
    type: TYPE_LEAVE_APPROVED_EMAIL,
    title: subject,
    subject,
    message,
    html,
  };
}

function leaveRejectedCopy({
  employeeName,
  employeeEmail,
  leaveType,
  startDate,
  endDate,
  days,
  rejectedByName,
  rejectedByEmail,
  rejectedAt,
  rejectionReason,
  viewLeaveUrl,
  timeZone,
} = {}) {
  const employee = personLabel(employeeName, employeeEmail);
  const typeLabel = leaveTypeLabel(leaveType);
  const startLabel = calendarDateLabel(startDate);
  const endLabel = calendarDateLabel(endDate);
  const duration = durationLabel(days);
  const reviewer = personLabel(rejectedByName, rejectedByEmail);
  const when = rejectedAt ? formatWhen(rejectedAt, timeZone) : "";
  const remark = String(rejectionReason || "").trim();
  const link = String(viewLeaveUrl || "").trim();
  const subject = `Leave Request Update: ${startLabel || startDate || "Leave"}`;
  const intro = `Your leave request was not approved.`;

  const message =
    `${subject}\n\n` +
    `${intro}\n\n` +
    `LEAVE DETAILS\n\n` +
    textField("Employee", employee) +
    textField("Leave Type", typeLabel) +
    textField("Start Date", startLabel) +
    textField("End Date", endLabel) +
    textField("Duration", duration) +
    textField("Rejected By", reviewer) +
    textField("Rejected At", when) +
    (remark ? `Rejection Remark:\n${remark}\n\n` : "") +
    (link ? `View Leave:\n${link}` : "");

  const html = buildProfessionalEmail({
    variant: "warning",
    title: "Leave request update",
    intro,
    sections: [
      {
        heading: "LEAVE DETAILS",
        rows: [
          { label: "Employee", value: employee },
          { label: "Leave Type", value: typeLabel },
          { label: "Start Date", value: startLabel },
          { label: "End Date", value: endLabel },
          { label: "Duration", value: duration },
          { label: "Rejected By", value: reviewer },
          { label: "Rejected At", value: when },
        ],
      },
      remark ? { heading: "REJECTION REMARK", body: remark } : null,
    ].filter(Boolean),
    cta: link ? { href: link, label: "VIEW LEAVE" } : undefined,
  });

  return {
    type: TYPE_LEAVE_REJECTED_EMAIL,
    title: subject,
    subject,
    message,
    html,
  };
}

async function dispatchLeaveEmail({ ddb, to, copy, dedupKey, extra = {} }) {
  const from = notifyFromAddress();
  const fromName = notifyFromName();
  try {
    const result = await dispatchNotification(ddb, {
      email: to,
      type: copy.type,
      title: copy.title,
      subject: copy.subject,
      message: copy.message,
      html: copy.html,
      reason: copy.type,
      dedupKey,
      extra,
      channel: "email",
      emailEnabled: true,
      inAppEnabled: false,
      from,
      fromName,
    });
    if (result?.status === "SENT" && result.messageId) return { status: "SENT" };
    if (result?.skipped && result.status === "SENT") return { status: "SENT", skipped: true };
    return { status: result?.status || "FAILED", skipped: !!result?.skipped };
  } catch (err) {
    console.error(
      `${copy.type}_FAILED`,
      JSON.stringify({ to, error: err?.name || "SEND_FAILED" })
    );
    return { status: "FAILED", error: err?.name || "SEND_FAILED" };
  }
}

function leaveDates(leave = {}) {
  return {
    startDate: leave.startDate || leave.fromDate,
    endDate: leave.endDate || leave.toDate,
    days: leave.days,
    type: leave.type,
    reason: leave.reason,
    submittedAt: leave.submittedAt || leave.createdAt,
  };
}

async function notifyLeaveRequested({
  ddb,
  leave = {},
  employeeName,
  approverEmails = [],
} = {}) {
  const leaveId = String(leave.leaveId || "").trim();
  const employee = escalation.normalizeEmail(leave.email);
  if (!ddb || !leaveId || !employee) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }
  const recipients = [...new Set((approverEmails || []).map((email) => escalation.normalizeEmail(email)))]
    .filter(Boolean);
  if (!recipients.length) {
    return { skipped: true, reason: "NO_APPROVER_RECIPIENTS" };
  }
  try {
    const dates = leaveDates(leave);
    const copy = leaveRequestedCopy({
      employeeName,
      employeeEmail: employee,
      leaveType: dates.type,
      startDate: dates.startDate,
      endDate: dates.endDate,
      days: dates.days,
      reason: dates.reason,
      submittedAt: dates.submittedAt,
      viewLeaveUrl: adminLeaveUrl(),
    });
    let sent = 0;
    let failed = 0;
    for (const to of recipients) {
      const result = await dispatchLeaveEmail({
        ddb,
        to,
        copy,
        dedupKey: leaveRequestedEmailKey(leaveId, to),
        extra: { leaveId },
      });
      if (result.status === "SENT") sent += 1;
      else failed += 1;
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
      "LEAVE_REQUESTED_EMAIL_ERROR",
      JSON.stringify({ leaveId })
    );
    console.error(err);
    return { skipped: false, status: "FAILED", error: err?.name || "NOTIFY_ERROR" };
  }
}

async function notifyLeaveApproved({
  ddb,
  leave = {},
  employeeName,
  approvedByName,
} = {}) {
  const leaveId = String(leave.leaveId || "").trim();
  const employee = escalation.normalizeEmail(leave.email);
  if (!ddb || !leaveId || !employee) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }
  try {
    const dates = leaveDates(leave);
    const copy = leaveApprovedCopy({
      employeeName,
      employeeEmail: employee,
      leaveType: dates.type,
      startDate: dates.startDate,
      endDate: dates.endDate,
      days: dates.days,
      reason: dates.reason,
      approvedByName,
      approvedByEmail: leave.approvedBy,
      approvedAt: leave.approvedAt,
      viewLeaveUrl: employeeLeaveUrl(),
    });
    const result = await dispatchLeaveEmail({
      ddb,
      to: employee,
      copy,
      dedupKey: leaveApprovedEmailKey(leaveId, employee),
      extra: { leaveId },
    });
    return {
      skipped: false,
      status: result.status,
      sent: result.status === "SENT" ? 1 : 0,
      failed: result.status === "SENT" ? 0 : 1,
    };
  } catch (err) {
    console.error(
      "LEAVE_APPROVED_EMAIL_ERROR",
      JSON.stringify({ leaveId })
    );
    console.error(err);
    return { skipped: false, status: "FAILED", error: err?.name || "NOTIFY_ERROR" };
  }
}

async function notifyLeaveRejected({
  ddb,
  leave = {},
  employeeName,
  rejectedByName,
} = {}) {
  const leaveId = String(leave.leaveId || "").trim();
  const employee = escalation.normalizeEmail(leave.email);
  if (!ddb || !leaveId || !employee) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }
  try {
    const dates = leaveDates(leave);
    const copy = leaveRejectedCopy({
      employeeName,
      employeeEmail: employee,
      leaveType: dates.type,
      startDate: dates.startDate,
      endDate: dates.endDate,
      days: dates.days,
      rejectedByName,
      rejectedByEmail: leave.rejectedBy,
      rejectedAt: leave.rejectedAt,
      rejectionReason: leave.rejectionReason,
      viewLeaveUrl: employeeLeaveUrl(),
    });
    const result = await dispatchLeaveEmail({
      ddb,
      to: employee,
      copy,
      dedupKey: leaveRejectedEmailKey(leaveId, employee),
      extra: { leaveId },
    });
    return {
      skipped: false,
      status: result.status,
      sent: result.status === "SENT" ? 1 : 0,
      failed: result.status === "SENT" ? 0 : 1,
    };
  } catch (err) {
    console.error(
      "LEAVE_REJECTED_EMAIL_ERROR",
      JSON.stringify({ leaveId })
    );
    console.error(err);
    return { skipped: false, status: "FAILED", error: err?.name || "NOTIFY_ERROR" };
  }
}

module.exports = {
  TYPE_LEAVE_REQUESTED_EMAIL,
  TYPE_LEAVE_APPROVED_EMAIL,
  TYPE_LEAVE_REJECTED_EMAIL,
  adminLeaveUrl,
  employeeLeaveUrl,
  leaveRequestedEmailKey,
  leaveApprovedEmailKey,
  leaveRejectedEmailKey,
  leaveRequestedCopy,
  leaveApprovedCopy,
  leaveRejectedCopy,
  notifyLeaveRequested,
  notifyLeaveApproved,
  notifyLeaveRejected,
};

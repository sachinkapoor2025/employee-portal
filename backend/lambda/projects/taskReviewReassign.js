const escalation = require("./escalation");

const REASONS = ["CHANGES_REQUIRED", "REJECTED"];

function reasonLabel(reason) {
  const key = String(reason || "").trim().toUpperCase();
  if (key === "REJECTED") return "Rejected";
  if (key === "CHANGES_REQUIRED") return "Changes Required";
  return "";
}

function shortTaskId(taskId) {
  const compact = String(taskId || "").replace(/-/g, "").slice(0, 8).toUpperCase();
  return compact ? `TASK-${compact}` : "TASK";
}

function findReviewedAssignment(assignments, requestedEmail) {
  const active = (assignments || []).filter((a) => a && !a.removed);
  const wanted = escalation.normalizeEmail(requestedEmail);
  if (wanted) {
    return (
      active.find((a) => escalation.normalizeEmail(a.email) === wanted) || null
    );
  }
  const inReview = active.filter(
    (a) => String(a.status || "").toUpperCase() === "REVIEW"
  );
  return inReview.length === 1 ? inReview[0] : null;
}

function parseReviewReassignRequest(body, assignments) {
  const reason = String(body?.reassignmentReason || body?.reason || "")
    .trim()
    .toUpperCase();
  if (!REASONS.includes(reason)) {
    return {
      ok: false,
      statusCode: 400,
      error: "A valid reassignment reason is required.",
    };
  }
  const remark = String(body?.reassignmentRemark || body?.remark || "").trim();
  if (!remark) {
    return {
      ok: false,
      statusCode: 400,
      error: "Admin remark is required.",
    };
  }
  const reviewed = findReviewedAssignment(
    assignments,
    body?.assignmentEmail || body?.sourceAssignmentEmail
  );
  if (!reviewed) {
    return {
      ok: false,
      statusCode: 400,
      error: "Reviewed assignment not found.",
    };
  }
  if (String(reviewed.status || "").toUpperCase() !== "REVIEW") {
    return {
      ok: false,
      statusCode: 400,
      error: "Assignment is not in review.",
    };
  }
  const requested = escalation.normalizeEmailList(
    body?.assignees,
    body?.assignee
  );
  if (requested.length > 1) {
    return {
      ok: false,
      statusCode: 400,
      error: "Select a single employee for reassignment.",
    };
  }
  const targetEmail =
    requested[0] || escalation.normalizeEmail(reviewed.email);
  if (!targetEmail) {
    return {
      ok: false,
      statusCode: 400,
      error: "Please select an employee.",
    };
  }
  return {
    ok: true,
    reason,
    remark,
    reviewed,
    sourceEmail: escalation.normalizeEmail(reviewed.email),
    targetEmail,
  };
}

module.exports = {
  REASONS,
  reasonLabel,
  shortTaskId,
  findReviewedAssignment,
  parseReviewReassignRequest,
};

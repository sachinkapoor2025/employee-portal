export function normalizeProjectName(name) {
  return String(name || "").trim();
}

export function projectNamesMatch(a, b) {
  return (
    normalizeProjectName(a).toLowerCase() ===
    normalizeProjectName(b).toLowerCase()
  );
}

export function isDeletedProjectAction(action) {
  return String(action || "").toUpperCase() === "DELETED";
}

export function deleteProjectConfirmCopy(name) {
  const label = normalizeProjectName(name) || "this project";
  return {
    title: "Delete Project?",
    body: `This will permanently delete ${label}. This cannot be undone.`,
    detail:
      "Associated tasks and task-owned records will be permanently deleted, including active, completed, and archived tasks, assignments, comments, activity, and registered attachments.",
    retain:
      "Excel Import History, users, notifications, reminders, time entries, and Documents data are retained.",
    confirmLabel: `Type ${label} to confirm`,
  };
}

export function deleteProjectResultCopy(action) {
  if (String(action || "").toUpperCase() === "ARCHIVED") {
    return "";
  }
  return "Project deleted successfully.";
}

export function unexpectedDeleteActionCopy() {
  return "The project was not permanently deleted. No archive was performed from this action. You can try again if this was a temporary failure.";
}

export function deleteProjectErrorCopy(err) {
  const status = Number(err?.status);
  const code = String(err?.code || "").trim();
  let message = String(err?.message || "").trim();
  if (err?.isNetworkError) {
    message =
      "Unable to reach the server. Check your connection and try again.";
  } else if (!message) {
    if (status === 403) {
      message = "You do not have permission to delete this project.";
    } else if (status === 404) {
      message = "This project could not be found. It may have already been deleted.";
    } else if (status === 400) {
      message = "Project name confirmation does not match.";
    } else {
      message = "Unable to delete project.";
    }
  }
  if (code && !message.includes(code)) {
    message = `${message} (${code})`;
  }
  if (!/try again/i.test(message)) {
    message = `${message} You can try again if this was a temporary failure.`;
  }
  return message;
}

export function archiveProjectConfirmCopy(name) {
  const label = normalizeProjectName(name) || "this project";
  return {
    title: "Archive Project?",
    body: `Are you sure you want to archive ${label}?`,
    detail:
      "The project will no longer be available for new tasks, but existing tasks and history will be preserved.",
  };
}

export function restoreProjectConfirmCopy(name) {
  const label = normalizeProjectName(name) || "this project";
  return {
    title: "Restore Project?",
    body: `Restore ${label} and make it active again?`,
  };
}

export function emptyProjectsCopy(statusFilter) {
  const value = String(statusFilter || "ALL").toUpperCase();
  if (value === "ACTIVE") return "No active projects.";
  if (value === "ARCHIVED") return "No archived projects.";
  return "No projects found.";
}

export function projectStatusLabel(status) {
  return String(status || "ACTIVE").toUpperCase() === "ARCHIVED"
    ? "Archived"
    : "Active";
}

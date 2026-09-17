export function deleteProjectConfirmCopy() {
  return {
    title: "Delete Project?",
    body: "Are you sure you want to permanently delete this project?",
    detail:
      "Projects with existing tasks or task history cannot be permanently deleted. Archive the project instead to preserve tasks and history. Projects with no related tasks will be permanently deleted.",
  };
}

export function deleteProjectResultCopy(action) {
  if (String(action || "").toUpperCase() === "ARCHIVED") {
    return "Project archived because it contains existing tasks.";
  }
  return "Project deleted successfully.";
}

export function archiveProjectConfirmCopy(name) {
  const label = String(name || "this project").trim() || "this project";
  return {
    title: "Archive Project?",
    body: `Are you sure you want to archive ${label}?`,
    detail:
      "The project will no longer be available for new tasks, but existing tasks and history will be preserved.",
  };
}

export function restoreProjectConfirmCopy(name) {
  const label = String(name || "this project").trim() || "this project";
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

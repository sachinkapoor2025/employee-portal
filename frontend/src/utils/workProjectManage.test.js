import {
  archiveProjectConfirmCopy,
  deleteProjectConfirmCopy,
  deleteProjectResultCopy,
  emptyProjectsCopy,
  projectStatusLabel,
  restoreProjectConfirmCopy,
} from "./workProjectManage";

test("delete confirmation copy is backend-neutral", () => {
  const copy = deleteProjectConfirmCopy();
  expect(copy.title).toBe("Delete Project?");
  expect(copy.body).toBe(
    "Are you sure you want to permanently delete this project?"
  );
  expect(copy.detail).toBe(
    "Projects with existing tasks or task history cannot be permanently deleted. Archive the project instead to preserve tasks and history. Projects with no related tasks will be permanently deleted."
  );
});

test("result copy for archived vs deleted", () => {
  expect(deleteProjectResultCopy("DELETED")).toBe(
    "Project deleted successfully."
  );
  expect(deleteProjectResultCopy("ARCHIVED")).toBe(
    "Project archived because it contains existing tasks."
  );
});

test("archive and restore confirmation copy", () => {
  const archive = archiveProjectConfirmCopy("Usarakhi");
  expect(archive.title).toBe("Archive Project?");
  expect(archive.body).toBe("Are you sure you want to archive Usarakhi?");
  expect(archive.detail).toBe(
    "The project will no longer be available for new tasks, but existing tasks and history will be preserved."
  );
  const restore = restoreProjectConfirmCopy("Ticker Play");
  expect(restore.title).toBe("Restore Project?");
  expect(restore.body).toBe("Restore Ticker Play and make it active again?");
});

test("empty state and status labels", () => {
  expect(emptyProjectsCopy("ALL")).toBe("No projects found.");
  expect(emptyProjectsCopy("ACTIVE")).toBe("No active projects.");
  expect(emptyProjectsCopy("ARCHIVED")).toBe("No archived projects.");
  expect(projectStatusLabel("ACTIVE")).toBe("Active");
  expect(projectStatusLabel("ARCHIVED")).toBe("Archived");
});

import {
  archiveProjectConfirmCopy,
  deleteProjectConfirmCopy,
  deleteProjectErrorCopy,
  deleteProjectResultCopy,
  emptyProjectsCopy,
  isDeletedProjectAction,
  projectNamesMatch,
  projectStatusLabel,
  restoreProjectConfirmCopy,
  unexpectedDeleteActionCopy,
} from "./workProjectManage";

test("delete confirmation copy describes permanent deletion and retention", () => {
  const copy = deleteProjectConfirmCopy("Portal");
  expect(copy.title).toBe("Delete Project?");
  expect(copy.body).toBe(
    "This is a permanent deletion. Portal cannot be restored after it is deleted."
  );
  expect(copy.detail).toMatch(/related tasks and attachments/i);
  expect(copy.detail).not.toMatch(/automatically be archived/i);
  expect(copy.retain).toMatch(/Excel Import History/i);
  expect(copy.retain).toMatch(/Documents data are retained/i);
  expect(copy.confirmLabel).toBe("Type the project name to confirm");
  expect(copy.confirmIntro).toBe(
    "To confirm permanent deletion, type the following project name:"
  );
  expect(copy.confirmHint).toBe(
    "Enter the project name exactly as shown above."
  );
  expect(copy.confirmPlaceholder).toBe("Enter project name");
});

test("project name matching matches backend namesMatch", () => {
  expect(projectNamesMatch("Portal", " portal ")).toBe(true);
  expect(projectNamesMatch("Portal", "PORTAL")).toBe(true);
  expect(projectNamesMatch("Portal", "Other")).toBe(false);
  expect(projectNamesMatch("", "Portal")).toBe(false);
  expect(projectNamesMatch("Portal", "")).toBe(false);
  expect(projectNamesMatch("   ", "Portal")).toBe(false);
  expect(projectNamesMatch("", "")).toBe(false);
});

test("result copy for deleted vs archived", () => {
  expect(deleteProjectResultCopy("DELETED")).toBe(
    "Project deleted successfully."
  );
  expect(deleteProjectResultCopy("ARCHIVED")).toBe("");
  expect(isDeletedProjectAction("DELETED")).toBe(true);
  expect(isDeletedProjectAction("ARCHIVED")).toBe(false);
  expect(unexpectedDeleteActionCopy()).toMatch(/not permanently deleted/i);
});

test("delete error copy keeps backend codes and invites retry", () => {
  const err = new Error("Unable to delete project attachments");
  err.status = 500;
  err.code = "PROJECT_DELETE_S3_FAILED";
  expect(deleteProjectErrorCopy(err)).toBe(
    "Unable to delete project attachments (PROJECT_DELETE_S3_FAILED) You can try again if this was a temporary failure."
  );
  const conflict = new Error("This project cannot be permanently deleted.");
  conflict.status = 409;
  expect(deleteProjectErrorCopy(conflict)).toMatch(/try again/i);
  const network = new Error("offline");
  network.isNetworkError = true;
  expect(deleteProjectErrorCopy(network)).toMatch(/reach the server/i);
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

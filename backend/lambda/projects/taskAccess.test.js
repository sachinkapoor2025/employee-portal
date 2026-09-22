const assert = require("assert");
const { canViewTask } = require("./handler");

const assigned = {
  assignee: "rahul@mydgv.com",
  assignees: ["rahul@mydgv.com"],
};
const openProject = { projectId: "open-1", accessMode: "OPEN" };
const adminAccess = { role: "ADMIN", status: "ACTIVE" };

assert.strictEqual(
  canViewTask({ email: "boss@mydgv.com", isAdmin: true }, { assignee: "other@mydgv.com" }),
  false,
  "missing project context fails closed"
);
assert.strictEqual(
  canViewTask(
    { email: "admin@mydgv.com", isAdmin: true },
    assigned,
    { project: openProject, accessRow: adminAccess }
  ),
  true,
  "ACTIVE UserAccess ADMIN can open an OPEN task"
);
assert.strictEqual(
  canViewTask(
    { email: "rahul@mydgv.com", isAdmin: false },
    assigned,
    { project: openProject }
  ),
  true,
  "Employee can open an assigned OPEN task"
);
assert.strictEqual(
  canViewTask(
    { email: "other@mydgv.com", isAdmin: false },
    assigned,
    { project: openProject }
  ),
  false,
  "Employee cannot open an unassigned OPEN task"
);
assert.strictEqual(
  canViewTask({ email: "", isAdmin: false }, assigned, { project: openProject }),
  false,
  "Missing email cannot open a task"
);

console.log("task view authorization tests passed");

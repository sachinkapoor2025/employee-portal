const assert = require("assert");
const { canViewTask } = require("./handler");

const assigned = {
  assignee: "rahul@mydgv.com",
  assignees: ["rahul@mydgv.com"],
};

assert.strictEqual(
  canViewTask({ email: "boss@mydgv.com", isAdmin: true }, { assignee: "other@mydgv.com" }),
  true,
  "Super Admin / Admin group can open an authorized task"
);
assert.strictEqual(
  canViewTask({ email: "admin@mydgv.com", isAdmin: true }, assigned),
  true,
  "Project Admin (Cognito Admin) can open an authorized task"
);
assert.strictEqual(
  canViewTask({ email: "rahul@mydgv.com", isAdmin: false }, assigned),
  true,
  "Employee can open an assigned task"
);
assert.strictEqual(
  canViewTask({ email: "other@mydgv.com", isAdmin: false }, assigned),
  false,
  "Employee cannot open an unassigned task"
);
assert.strictEqual(
  canViewTask({ email: "", isAdmin: false }, assigned),
  false,
  "Missing email cannot open a task"
);

console.log("task view authorization tests passed");

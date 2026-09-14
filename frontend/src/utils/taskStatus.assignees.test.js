import {
  selectableTaskAssignees,
  isActiveTaskAssignee,
} from "./taskStatus";

test("BLOCKED users are not selectable as new task assignees", () => {
  const users = [
    { email: "active@mydgv.com", status: "ACTIVE", name: "Active" },
    { email: "blocked@mydgv.com", status: "BLOCKED", name: "Blocked" },
    { email: "pending@mydgv.com", status: "PENDING", name: "Pending" },
    { email: "admin@mydgv.com", status: "ACTIVE", role: "ADMIN", name: "Admin" },
  ];
  expect(isActiveTaskAssignee(users[1])).toBe(false);
  const selectable = selectableTaskAssignees(users);
  expect(selectable.map((u) => u.email)).toEqual([
    "active@mydgv.com",
    "admin@mydgv.com",
  ]);
  expect(selectable.some((u) => u.status === "BLOCKED")).toBe(false);
});

test("ACTIVE users remain selectable for new task assignment", () => {
  const users = [
    { email: "doer@mydgv.com", status: "ACTIVE" },
    { email: "lead@mydgv.com", status: "ACTIVE", role: "MANAGER" },
  ];
  expect(selectableTaskAssignees(users)).toHaveLength(2);
});

import {
  departmentFilterOptions,
  employeeMatchesDepartmentFilter,
  formatDepartmentList,
  summarizeDepartments,
} from "./departmentMembership";

const catalog = [
  { departmentId: "it", name: "IT — Software Development", status: "ACTIVE" },
  { departmentId: "ai", name: "AI & Automation", status: "ACTIVE" },
  { departmentId: "old", name: "Old Desk", status: "INACTIVE" },
];

test("an employee in two departments matches either filter", () => {
  const user = {
    departmentIds: ["it", "ai"],
    primaryDepartmentId: "ai",
    department: "Engineering",
  };
  expect(employeeMatchesDepartmentFilter(user, "it", catalog)).toBe(true);
  expect(employeeMatchesDepartmentFilter(user, "ai", catalog)).toBe(true);
  expect(employeeMatchesDepartmentFilter(user, "old", catalog)).toBe(false);
  expect(formatDepartmentList(user, catalog)).toEqual([
    "IT — Software Development",
    "AI & Automation (primary)",
    "Engineering (unmatched)",
  ]);
});

test("legacy text stays visible until it matches a catalog name", () => {
  const unmatched = { department: "Engineering" };
  expect(summarizeDepartments(unmatched, catalog).legacyUnmatched).toBe(
    "Engineering"
  );
  expect(employeeMatchesDepartmentFilter(unmatched, "legacy:Engineering", catalog)).toBe(
    true
  );
  const exact = { department: "ai & automation" };
  expect(employeeMatchesDepartmentFilter(exact, "ai", catalog)).toBe(true);
  expect(departmentFilterOptions([unmatched, exact], catalog).map((row) => row.value)).toEqual([
    "ai",
    "it",
    "old",
    "legacy:Engineering",
  ]);
});

test("inactive membership remains listed", () => {
  const user = {
    departmentIds: ["old"],
    primaryDepartmentId: "old",
    department: "Old Desk",
  };
  expect(formatDepartmentList(user, catalog)).toEqual(["Old Desk (inactive)"]);
  expect(summarizeDepartments(user, catalog).legacyUnmatched).toBe("");
});

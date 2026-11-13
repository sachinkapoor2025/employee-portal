import {
  departmentFilterOptions,
  designationFilterOptions,
  employeeListDepartments,
  employeeListDesignation,
  employeeMatchesDepartmentFilter,
  employeeMatchesDesignationFilter,
  employeeMatchesSearch,
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
  ]);
});

test("legacy department text does not create a membership or a filter match", () => {
  const unmatched = { department: "Engineering" };
  expect(summarizeDepartments(unmatched, catalog).memberships).toEqual([]);
  expect(employeeMatchesDepartmentFilter(unmatched, "legacy:Engineering", catalog)).toBe(
    false
  );
  const exact = { department: "ai & automation" };
  expect(employeeMatchesDepartmentFilter(exact, "ai", catalog)).toBe(false);
  expect(
    departmentFilterOptions([unmatched, exact], catalog).map((row) => row.label)
  ).toEqual(["AI & Automation", "IT — Software Development"]);
  expect(
    departmentFilterOptions([unmatched, exact], catalog).some((row) =>
      String(row.label).includes("unmatched")
    )
  ).toBe(false);
});

test("assigned departments stay filterable when the catalog entry is inactive or missing", () => {
  const user = {
    departmentIds: ["old", "missing"],
    primaryDepartmentId: "old",
    department: "Engineering",
    designation: "Old Title",
  };
  expect(employeeMatchesDepartmentFilter(user, "old", catalog)).toBe(true);
  expect(employeeMatchesDepartmentFilter(user, "missing", catalog)).toBe(true);
  expect(employeeMatchesDepartmentFilter(user, "it", catalog)).toBe(false);
  expect(departmentFilterOptions([user], catalog)).toEqual([
    { value: "ai", label: "AI & Automation" },
    { value: "it", label: "IT — Software Development" },
    { value: "missing", label: "missing (missing from catalog)" },
    { value: "old", label: "Old Desk (inactive)" },
  ]);
});

test("the employee list shows the main department before subsidiaries", () => {
  const user = {
    departmentIds: ["it", "ai", "missing"],
    primaryDepartmentId: "ai",
    department: "Engineering",
    designation: "Old Title",
    departmentDesignations: [
      { departmentId: "ai", designationId: "ai-eng" },
      { departmentId: "it", designationId: "retired" },
    ],
  };
  expect(employeeListDepartments(user, catalog)).toEqual([
    { kind: "main", label: "Main Department", name: "AI & Automation", note: "" },
    {
      kind: "subsidiary",
      label: "Subsidiary Department 1",
      name: "IT — Software Development",
      note: "",
    },
    {
      kind: "subsidiary",
      label: "Subsidiary Department 2",
      name: "missing",
      note: "missing from catalog",
    },
  ]);
  expect(JSON.stringify(employeeListDepartments(user, catalog))).not.toContain("unmatched");
  expect(JSON.stringify(employeeListDepartments(user, catalog))).not.toContain("Engineering");
  expect(
    employeeListDesignation(user, {
      ai: [{ designationId: "ai-eng", name: "AI Engineer", status: "ACTIVE" }],
      it: [{ designationId: "retired", name: "Retired Role", status: "INACTIVE" }],
    })
  ).toBe("AI Engineer");
});

test("employees without structured assignments do not display legacy text", () => {
  const user = { department: "Engineering", designation: "Coordinator" };
  expect(employeeListDepartments(user, catalog)).toEqual([]);
  expect(employeeListDesignation(user, {})).toBe("—");
  expect(employeeListDesignation({ departmentIds: ["it"] }, {})).toBe("No designation");
  expect(
    employeeListDesignation(
      {
        departmentIds: ["it"],
        primaryDepartmentId: "it",
        designation: "Stale",
        departmentDesignations: [{ departmentId: "it", designationId: "missing-id" }],
      },
      { it: [] }
    )
  ).toBe("Designation unavailable");
  expect(
    employeeListDesignation(
      {
        departmentIds: ["old"],
        primaryDepartmentId: "old",
        designation: "Stale",
        departmentDesignations: [{ departmentId: "old", designationId: "old-role" }],
      },
      { old: [{ designationId: "old-role", name: "Retired Role", status: "INACTIVE" }] }
    )
  ).toBe("Designation inactive");
});

test("an inactive assigned department stays visible", () => {
  const user = {
    departmentIds: ["old"],
    primaryDepartmentId: "old",
    department: "Something else",
  };
  expect(employeeListDepartments(user, catalog)).toEqual([
    { kind: "main", label: "Main Department", name: "Old Desk", note: "inactive" },
  ]);
});

test("filters and search use the main designation and current departments", () => {
  const assigned = {
    name: "Aisha Khan",
    email: "aisha@mydgv.com",
    empId: "DGV014",
    role: "EMPLOYEE",
    departmentIds: ["it", "ai"],
    primaryDepartmentId: "ai",
    department: "Engineering",
    designation: "Old Title",
    departmentDesignations: [{ departmentId: "ai", designationId: "ai-eng" }],
  };
  const legacy = {
    name: "Legacy User",
    email: "legacy@mydgv.com",
    department: "Desk",
    designation: "Coordinator",
  };
  const missingDesignation = {
    departmentIds: ["it"],
    primaryDepartmentId: "it",
    designation: "Stale",
  };
  const catalogs = {
    ai: [{ designationId: "ai-eng", name: "AI Engineer", status: "ACTIVE" }],
    it: [{ designationId: "junior", name: "Junior Developer", status: "ACTIVE" }],
    old: [{ designationId: "old-role", name: "Retired Role", status: "INACTIVE" }],
  };
  expect(employeeMatchesDesignationFilter(assigned, "AI Engineer", catalogs)).toBe(true);
  expect(employeeMatchesDesignationFilter(assigned, "Old Title", catalogs)).toBe(false);
  expect(employeeMatchesDesignationFilter(assigned, "Junior Developer", catalogs)).toBe(
    false
  );
  expect(employeeMatchesDesignationFilter(legacy, "Coordinator", catalogs)).toBe(false);
  expect(employeeMatchesDesignationFilter(missingDesignation, "No designation", catalogs)).toBe(
    true
  );
  expect(designationFilterOptions([assigned, legacy, missingDesignation], catalogs)).toEqual([
    "AI Engineer",
    "Junior Developer",
    "No designation",
  ]);
  expect(
    designationFilterOptions([assigned, legacy, missingDesignation], catalogs, {
      departmentId: "ai",
      departments: catalog,
    })
  ).toEqual(["AI Engineer"]);
  expect(
    employeeMatchesDesignationFilter(assigned, "Junior Developer", catalogs, "it")
  ).toBe(false);
  const subsidiary = {
    ...assigned,
    departmentDesignations: [
      { departmentId: "ai", designationId: "ai-eng" },
      { departmentId: "it", designationId: "junior" },
    ],
  };
  expect(
    employeeMatchesDesignationFilter(subsidiary, "Junior Developer", catalogs, "it")
  ).toBe(true);
  expect(employeeMatchesDesignationFilter(subsidiary, "Old Title", catalogs, "it")).toBe(
    false
  );
  expect(
    designationFilterOptions([subsidiary, legacy], catalogs, {
      departmentId: "it",
      departments: catalog,
    })
  ).toEqual(["Junior Developer"]);
  expect(employeeMatchesSearch(assigned, "AI & Automation", catalog, catalogs)).toBe(true);
  expect(employeeMatchesSearch(assigned, "Software", catalog, catalogs)).toBe(true);
  expect(employeeMatchesSearch(assigned, "AI Engineer", catalog, catalogs)).toBe(true);
  expect(employeeMatchesSearch(assigned, "Engineering", catalog, catalogs)).toBe(false);
  expect(employeeMatchesSearch(assigned, "Old Title", catalog, catalogs)).toBe(false);
  expect(employeeMatchesSearch(assigned, "DGV014", catalog, catalogs)).toBe(true);
  expect(employeeMatchesSearch(legacy, "Desk", catalog, catalogs)).toBe(false);
  expect(employeeMatchesSearch(legacy, "Coordinator", catalog, catalogs)).toBe(false);
  expect(employeeMatchesSearch(legacy, "legacy@mydgv.com", catalog, catalogs)).toBe(true);
});

test("inactive membership remains listed", () => {
  const user = {
    departmentIds: ["old"],
    primaryDepartmentId: "old",
    department: "Old Desk",
  };
  expect(formatDepartmentList(user, catalog)).toEqual(["Old Desk (inactive)"]);
  expect(summarizeDepartments(user, catalog).memberships[0].name).toBe("Old Desk");
});

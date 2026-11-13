import {
  buildEmployeeWorkView,
  employmentFieldGroups,
  formatJoiningDate,
} from "./employeeWorkProfile";

const departments = [
  { departmentId: "it", name: "IT — Software Development", status: "ACTIVE" },
  { departmentId: "ai", name: "AI & Automation", status: "ACTIVE" },
];

const designationsByDepartment = {
  it: [
    {
      designationId: "junior",
      departmentId: "it",
      name: "Junior Developer",
      track: "Engineering",
      status: "ACTIVE",
    },
  ],
  ai: [
    {
      designationId: "ai-eng",
      departmentId: "ai",
      name: "AI Engineer",
      track: "",
      status: "ACTIVE",
    },
  ],
};

const catalogProfile = {
  designation: "IT",
  skill: "SKILL#SEO",
  department: "IT",
  departmentIds: ["it"],
  primaryDepartmentId: "it",
  departmentDesignations: [{ departmentId: "it", designationId: "junior" }],
  manager: "Priya Shah",
  groupLead: "Rahul Mehta",
  doj: "2026-08-20",
};

test("catalog designation is shown separately from department and track", () => {
  const view = buildEmployeeWorkView(
    catalogProfile,
    departments,
    designationsByDepartment
  );
  const fields = employmentFieldGroups(view).flat();

  expect(fields.map((field) => [field.label, field.value])).toEqual([
    ["Department", "IT — Software Development"],
    ["Designation", "Junior Developer"],
    ["Track", "Engineering"],
    ["Date of Joining", "20 Aug 2026"],
  ]);
  expect(view.roleDesignation).toBe("Junior Developer");
  expect(view.legacyDesignation).toBe("");
  expect(view.legacyDepartment).toBe("");
  expect(JSON.stringify(fields)).not.toContain("Legacy unmatched");
  expect(fields.some((field) => field.value === "IT")).toBe(false);
});

test("track is omitted when the designation has no track", () => {
  const view = buildEmployeeWorkView(
    {
      departmentIds: ["ai"],
      primaryDepartmentId: "ai",
      departmentDesignations: [{ departmentId: "ai", designationId: "ai-eng" }],
      designation: "Analyst",
    },
    departments,
    designationsByDepartment
  );
  const labels = employmentFieldGroups(view)
    .flat()
    .map((field) => field.label);

  expect(labels).toEqual(["Department", "Designation", "Date of Joining"]);
  expect(view.roleDesignation).toBe("AI Engineer");
  expect(view.legacyDesignation).toBe("");
});

test("legacy department and designation text are not displayed", () => {
  const view = buildEmployeeWorkView(
    {
      designation: "Coordinator",
      department: "Operations",
      doj: "2024-01-05",
    },
    departments,
    {}
  );
  const fields = employmentFieldGroups(view).flat();

  expect(fields.map((field) => [field.label, field.value])).toEqual([
    ["Date of Joining", "5 Jan 2024"],
  ]);
  expect(view.roleDesignation).toBe("");
  expect(JSON.stringify(fields)).not.toContain("Operations");
  expect(JSON.stringify(fields)).not.toContain("Coordinator");
});

test("a failed designation catalog load does not fall back to the legacy title", () => {
  const view = buildEmployeeWorkView(
    catalogProfile,
    departments,
    { it: [] },
    { unresolvedDepartmentIds: ["it"] }
  );
  const labels = employmentFieldGroups(view)
    .flat()
    .map((field) => field.label);

  expect(labels).toEqual(["Department", "Date of Joining"]);
  expect(view.legacyDesignation).toBe("");
  expect(view.roleDesignation).toBe("");
});

test("an unresolved designation id is not displayed as the designation", () => {
  const view = buildEmployeeWorkView(
    {
      designation: "IT",
      department: "IT",
      departmentIds: ["it"],
      departmentDesignations: [{ departmentId: "it", designationId: "missing-id" }],
    },
    departments,
    { it: [] }
  );
  const fields = employmentFieldGroups(view).flat();

  expect(fields.map((field) => [field.label, field.value])).toEqual([
    ["Department", "IT — Software Development"],
    ["Date of Joining", ""],
  ]);
  expect(JSON.stringify(fields)).not.toContain("missing-id");
  expect(JSON.stringify(fields)).not.toContain("Legacy unmatched");
});

test("legacy designation stays hidden when any catalog designation is valid", () => {
  const view = buildEmployeeWorkView(
    {
      designation: "IT",
      department: "IT",
      departmentIds: ["it", "ai"],
      primaryDepartmentId: "it",
      departmentDesignations: [
        { departmentId: "it", designationId: "junior" },
        { departmentId: "ai", designationId: "not-in-catalog" },
      ],
    },
    departments,
    designationsByDepartment
  );
  const groups = employmentFieldGroups(view);

  expect(groups[0].map((field) => [field.label, field.value])).toEqual([
    ["Department", "IT — Software Development · Primary"],
    ["Designation", "Junior Developer"],
    ["Track", "Engineering"],
  ]);
  expect(groups[1].map((field) => [field.label, field.value])).toEqual([
    ["Department", "AI & Automation"],
    ["Designation", ""],
  ]);
  expect(groups[2].map((field) => field.label)).toEqual(["Date of Joining"]);
  expect(view.roleDesignation).toBe("Junior Developer");
  expect(view.legacyDesignation).toBe("");
});

test("inactive catalog designations still provide the employee designation", () => {
  const view = buildEmployeeWorkView(
    {
      designation: "Old Title",
      departmentIds: ["it"],
      departmentDesignations: [{ departmentId: "it", designationId: "junior" }],
    },
    [{ departmentId: "it", name: "IT — Software Development", status: "INACTIVE" }],
    {
      it: [
        {
          designationId: "junior",
          departmentId: "it",
          name: "Junior Developer",
          track: "Engineering",
          status: "INACTIVE",
        },
      ],
    }
  );

  expect(employmentFieldGroups(view).flat().map((field) => field.value)).toEqual([
    "IT — Software Development · Inactive",
    "Junior Developer",
    "Engineering",
    "",
  ]);
});

test("joining dates that are already display text stay unchanged", () => {
  expect(formatJoiningDate("20 Aug 2026")).toBe("20 Aug 2026");
  expect(formatJoiningDate("2026-02-31")).toBe("2026-02-31");
  expect(formatJoiningDate("")).toBe("");
});

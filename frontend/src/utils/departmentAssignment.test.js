import {
  buildSavedAssignments,
  departmentChoices,
  designationsInTrack,
  isSelectableDesignation,
  tracksInDepartment,
} from "./departmentAssignment";

const departments = [
  { departmentId: "it", name: "IT — Software Development", status: "ACTIVE" },
  { departmentId: "ai", name: "AI & Automation", status: "ACTIVE" },
  { departmentId: "old", name: "Old Desk", status: "INACTIVE" },
];

const itDesignations = [
  {
    designationId: "junior",
    departmentId: "it",
    name: "Junior Developer",
    track: "Engineering",
    trackSort: 2,
    sortOrder: 2,
    status: "ACTIVE",
  },
  {
    designationId: "lead",
    departmentId: "it",
    name: "Technical Lead",
    track: "Engineering",
    trackSort: 2,
    sortOrder: 1,
    status: "ACTIVE",
  },
  {
    designationId: "seo",
    departmentId: "it",
    name: "SEO Lead",
    track: "SEO",
    trackSort: 1,
    sortOrder: 1,
    status: "ACTIVE",
  },
  {
    designationId: "old-role",
    departmentId: "it",
    name: "Retired Role",
    track: "Engineering",
    trackSort: 2,
    sortOrder: 3,
    status: "INACTIVE",
  },
  {
    designationId: "blank",
    departmentId: "it",
    name: "No Track",
    track: "",
    status: "ACTIVE",
  },
];

test("department choices hide departments that are already assigned", () => {
  expect(
    departmentChoices(departments, ["it"]).map((row) => row.departmentId)
  ).toEqual(["ai"]);
  expect(
    departmentChoices(departments, ["it"], { includeDepartmentId: "it" }).map(
      (row) => row.departmentId
    )
  ).toEqual(["it", "ai"]);
  expect(departmentChoices(departments, []).map((row) => row.departmentId)).toEqual([
    "it",
    "ai",
  ]);
});

test("tracks and designations stay inside the selected department and track", () => {
  expect(tracksInDepartment(itDesignations)).toEqual(["SEO", "Engineering"]);
  expect(
    designationsInTrack(itDesignations, "Engineering", { departmentId: "it" }).map(
      (row) => row.name
    )
  ).toEqual(["Technical Lead", "Junior Developer"]);
  expect(
    isSelectableDesignation(itDesignations[2], {
      departmentId: "it",
      track: "Engineering",
    })
  ).toBe(false);
  expect(
    isSelectableDesignation(itDesignations[0], {
      departmentId: "it",
      track: "Engineering",
    })
  ).toBe(true);
});

test("inactive departments and designations are not selectable", () => {
  expect(departmentChoices(departments, []).map((row) => row.departmentId)).not.toContain(
    "old"
  );
  expect(
    departmentChoices(departments, ["old"], { includeDepartmentId: "old" }).map(
      (row) => row.departmentId
    )
  ).toContain("old");
  expect(
    departmentChoices(departments, ["it"], { preserveDepartmentId: "old" }).map(
      (row) => row.departmentId
    )
  ).toContain("old");
  expect(departmentChoices(departments, ["it"]).map((row) => row.departmentId)).not.toContain(
    "old"
  );
  expect(tracksInDepartment(itDesignations)).toEqual(["SEO", "Engineering"]);
  expect(
    designationsInTrack(itDesignations, "Engineering", { departmentId: "it" }).map(
      (row) => row.designationId
    )
  ).toEqual(["lead", "junior"]);
  expect(
    isSelectableDesignation(itDesignations[3], {
      departmentId: "it",
      track: "Engineering",
    })
  ).toBe(false);
});

test("saved assignments keep one main department and reject duplicates or incomplete rows", () => {
  const catalog = {
    it: itDesignations,
    ai: [
      {
        designationId: "ai-eng",
        departmentId: "ai",
        name: "AI Engineer",
        track: "AI / Machine Learning",
        status: "ACTIVE",
      },
    ],
  };
  expect(
    buildSavedAssignments(
      { departmentId: "it", track: "Engineering", designationId: "junior" },
      [{ departmentId: "ai", track: "AI / Machine Learning", designationId: "ai-eng" }],
      catalog,
      departments
    )
  ).toEqual({
    ok: true,
    departmentIds: ["it", "ai"],
    primaryDepartmentId: "it",
    departmentDesignations: [
      { departmentId: "it", designationId: "junior" },
      { departmentId: "ai", designationId: "ai-eng" },
    ],
  });
  expect(
    buildSavedAssignments(
      { departmentId: "it", track: "Engineering", designationId: "junior" },
      [{ departmentId: "it", track: "SEO", designationId: "seo" }],
      catalog,
      departments
    ).ok
  ).toBe(false);
  expect(
    buildSavedAssignments(
      { departmentId: "it", track: "Engineering", designationId: "" },
      [],
      catalog,
      departments
    ).ok
  ).toBe(false);
});

test("an existing inactive assignment can be kept and cannot be newly selected", () => {
  const archived = {
    designationId: "old-role",
    departmentId: "old",
    name: "Retired Role",
    track: "Legacy",
    status: "INACTIVE",
  };
  const catalog = { old: [archived], it: itDesignations };
  const preserved = {
    departmentId: "old",
    track: "Legacy",
    designationId: "old-role",
    preservedDepartmentId: "old",
    preservedTrack: "Legacy",
    preservedDesignationId: "old-role",
  };
  expect(tracksInDepartment(catalog.old)).toEqual([]);
  expect(tracksInDepartment(catalog.old, { preserveTrack: "Legacy" })).toEqual(["Legacy"]);
  expect(
    designationsInTrack(catalog.old, "Legacy", {
      departmentId: "old",
      preserveDesignationId: "old-role",
    }).map((row) => row.designationId)
  ).toEqual(["old-role"]);
  expect(
    buildSavedAssignments(preserved, [], catalog, departments)
  ).toEqual({
    ok: true,
    departmentIds: ["old"],
    primaryDepartmentId: "old",
    departmentDesignations: [{ departmentId: "old", designationId: "old-role" }],
  });
  expect(
    buildSavedAssignments(
      { departmentId: "old", track: "Legacy", designationId: "old-role" },
      [],
      catalog,
      departments
    ).ok
  ).toBe(false);
  expect(
    buildSavedAssignments(
      { departmentId: "it", track: "Engineering", designationId: "junior" },
      [preserved],
      catalog,
      departments
    ).departmentIds
  ).toEqual(["it", "old"]);
});

import { employeeListDepartments, employeeListDesignation } from "./departmentMembership";

const LEADERSHIP = "7b20ce24-dbf5-4ac0-a454-dbcddb1e2a6f";
const IT = "it-software-development";
const SEO = "seo-digital-marketing";
const OWNER = "a7d861c4-6683-4140-b812-28a1cb1f1b11";
const MARKETING = "7a50e2f6-bac3-42c2-b71b-748c6a017120";
const JUNIOR = "e3f351fe-83cd-47fe-856c-2be2f90438fc";
const SEO_SPECIALIST = "569c9704-03e7-4931-a881-913742cf60a3";
const QA_INTERN = "5b4da29a-e774-4b50-aca3-5585cbd67c38";
const SEO_INTERN = "6bbc54ef-f83b-4e68-87c6-e8161bc7c851";

const departments = [
  { departmentId: LEADERSHIP, name: "Leadership & Management", status: "ACTIVE" },
  { departmentId: IT, name: "IT — Software Development", status: "ACTIVE" },
  { departmentId: SEO, name: "SEO & Digital Marketing", status: "ACTIVE" },
];

const designations = {
  [LEADERSHIP]: [{ designationId: OWNER, departmentId: LEADERSHIP, name: "Owner", status: "ACTIVE" }],
  [IT]: [
    { designationId: JUNIOR, departmentId: IT, name: "Junior Developer", status: "ACTIVE" },
    { designationId: QA_INTERN, departmentId: IT, name: "QA Intern", status: "ACTIVE" },
  ],
  [SEO]: [
    { designationId: MARKETING, departmentId: SEO, name: "Digital Marketing Specialist", status: "ACTIVE" },
    { designationId: SEO_SPECIALIST, departmentId: SEO, name: "SEO Specialist", status: "ACTIVE" },
    { designationId: SEO_INTERN, departmentId: SEO, name: "SEO Intern", status: "ACTIVE" },
  ],
};

function employee(departmentId, designationId, legacy) {
  return {
    department: legacy.department,
    designation: legacy.designation,
    departmentIds: [departmentId],
    primaryDepartmentId: departmentId,
    departmentDesignations: [{ departmentId, designationId }],
  };
}

const rows = [
  ["DGV001", LEADERSHIP, OWNER, "Leadership & Management", "Owner", { department: "Leadership & Management", designation: "" }],
  ["DGV002", SEO, MARKETING, "SEO & Digital Marketing", "Digital Marketing Specialist", { department: "", designation: "Marketing expert" }],
  ["DGV003", IT, JUNIOR, "IT — Software Development", "Junior Developer", { department: "", designation: "Engineer" }],
  ["DGV004", IT, JUNIOR, "IT — Software Development", "Junior Developer", { department: "IT", designation: "IT" }],
  ["DGV005", SEO, SEO_SPECIALIST, "SEO & Digital Marketing", "SEO Specialist", { department: "", designation: "" }],
  ["DGV006", IT, JUNIOR, "IT — Software Development", "Junior Developer", { department: "IT", designation: "Engineer" }],
  ["DGV007", SEO, SEO_SPECIALIST, "SEO & Digital Marketing", "SEO Specialist", { department: "SEO", designation: "SEO" }],
  ["DGV010", IT, QA_INTERN, "IT — Software Development", "QA Intern", { department: "QA", designation: "" }],
  ["DGV012", SEO, SEO_INTERN, "SEO & Digital Marketing", "SEO Intern", { department: "SEO", designation: "SEO" }],
];

test("all nine employees resolve department and designation from structured ids", () => {
  const resolved = rows.map(([empId, departmentId, designationId, departmentName, designationName, legacy]) => {
    const user = employee(departmentId, designationId, legacy);
    return {
      empId,
      department: employeeListDepartments(user, departments)[0]?.name,
      designation: employeeListDesignation(user, designations),
      departmentName,
      designationName,
      legacy,
    };
  });

  expect(resolved.map((row) => [row.empId, row.department, row.designation])).toEqual(
    rows.map(([empId, , , departmentName, designationName]) => [empId, departmentName, designationName])
  );
  expect(resolved.find((row) => row.empId === "DGV001").designation).toBe("Owner");
  expect(resolved.find((row) => row.empId === "DGV010").designation).toBe("QA Intern");
  expect(resolved.find((row) => row.empId === "DGV010").department).toBe("IT — Software Development");
  const dgv007 = resolved.find((row) => row.empId === "DGV007").designation;
  const dgv012 = resolved.find((row) => row.empId === "DGV012").designation;
  expect(dgv007).toBe("SEO Specialist");
  expect(dgv012).toBe("SEO Intern");
  expect(dgv007).not.toBe(dgv012);
  for (const row of resolved) {
    if (row.legacy.department && row.legacy.department !== row.departmentName) {
      expect(row.department).not.toBe(row.legacy.department);
    }
    if (row.legacy.designation) expect(row.designation).not.toBe(row.legacy.designation);
  }
});

test("a missing or cross-department designation is not invented from legacy text", () => {
  const missing = {
    department: "QA",
    designation: "QA Intern",
    departmentIds: ["missing-dept"],
    primaryDepartmentId: "missing-dept",
    departmentDesignations: [{ departmentId: "missing-dept", designationId: "missing-role" }],
  };
  expect(employeeListDepartments(missing, departments)[0]).toMatchObject({
    name: "missing-dept",
    note: "missing from catalog",
  });
  expect(employeeListDesignation(missing, designations)).toBe("Designation unavailable");

  const crossed = {
    department: "SEO",
    designation: "Owner",
    departmentIds: [SEO],
    primaryDepartmentId: SEO,
    departmentDesignations: [{ departmentId: SEO, designationId: OWNER }],
  };
  expect(employeeListDesignation(crossed, designations)).toBe("Designation unavailable");
});

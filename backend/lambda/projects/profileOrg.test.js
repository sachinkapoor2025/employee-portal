const assert = require("assert");
const { resolveProfileOrg } = require("./profileOrg");
const { REASON, resolveHourlyRates } = require("./costRates");

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
  { type: "DEPARTMENT", departmentId: LEADERSHIP, name: "Leadership & Management", status: "ACTIVE" },
  { type: "DEPARTMENT", departmentId: IT, name: "IT — Software Development", status: "ACTIVE" },
  { type: "DEPARTMENT", departmentId: SEO, name: "SEO & Digital Marketing", status: "ACTIVE" },
];

const designations = [
  { type: "ORG_DESIGNATION", designationId: OWNER, departmentId: LEADERSHIP, name: "Owner", status: "ACTIVE" },
  { type: "ORG_DESIGNATION", designationId: MARKETING, departmentId: SEO, name: "Digital Marketing Specialist", status: "ACTIVE" },
  { type: "ORG_DESIGNATION", designationId: JUNIOR, departmentId: IT, name: "Junior Developer", status: "ACTIVE" },
  { type: "ORG_DESIGNATION", designationId: SEO_SPECIALIST, departmentId: SEO, name: "SEO Specialist", status: "ACTIVE" },
  { type: "ORG_DESIGNATION", designationId: QA_INTERN, departmentId: IT, name: "QA Intern", status: "ACTIVE" },
  { type: "ORG_DESIGNATION", designationId: SEO_INTERN, departmentId: SEO, name: "SEO Intern", status: "ACTIVE" },
];

function employee(empId, departmentId, designationId, legacy) {
  return {
    empId,
    department: legacy.department,
    designation: legacy.designation,
    departmentIds: [departmentId],
    primaryDepartmentId: departmentId,
    departmentDesignations: designationId
      ? [{ departmentId, designationId }]
      : undefined,
  };
}

const employees = [
  employee("DGV001", LEADERSHIP, OWNER, { department: "Leadership & Management", designation: "" }),
  employee("DGV002", SEO, MARKETING, { department: "", designation: "Marketing expert" }),
  employee("DGV003", IT, JUNIOR, { department: "", designation: "Engineer" }),
  employee("DGV004", IT, JUNIOR, { department: "IT", designation: "IT" }),
  employee("DGV005", SEO, SEO_SPECIALIST, { department: "", designation: "" }),
  employee("DGV006", IT, JUNIOR, { department: "IT", designation: "Engineer" }),
  employee("DGV007", SEO, SEO_SPECIALIST, { department: "SEO", designation: "SEO" }),
  employee("DGV010", IT, QA_INTERN, { department: "QA", designation: "" }),
  employee("DGV012", SEO, SEO_INTERN, { department: "SEO", designation: "SEO" }),
];

const expected = {
  DGV001: ["Leadership & Management", "Owner"],
  DGV002: ["SEO & Digital Marketing", "Digital Marketing Specialist"],
  DGV003: ["IT — Software Development", "Junior Developer"],
  DGV004: ["IT — Software Development", "Junior Developer"],
  DGV005: ["SEO & Digital Marketing", "SEO Specialist"],
  DGV006: ["IT — Software Development", "Junior Developer"],
  DGV007: ["SEO & Digital Marketing", "SEO Specialist"],
  DGV010: ["IT — Software Development", "QA Intern"],
  DGV012: ["SEO & Digital Marketing", "SEO Intern"],
};

for (const profile of employees) {
  const labels = resolveProfileOrg(profile, departments, designations);
  assert.deepStrictEqual(
    [labels.department, labels.designation],
    expected[profile.empId],
    profile.empId
  );
  if (profile.department && profile.department !== expected[profile.empId][0]) {
    assert.notStrictEqual(labels.department, profile.department);
  }
  if (profile.designation) assert.notStrictEqual(labels.designation, profile.designation);
}

assert.notStrictEqual(
  resolveProfileOrg(employees.find((row) => row.empId === "DGV007"), departments, designations)
    .designation,
  resolveProfileOrg(employees.find((row) => row.empId === "DGV012"), departments, designations)
    .designation
);

const unlinked = employee("DGV001", LEADERSHIP, null, {
  department: "Leadership & Management",
  designation: '[{"departmentId":"x","designationId":"a7d861c4-6683-4140-b812-28a1cb1f1b11"}]',
});
assert.strictEqual(resolveProfileOrg(unlinked, departments, designations).designation, "");

const missing = resolveProfileOrg(
  {
    department: "QA",
    designation: "QA Intern",
    departmentIds: ["missing-dept"],
    primaryDepartmentId: "missing-dept",
    departmentDesignations: [
      { departmentId: "missing-dept", designationId: "missing-role" },
    ],
  },
  departments,
  designations
);
assert.deepStrictEqual([missing.department, missing.designation], ["", ""]);

const wrongDepartment = resolveProfileOrg(
  {
    department: "SEO",
    designation: "Owner",
    departmentIds: [SEO],
    primaryDepartmentId: SEO,
    departmentDesignations: [{ departmentId: SEO, designationId: OWNER }],
  },
  departments,
  designations
);
assert.strictEqual(wrongDepartment.department, "SEO & Digital Marketing");
assert.strictEqual(wrongDepartment.designation, "");

const override = resolveHourlyRates({
  employeeRates: {
    status: "ACTIVE",
    designationId: JUNIOR,
    internalHourlyRate: 4,
    externalHourlyRate: 5,
  },
  designation: { status: "ACTIVE", internalHourlyRate: 1, externalHourlyRate: 2 },
});
assert.strictEqual(override.internal.reason, REASON.EMPLOYEE_OVERRIDE);
assert.strictEqual(override.external.reason, REASON.EMPLOYEE_OVERRIDE);

const fallback = resolveHourlyRates({
  employeeRates: { status: "ACTIVE", designationId: MARKETING },
  designation: { status: "ACTIVE", internalHourlyRate: 1.5, externalHourlyRate: 2.5 },
});
assert.strictEqual(fallback.internal.reason, REASON.DESIGNATION_FALLBACK);
assert.strictEqual(fallback.internal.source, "DESIGNATION");

const missingDesignation = resolveHourlyRates({
  employeeRates: { status: "ACTIVE", designationId: "gone" },
  designation: null,
});
assert.strictEqual(missingDesignation.internal.reason, REASON.DESIGNATION_MISSING);

const inactiveDesignation = resolveHourlyRates({
  employeeRates: { status: "ACTIVE", designationId: QA_INTERN },
  designation: { status: "INACTIVE", internalHourlyRate: 3, externalHourlyRate: 4 },
});
assert.strictEqual(inactiveDesignation.internal.reason, REASON.DESIGNATION_INACTIVE);

const noRecord = resolveHourlyRates({ employeeRates: null, designation: null });
assert.strictEqual(noRecord.internal.reason, REASON.NO_EMPLOYEE_RECORD);

console.log("profileOrg.test.js ok");

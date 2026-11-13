jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

let mockRouteEmail = "";
const mockNavigate = jest.fn();
jest.mock(
  "react-router-dom",
  () => ({
    Link: ({ children, to }) => <a href={to}>{children}</a>,
    useNavigate: () => mockNavigate,
    useParams: () => (mockRouteEmail ? { email: mockRouteEmail } : {}),
    useSearchParams: () => [new URLSearchParams(), jest.fn()],
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchUsers: jest.fn(),
  fetchDepartments: jest.fn(),
  fetchDepartmentDesignations: jest.fn(),
  fetchEmployeeDepartments: jest.fn(),
  fetchUserProfile: jest.fn(),
  saveUserProfile: jest.fn(),
  updateUserRole: jest.fn(),
  fetchShifts: jest.fn(),
  fetchEmployeeShift: jest.fn(),
  assignEmployeeShift: jest.fn(),
}));

jest.mock("../../services/auth", () => ({
  getLoggedInEmail: () => "admin@mydgv.com",
  PORTAL_ROLE_KEY: "portalRole",
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminEmployeeProfile from "./AdminEmployeeProfile";
import {
  fetchDepartmentDesignations,
  fetchDepartments,
  fetchEmployeeDepartments,
  fetchEmployeeShift,
  fetchShifts,
  fetchUserProfile,
  fetchUsers,
  saveUserProfile,
  updateUserRole,
} from "../../services/api";

const DESIGNATIONS = {
  it: [
    {
      designationId: "junior",
      departmentId: "it",
      name: "Junior Developer",
      track: "Engineering",
      trackSort: 1,
      sortOrder: 1,
      status: "ACTIVE",
    },
    {
      designationId: "seo",
      departmentId: "it",
      name: "SEO Lead",
      track: "SEO",
      trackSort: 2,
      sortOrder: 1,
      status: "ACTIVE",
    },
    {
      designationId: "old-role",
      departmentId: "it",
      name: "Retired Role",
      track: "Engineering",
      status: "INACTIVE",
    },
  ],
  ai: [
    {
      designationId: "ai-eng",
      departmentId: "ai",
      name: "AI Engineer",
      track: "AI / Machine Learning",
      trackSort: 1,
      sortOrder: 1,
      status: "ACTIVE",
    },
    {
      designationId: "ai-lead",
      departmentId: "ai",
      name: "AI Lead",
      track: "AI / Machine Learning",
      trackSort: 1,
      sortOrder: 2,
      status: "ACTIVE",
    },
  ],
  hr: [
    {
      designationId: "hr-exec",
      departmentId: "hr",
      name: "HR Executive",
      track: "People",
      trackSort: 1,
      sortOrder: 1,
      status: "ACTIVE",
    },
  ],
  old: [
    {
      designationId: "old-role",
      departmentId: "old",
      name: "Retired Role",
      track: "Legacy",
      trackSort: 1,
      sortOrder: 1,
      status: "INACTIVE",
    },
  ],
};

const DEPARTMENTS = [
  { departmentId: "it", name: "IT — Software Development", status: "ACTIVE" },
  { departmentId: "ai", name: "AI & Automation", status: "ACTIVE" },
  { departmentId: "hr", name: "Human Resources", status: "ACTIVE" },
  { departmentId: "old", name: "Old Desk", status: "INACTIVE" },
];

beforeEach(() => {
  mockRouteEmail = "";
  mockNavigate.mockReset();
  jest.clearAllMocks();
  fetchUsers.mockResolvedValue([
    { email: "admin@mydgv.com", role: "ADMIN", status: "ACTIVE" },
  ]);
  fetchDepartmentDesignations.mockImplementation(async (id) => ({
    designations: DESIGNATIONS[id] || [],
  }));
  fetchDepartments.mockResolvedValue({ departments: DEPARTMENTS });
  fetchEmployeeDepartments.mockResolvedValue({
    membership: { costingDesignationId: "junior" },
  });
  fetchEmployeeShift.mockResolvedValue({ shift: null });
  fetchShifts.mockResolvedValue({ shifts: [] });
  fetchUserProfile.mockResolvedValue(existingEmployee());
  saveUserProfile.mockResolvedValue({ message: "User saved successfully" });
});

function existingEmployee(overrides = {}) {
  return {
    email: "aisha@mydgv.com",
    name: "Aisha Khan",
    empId: "DGV014",
    department: "SEO",
    departmentIds: ["it"],
    primaryDepartmentId: "it",
    departmentDesignations: [{ departmentId: "it", designationId: "junior" }],
    designation: "IT",
    skill: "SKILL#SEO",
    manager: "Priya Shah",
    groupLead: "Rahul Mehta",
    phone: "9999999999",
    doj: "2026-08-20",
    role: "EMPLOYEE",
    status: "ACTIVE",
    ...overrides,
  };
}

function mainGroup(dialog) {
  return within(dialog).getByRole("group", { name: "Main Department" });
}

function subsidiaryGroup(dialog, index = 1) {
  return within(dialog).getByRole("group", { name: `Subsidiary department ${index}` });
}

async function fillAssignment(scope, departmentId, track, designationId) {
  const view = within(scope);
  await waitFor(() =>
    expect(view.getByLabelText("Department").querySelectorAll("option").length).toBeGreaterThan(1)
  );
  await userEvent.selectOptions(view.getByLabelText("Department"), departmentId);
  await waitFor(() => expect(view.getByRole("option", { name: track })).toBeInTheDocument());
  await userEvent.selectOptions(view.getByLabelText("Track"), track);
  await userEvent.selectOptions(view.getByLabelText("Designation"), designationId);
}

async function openChooser() {
  await userEvent.click(screen.getByRole("button", { name: "Choose Department" }));
  return screen.findByRole("dialog", { name: "Department Assignment" });
}

async function expectSummary(name, department, designation) {
  const region = await screen.findByRole("region", { name });
  await waitFor(() => expect(within(region).getByText(designation)).toBeInTheDocument());
  expect(within(region).getByText("Department")).toBeInTheDocument();
  expect(within(region).getByText(department)).toBeInTheDocument();
  expect(within(region).getByText("Designation")).toBeInTheDocument();
  return region;
}

test("creates an employee with a main department", async () => {
  render(<AdminEmployeeProfile />);

  expect(
    screen.getByText(
      "Choose the employee's main department and any additional departments they work in."
    )
  ).toBeInTheDocument();
  const dialog = await openChooser();
  expect(within(dialog).queryByRole("button", { name: /Remove Main Department/ })).not.toBeInTheDocument();
  await fillAssignment(mainGroup(dialog), "it", "Engineering", "junior");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save assignments" }));

  await expectSummary("Main Department", "IT — Software Development", "Junior Developer");
  expect(screen.queryByRole("button", { name: "Choose Department" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit department assignments" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: /Subsidiary Department/ })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/^Designation$/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Skill")).not.toBeInTheDocument();
  expect(screen.queryByText(/Legacy unmatched/)).not.toBeInTheDocument();

  await userEvent.type(screen.getByLabelText("Manager"), "Priya Shah");
  await userEvent.type(screen.getByLabelText("Group Lead"), "Rahul Mehta");
  await userEvent.type(screen.getByLabelText("Date of Joining"), "2026-08-20");
  await userEvent.type(screen.getByLabelText("Email"), "new.person@mydgv.com");
  await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  await waitFor(() => expect(saveUserProfile).toHaveBeenCalled());
  const payload = saveUserProfile.mock.calls[0][0].profile;
  expect(payload).toEqual(
    expect.objectContaining({
      departmentIds: ["it"],
      primaryDepartmentId: "it",
      departmentDesignations: [{ departmentId: "it", designationId: "junior" }],
      manager: "Priya Shah",
      groupLead: "Rahul Mehta",
      doj: "2026-08-20",
    })
  );
  expect(payload.department).toBeUndefined();
  expect(payload.designation).toBeUndefined();
  expect(payload.skill).toBeUndefined();
  expect(payload.costingDesignationId).toBeUndefined();
});

test("creates an employee with a main department and multiple subsidiaries", async () => {
  render(<AdminEmployeeProfile />);
  const dialog = await openChooser();
  await fillAssignment(mainGroup(dialog), "it", "Engineering", "junior");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add Subsidiary Department" }));
  await fillAssignment(subsidiaryGroup(dialog, 1), "ai", "AI / Machine Learning", "ai-eng");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add Subsidiary Department" }));
  await fillAssignment(subsidiaryGroup(dialog, 2), "hr", "People", "hr-exec");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save assignments" }));

  await expectSummary("Main Department", "IT — Software Development", "Junior Developer");
  await expectSummary("Subsidiary Department 1", "AI & Automation", "AI Engineer");
  await expectSummary("Subsidiary Department 2", "Human Resources", "HR Executive");

  await userEvent.type(screen.getByLabelText("Email"), "new.person@mydgv.com");
  const costing = screen.getByLabelText("Costing designation");
  expect(costing).toHaveClass("dgv-select", "dgv-assignment-costing-select");
  await userEvent.selectOptions(costing, "junior");
  expect(costing).toHaveValue("junior");
  await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(saveUserProfile).toHaveBeenCalled());
  expect(saveUserProfile.mock.calls[0][0].profile).toEqual(
    expect.objectContaining({
      departmentIds: ["it", "ai", "hr"],
      primaryDepartmentId: "it",
      departmentDesignations: [
        { departmentId: "it", designationId: "junior" },
        { departmentId: "ai", designationId: "ai-eng" },
        { departmentId: "hr", designationId: "hr-exec" },
      ],
      costingDesignationId: "junior",
    })
  );
});

test("department, track, and designation selections follow the catalog", async () => {
  render(<AdminEmployeeProfile />);
  const dialog = await openChooser();
  const main = mainGroup(dialog);
  await waitFor(() =>
    expect(within(main).getByLabelText("Department").querySelectorAll("option").length).toBeGreaterThan(1)
  );
  expect(within(main).queryByRole("option", { name: "Old Desk" })).not.toBeInTheDocument();

  await userEvent.selectOptions(within(main).getByLabelText("Department"), "it");
  await waitFor(() =>
    expect(within(main).getByRole("option", { name: "Engineering" })).toBeInTheDocument()
  );
  expect(within(main).queryByRole("option", { name: "AI / Machine Learning" })).not.toBeInTheDocument();
  await userEvent.selectOptions(within(main).getByLabelText("Track"), "Engineering");
  expect(within(main).getByRole("option", { name: "Junior Developer" })).toBeInTheDocument();
  expect(within(main).queryByRole("option", { name: "SEO Lead" })).not.toBeInTheDocument();
  expect(within(main).queryByRole("option", { name: "Retired Role" })).not.toBeInTheDocument();
  await userEvent.selectOptions(within(main).getByLabelText("Designation"), "junior");

  await userEvent.selectOptions(within(main).getByLabelText("Track"), "SEO");
  expect(within(main).getByLabelText("Designation")).toHaveValue("");
  expect(within(main).getByRole("option", { name: "SEO Lead" })).toBeInTheDocument();
  expect(within(main).queryByRole("option", { name: "Junior Developer" })).not.toBeInTheDocument();

  await userEvent.selectOptions(within(main).getByLabelText("Department"), "ai");
  expect(within(main).getByLabelText("Track")).toHaveValue("");
  expect(within(main).getByLabelText("Designation")).toHaveValue("");
  await waitFor(() =>
    expect(within(main).getByRole("option", { name: "AI / Machine Learning" })).toBeInTheDocument()
  );
  expect(within(main).queryByRole("option", { name: "Engineering" })).not.toBeInTheDocument();
});

test("prevents duplicate departments and incomplete assignments", async () => {
  render(<AdminEmployeeProfile />);
  const dialog = await openChooser();
  expect(within(dialog).getByRole("button", { name: "Save assignments" })).toBeDisabled();
  await fillAssignment(mainGroup(dialog), "it", "Engineering", "junior");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add Subsidiary Department" }));
  const subsidiary = subsidiaryGroup(dialog);
  expect(
    within(subsidiary).queryByRole("option", { name: "IT — Software Development" })
  ).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Save assignments" })).toBeDisabled();
  await fillAssignment(subsidiary, "ai", "AI / Machine Learning", "ai-eng");
  expect(within(dialog).getByRole("button", { name: "Save assignments" })).toBeEnabled();
  expect(
    within(mainGroup(dialog)).queryByRole("option", { name: "AI & Automation" })
  ).not.toBeInTheDocument();
  expect(
    within(subsidiary).queryByRole("option", { name: "IT — Software Development" })
  ).not.toBeInTheDocument();
});

test("adds, edits, and removes a subsidiary department before saving", async () => {
  render(<AdminEmployeeProfile />);
  const dialog = await openChooser();
  await fillAssignment(mainGroup(dialog), "it", "Engineering", "junior");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add Subsidiary Department" }));
  await fillAssignment(subsidiaryGroup(dialog), "ai", "AI / Machine Learning", "ai-eng");
  await userEvent.selectOptions(within(subsidiaryGroup(dialog)).getByLabelText("Department"), "hr");
  expect(within(subsidiaryGroup(dialog)).getByLabelText("Track")).toHaveValue("");
  await waitFor(() =>
    expect(within(subsidiaryGroup(dialog)).getByRole("option", { name: "People" })).toBeInTheDocument()
  );
  await userEvent.selectOptions(within(subsidiaryGroup(dialog)).getByLabelText("Track"), "People");
  await userEvent.selectOptions(
    within(subsidiaryGroup(dialog)).getByLabelText("Designation"),
    "hr-exec"
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Remove Subsidiary department 1" })
  );
  expect(
    within(dialog).queryByRole("group", { name: "Subsidiary department 1" })
  ).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Save assignments" }));

  await expectSummary("Main Department", "IT — Software Development", "Junior Developer");
  expect(screen.queryByRole("region", { name: /Subsidiary Department/ })).not.toBeInTheDocument();
});

test("edits an existing employee who only has a main department", async () => {
  mockRouteEmail = "aisha@mydgv.com";
  render(<AdminEmployeeProfile />);

  await expectSummary("Main Department", "IT — Software Development", "Junior Developer");
  expect(screen.queryByRole("region", { name: /Subsidiary Department/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Choose Department" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Legacy unmatched/)).not.toBeInTheDocument();
  expect(screen.queryByText("SKILL#SEO")).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/^Designation$/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Skill")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Edit department assignments" }));
  const dialog = await screen.findByRole("dialog", { name: "Department Assignment" });
  await waitFor(() => expect(within(mainGroup(dialog)).getByLabelText("Department")).toHaveValue("it"));
  expect(within(mainGroup(dialog)).getByLabelText("Track")).toHaveValue("Engineering");
  expect(within(mainGroup(dialog)).getByLabelText("Designation")).toHaveValue("junior");
  expect(within(dialog).queryByRole("group", { name: /Subsidiary department/ })).not.toBeInTheDocument();

  await userEvent.click(within(dialog).getByRole("button", { name: "Add Subsidiary Department" }));
  await fillAssignment(subsidiaryGroup(dialog), "ai", "AI / Machine Learning", "ai-eng");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save assignments" }));

  await expectSummary("Subsidiary Department 1", "AI & Automation", "AI Engineer");
  expect(screen.getByLabelText("Manager")).toHaveValue("Priya Shah");
  expect(screen.getByLabelText("Group Lead")).toHaveValue("Rahul Mehta");
  expect(screen.getByLabelText("Date of Joining")).toHaveValue("2026-08-20");
  expect(screen.getByLabelText("Costing designation")).toHaveValue("junior");

  await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(saveUserProfile).toHaveBeenCalled());
  expect(saveUserProfile.mock.calls[0][0].mode).toBe("EDIT");
  expect(saveUserProfile.mock.calls[0][0].role).toBeUndefined();
  expect(updateUserRole).not.toHaveBeenCalled();
  const payload = saveUserProfile.mock.calls[0][0].profile;
  expect(payload).toEqual(
    expect.objectContaining({
      departmentIds: ["it", "ai"],
      primaryDepartmentId: "it",
      departmentDesignations: [
        { departmentId: "it", designationId: "junior" },
        { departmentId: "ai", designationId: "ai-eng" },
      ],
      manager: "Priya Shah",
      groupLead: "Rahul Mehta",
      doj: "2026-08-20",
    })
  );
  expect(payload.department).toBeUndefined();
  expect(payload.designation).toBeUndefined();
  expect(payload.skill).toBeUndefined();
  expect(payload.costingDesignationId).toBeUndefined();
});

test("updates an existing employee with multiple assignments without duplicating them", async () => {
  mockRouteEmail = "aisha@mydgv.com";
  fetchUserProfile.mockResolvedValue(
    existingEmployee({
      departmentIds: ["it", "ai", "hr"],
      primaryDepartmentId: "it",
      departmentDesignations: [
        { departmentId: "it", designationId: "junior" },
        { departmentId: "ai", designationId: "ai-eng" },
        { departmentId: "hr", designationId: "hr-exec" },
      ],
    })
  );
  render(<AdminEmployeeProfile />);

  await expectSummary("Subsidiary Department 1", "AI & Automation", "AI Engineer");
  await expectSummary("Subsidiary Department 2", "Human Resources", "HR Executive");
  expect(screen.queryByRole("button", { name: "Choose Department" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Edit department assignments" }));
  const dialog = await screen.findByRole("dialog", { name: "Department Assignment" });
  await waitFor(() => expect(within(mainGroup(dialog)).getByLabelText("Designation")).toHaveValue("junior"));
  expect(within(subsidiaryGroup(dialog, 1)).getByLabelText("Department")).toHaveValue("ai");
  expect(within(subsidiaryGroup(dialog, 1)).getByLabelText("Designation")).toHaveValue("ai-eng");
  expect(within(subsidiaryGroup(dialog, 2)).getByLabelText("Department")).toHaveValue("hr");

  await userEvent.selectOptions(
    within(subsidiaryGroup(dialog, 1)).getByLabelText("Designation"),
    "ai-lead"
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Remove Subsidiary department 2" })
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Save assignments" }));

  await expectSummary("Subsidiary Department 1", "AI & Automation", "AI Lead");
  expect(screen.queryByRole("region", { name: "Subsidiary Department 2" })).not.toBeInTheDocument();
  expect(screen.queryByText("HR Executive")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Manager")).toHaveValue("Priya Shah");
  expect(screen.getByLabelText("Group Lead")).toHaveValue("Rahul Mehta");
  expect(screen.getByLabelText("Date of Joining")).toHaveValue("2026-08-20");
  expect(screen.getByLabelText("Costing designation")).toHaveValue("junior");

  await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(saveUserProfile).toHaveBeenCalled());
  expect(saveUserProfile.mock.calls[0][0].profile.departmentDesignations).toEqual([
    { departmentId: "it", designationId: "junior" },
    { departmentId: "ai", designationId: "ai-lead" },
  ]);
  expect(saveUserProfile.mock.calls[0][0].profile.primaryDepartmentId).toBe("it");
  expect(saveUserProfile.mock.calls[0][0].profile.costingDesignationId).toBeUndefined();
});

function headerRole() {
  return document.querySelector(".dgv-profile-role");
}

test("keeps an inactive main assignment unless it is explicitly replaced", async () => {
  mockRouteEmail = "aisha@mydgv.com";
  fetchEmployeeDepartments.mockResolvedValue({ membership: { costingDesignationId: "" } });
  fetchUserProfile.mockResolvedValue(
    existingEmployee({
      departmentIds: ["old"],
      primaryDepartmentId: "old",
      departmentDesignations: [{ departmentId: "old", designationId: "old-role" }],
      designation: "IT",
    })
  );
  render(<AdminEmployeeProfile />);

  await expectSummary("Main Department", "Old Desk (inactive)", "Retired Role (inactive)");
  await waitFor(() =>
    expect(headerRole()).toHaveTextContent("Retired Role · Employee ID: DGV014")
  );
  expect(headerRole()).not.toHaveTextContent("IT ·");

  await userEvent.click(screen.getByRole("button", { name: "Edit department assignments" }));
  const dialog = await screen.findByRole("dialog", { name: "Department Assignment" });
  const main = mainGroup(dialog);
  await waitFor(() => expect(within(main).getByLabelText("Department")).toHaveValue("old"));
  expect(within(main).getByRole("option", { name: "Old Desk (inactive)" })).toBeInTheDocument();
  expect(within(main).getByLabelText("Track")).toHaveValue("Legacy");
  expect(within(main).getByRole("option", { name: "Legacy (inactive)" })).toBeInTheDocument();
  expect(within(main).getByLabelText("Designation")).toHaveValue("old-role");
  expect(within(main).getByRole("option", { name: "Retired Role (inactive)" })).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: /Remove Main Department/ })).not.toBeInTheDocument();

  await userEvent.click(within(dialog).getByRole("button", { name: "Add Subsidiary Department" }));
  const subsidiary = subsidiaryGroup(dialog);
  expect(within(subsidiary).queryByRole("option", { name: /Old Desk/ })).not.toBeInTheDocument();
  await fillAssignment(subsidiary, "ai", "AI / Machine Learning", "ai-eng");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save assignments" }));

  await expectSummary("Main Department", "Old Desk (inactive)", "Retired Role (inactive)");
  await expectSummary("Subsidiary Department 1", "AI & Automation", "AI Engineer");
  await userEvent.clear(screen.getByLabelText("Manager"));
  await userEvent.type(screen.getByLabelText("Manager"), "Neha Rao");
  expect(screen.getByLabelText("Group Lead")).toHaveValue("Rahul Mehta");
  expect(screen.getByLabelText("Date of Joining")).toHaveValue("2026-08-20");
  await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  await waitFor(() => expect(saveUserProfile).toHaveBeenCalled());
  const payload = saveUserProfile.mock.calls[0][0].profile;
  expect(payload).toEqual(
    expect.objectContaining({
      departmentIds: ["old", "ai"],
      primaryDepartmentId: "old",
      departmentDesignations: [
        { departmentId: "old", designationId: "old-role" },
        { departmentId: "ai", designationId: "ai-eng" },
      ],
      manager: "Neha Rao",
      groupLead: "Rahul Mehta",
      doj: "2026-08-20",
    })
  );
  expect(payload.designation).toBeUndefined();
  expect(payload.skill).toBeUndefined();
});

test("replaces an inactive main assignment only when an active one is selected", async () => {
  mockRouteEmail = "aisha@mydgv.com";
  fetchEmployeeDepartments.mockResolvedValue({ membership: { costingDesignationId: "" } });
  fetchUserProfile.mockResolvedValue(
    existingEmployee({
      departmentIds: ["old"],
      primaryDepartmentId: "old",
      departmentDesignations: [{ departmentId: "old", designationId: "old-role" }],
    })
  );
  render(<AdminEmployeeProfile />);
  await screen.findByText(/Retired Role \(inactive\)/);
  await userEvent.click(screen.getByRole("button", { name: "Edit department assignments" }));
  const dialog = await screen.findByRole("dialog", { name: "Department Assignment" });
  await waitFor(() =>
    expect(within(mainGroup(dialog)).getByLabelText("Department")).toHaveValue("old")
  );
  await fillAssignment(mainGroup(dialog), "it", "Engineering", "junior");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save assignments" }));

  await expectSummary("Main Department", "IT — Software Development", "Junior Developer");
  expect(screen.queryByText(/Retired Role \(inactive\)/)).not.toBeInTheDocument();
  await waitFor(() => expect(headerRole()).toHaveTextContent("Junior Developer"));
});

test("preserves an inactive subsidiary and can remove it explicitly", async () => {
  mockRouteEmail = "aisha@mydgv.com";
  fetchUserProfile.mockResolvedValue(
    existingEmployee({
      departmentIds: ["it", "old"],
      primaryDepartmentId: "it",
      departmentDesignations: [
        { departmentId: "it", designationId: "junior" },
        { departmentId: "old", designationId: "old-role" },
      ],
    })
  );
  render(<AdminEmployeeProfile />);

  await expectSummary("Subsidiary Department 1", "Old Desk (inactive)", "Retired Role (inactive)");
  await waitFor(() => expect(headerRole()).toHaveTextContent("Junior Developer · Employee ID: DGV014"));

  await userEvent.click(screen.getByRole("button", { name: "Edit department assignments" }));
  const dialog = await screen.findByRole("dialog", { name: "Department Assignment" });
  await waitFor(() =>
    expect(within(subsidiaryGroup(dialog)).getByLabelText("Department")).toHaveValue("old")
  );
  expect(
    within(subsidiaryGroup(dialog)).getByRole("option", { name: "Retired Role (inactive)" })
  ).toBeInTheDocument();
  expect(
    within(mainGroup(dialog)).queryByRole("option", { name: /Old Desk/ })
  ).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Save assignments" }));
  expect(await screen.findByText(/Retired Role \(inactive\)/)).toBeInTheDocument();

  await userEvent.clear(screen.getByLabelText("Group Lead"));
  await userEvent.type(screen.getByLabelText("Group Lead"), "Anika Sen");
  await userEvent.click(screen.getByRole("button", { name: "Edit department assignments" }));
  const editDialog = await screen.findByRole("dialog", { name: "Department Assignment" });
  await waitFor(() =>
    expect(within(subsidiaryGroup(editDialog)).getByLabelText("Designation")).toHaveValue("old-role")
  );
  await userEvent.click(
    within(editDialog).getByRole("button", { name: "Remove Subsidiary department 1" })
  );
  await userEvent.click(within(editDialog).getByRole("button", { name: "Save assignments" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: /Subsidiary Department/ })).not.toBeInTheDocument()
  );
  await expectSummary("Main Department", "IT — Software Development", "Junior Developer");
  expect(screen.getByLabelText("Manager")).toHaveValue("Priya Shah");
  expect(screen.getByLabelText("Group Lead")).toHaveValue("Anika Sen");
  expect(screen.getByLabelText("Date of Joining")).toHaveValue("2026-08-20");

  await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(saveUserProfile).toHaveBeenCalled());
  expect(saveUserProfile.mock.calls[0][0].profile).toEqual(
    expect.objectContaining({
      departmentIds: ["it"],
      primaryDepartmentId: "it",
      departmentDesignations: [{ departmentId: "it", designationId: "junior" }],
      manager: "Priya Shah",
      groupLead: "Anika Sen",
      doj: "2026-08-20",
    })
  );
});

test("shows a fallback in the identity header when no current designation exists", async () => {
  mockRouteEmail = "aisha@mydgv.com";
  fetchUserProfile.mockResolvedValue(
    existingEmployee({
      departmentIds: [],
      primaryDepartmentId: "",
      departmentDesignations: [],
      designation: "IT",
      skill: "SKILL#SEO",
    })
  );
  render(<AdminEmployeeProfile />);

  expect(await screen.findByRole("heading", { name: "Aisha Khan" })).toBeInTheDocument();
  expect(headerRole()).toHaveTextContent("No designation · Employee ID: DGV014");
  expect(headerRole()).not.toHaveTextContent("IT");
  expect(document.querySelector(".dgv-profile-email")).toHaveTextContent("aisha@mydgv.com");
  expect(document.querySelector(".dgv-profile-reports")).toHaveTextContent(
    "Manager: Priya Shah · Group Lead: Rahul Mehta"
  );
  expect(screen.queryByText("SKILL#SEO")).not.toBeInTheDocument();
});

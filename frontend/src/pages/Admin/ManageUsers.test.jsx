jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

const mockNavigate = jest.fn();
jest.mock(
  "react-router-dom",
  () => ({
    useNavigate: () => mockNavigate,
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchUsers: jest.fn(),
  fetchUserProfile: jest.fn(),
  fetchDepartments: jest.fn(),
  fetchDepartmentDesignations: jest.fn(),
  updateUserStatus: jest.fn(),
  updateUserRole: jest.fn(),
  deleteUser: jest.fn(),
  resetUserPassword: jest.fn(),
}));

jest.mock("../../services/auth", () => ({
  getLoggedInEmail: () => "admin@mydgv.com",
  PORTAL_ROLE_KEY: "portalRole",
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManageUsers from "./ManageUsers";
import {
  fetchDepartmentDesignations,
  fetchDepartments,
  fetchUserProfile,
  fetchUsers,
  updateUserStatus,
} from "../../services/api";

const DEPARTMENTS = {
  departments: [
    { departmentId: "it", name: "IT — Software Development", status: "ACTIVE" },
    { departmentId: "ai", name: "AI & Automation", status: "ACTIVE" },
    { departmentId: "old", name: "Old Desk", status: "INACTIVE" },
  ],
};

const DESIGNATIONS = {
  it: [
    {
      designationId: "junior",
      name: "Junior Developer",
      status: "ACTIVE",
    },
  ],
  ai: [
    {
      designationId: "ai-eng",
      name: "AI Engineer",
      status: "ACTIVE",
    },
  ],
  old: [
    {
      designationId: "old-role",
      name: "Retired Role",
      status: "INACTIVE",
    },
  ],
};

const USERS = [
  {
    email: "admin@mydgv.com",
    role: "SUPER_ADMIN",
    status: "ACTIVE",
    name: "Admin",
  },
  {
    email: "aisha@mydgv.com",
    role: "EMPLOYEE",
    status: "ACTIVE",
    name: "Aisha Khan",
    empId: "DGV014",
    department: "Engineering",
    departmentIds: ["it", "ai"],
    primaryDepartmentId: "ai",
    designation: "Old Title",
    departmentDesignations: [
      { departmentId: "ai", designationId: "ai-eng" },
      { departmentId: "it", designationId: "junior" },
    ],
  },
  {
    email: "legacy@mydgv.com",
    role: "EMPLOYEE",
    status: "ACTIVE",
    name: "Legacy User",
    department: "Desk",
    designation: "Coordinator",
    departmentIds: [],
  },
  {
    email: "old.desk@mydgv.com",
    role: "EMPLOYEE",
    status: "BLOCKED",
    name: "Old Desk User",
    departmentIds: ["old", "missing"],
    primaryDepartmentId: "old",
    designation: "Stale",
    departmentDesignations: [{ departmentId: "old", designationId: "old-role" }],
  },
];

beforeEach(() => {
  mockNavigate.mockReset();
  fetchUsers.mockResolvedValue(USERS);
  fetchDepartments.mockResolvedValue(DEPARTMENTS);
  fetchUserProfile.mockImplementation(async (email) => {
    return USERS.find((user) => user.email === email) || {};
  });
  fetchDepartmentDesignations.mockImplementation(async (id) => ({
    designations: DESIGNATIONS[id] || [],
  }));
  updateUserStatus.mockResolvedValue({});
});

function rowFor(email) {
  return screen.getByRole("row", { name: new RegExp(email) });
}

test("shows assignment departments and the main designation without legacy text", async () => {
  render(<ManageUsers />);

  expect(await screen.findByRole("row", { name: /aisha@mydgv.com/ })).toBeInTheDocument();
  expect(document.querySelectorAll(".dgv-stat-card")).toHaveLength(4);
  expect(screen.getByText("Total Employees")).toBeInTheDocument();
  expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Inactive").length).toBeGreaterThan(0);
  expect(screen.getByText("Admins")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "All Employees" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Active" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inactive" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "+ Add Employee" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Filter by department" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Filter by designation" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Joining Date" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Manage / })).not.toBeInTheDocument();
  expect(document.querySelector(".dgv-employees-table__actions")).toBeTruthy();

  const assigned = rowFor("aisha@mydgv.com");
  const department = within(assigned).getByRole("cell", { name: /Main Department/ });
  expect(department).toHaveTextContent("Main Department");
  expect(department).toHaveTextContent("AI & Automation");
  expect(department).toHaveTextContent("Subsidiary Department");
  expect(department).toHaveTextContent("IT — Software Development");
  expect(department.textContent.indexOf("Main Department")).toBeLessThan(
    department.textContent.indexOf("Subsidiary Department")
  );
  expect(department).not.toHaveTextContent("unmatched");
  expect(department).not.toHaveTextContent("Engineering");
  expect(within(assigned).getByRole("cell", { name: "AI Engineer" })).toBeInTheDocument();
  expect(within(assigned).queryByText("Old Title")).not.toBeInTheDocument();

  const legacy = rowFor("legacy@mydgv.com");
  expect(within(legacy).queryByRole("cell", { name: "Desk" })).not.toBeInTheDocument();
  expect(within(legacy).queryByRole("cell", { name: "Coordinator" })).not.toBeInTheDocument();
  expect(within(legacy).queryByText("Main Department")).not.toBeInTheDocument();

  const inactive = rowFor("old.desk@mydgv.com");
  expect(within(inactive).getByText("Old Desk (inactive)")).toBeInTheDocument();
  expect(within(inactive).getByText("missing (missing from catalog)")).toBeInTheDocument();
  expect(within(inactive).getByRole("cell", { name: "Designation inactive" })).toBeInTheDocument();
  expect(within(inactive).queryByText("Stale")).not.toBeInTheDocument();

  await waitFor(() =>
    expect(fetchDepartmentDesignations.mock.calls.map((call) => call[0]).sort()).toEqual([
      "ai",
      "it",
      "missing",
      "old",
    ])
  );
  expect(fetchDepartmentDesignations).toHaveBeenCalledTimes(4);
  expect(fetchUserProfile).not.toHaveBeenCalled();
  expect(fetchUsers).toHaveBeenCalledTimes(1);
  expect(fetchDepartments).toHaveBeenCalledTimes(1);
});

test("filters and search use current departments and the main designation", async () => {
  render(<ManageUsers />);
  await screen.findByRole("row", { name: /aisha@mydgv.com/ });

  const departmentFilter = screen.getByRole("combobox", { name: "Filter by department" });
  expect(
    within(departmentFilter).getByRole("option", { name: "AI & Automation" })
  ).toBeInTheDocument();
  expect(
    within(departmentFilter).getByRole("option", { name: "IT — Software Development" })
  ).toBeInTheDocument();
  expect(
    within(departmentFilter).getByRole("option", { name: "Old Desk (inactive)" })
  ).toBeInTheDocument();
  expect(
    within(departmentFilter).getByRole("option", { name: "missing (missing from catalog)" })
  ).toBeInTheDocument();
  expect(
    within(departmentFilter).queryByRole("option", { name: /unmatched|Engineering/ })
  ).not.toBeInTheDocument();

  await userEvent.selectOptions(departmentFilter, "ai");
  expect(screen.getByRole("row", { name: /aisha@mydgv.com/ })).toBeInTheDocument();
  expect(screen.queryByRole("row", { name: /legacy@mydgv.com/ })).not.toBeInTheDocument();

  await userEvent.selectOptions(departmentFilter, "it");
  expect(screen.getByRole("row", { name: /aisha@mydgv.com/ })).toBeInTheDocument();
  expect(screen.queryByRole("row", { name: /old.desk@mydgv.com/ })).not.toBeInTheDocument();

  await userEvent.selectOptions(departmentFilter, "old");
  expect(screen.getByRole("row", { name: /old.desk@mydgv.com/ })).toBeInTheDocument();
  expect(screen.queryByRole("row", { name: /aisha@mydgv.com/ })).not.toBeInTheDocument();
  await userEvent.selectOptions(departmentFilter, "");

  const designationFilter = screen.getByRole("combobox", { name: "Filter by designation" });
  expect(within(designationFilter).getByRole("option", { name: "AI Engineer" })).toBeInTheDocument();
  expect(within(designationFilter).queryByRole("option", { name: "Coordinator" })).not.toBeInTheDocument();
  expect(
    within(designationFilter).getByRole("option", { name: "Designation inactive" })
  ).toBeInTheDocument();
  expect(within(designationFilter).queryByRole("option", { name: "Old Title" })).not.toBeInTheDocument();
  expect(within(designationFilter).queryByRole("option", { name: "Stale" })).not.toBeInTheDocument();

  await userEvent.selectOptions(designationFilter, "AI Engineer");
  expect(screen.getByRole("row", { name: /aisha@mydgv.com/ })).toBeInTheDocument();
  expect(screen.queryByRole("row", { name: /legacy@mydgv.com/ })).not.toBeInTheDocument();

  await userEvent.selectOptions(designationFilter, "Designation inactive");
  expect(screen.getByRole("row", { name: /old.desk@mydgv.com/ })).toBeInTheDocument();
  await userEvent.selectOptions(designationFilter, "");

  await userEvent.selectOptions(departmentFilter, "ai");
  const scopedDesignations = screen.getByRole("combobox", { name: "Filter by designation" });
  expect(within(scopedDesignations).getByRole("option", { name: "AI Engineer" })).toBeInTheDocument();
  expect(
    within(scopedDesignations).queryByRole("option", { name: "Junior Developer" })
  ).not.toBeInTheDocument();
  expect(
    within(scopedDesignations).queryByRole("option", { name: "Coordinator" })
  ).not.toBeInTheDocument();
  await userEvent.selectOptions(scopedDesignations, "AI Engineer");
  expect(screen.getByRole("row", { name: /aisha@mydgv.com/ })).toBeInTheDocument();
  expect(screen.queryByRole("row", { name: /old.desk@mydgv.com/ })).not.toBeInTheDocument();

  await userEvent.selectOptions(departmentFilter, "it");
  expect(screen.getByRole("combobox", { name: "Filter by designation" })).toHaveValue("");
  expect(
    within(screen.getByRole("combobox", { name: "Filter by designation" })).getByRole(
      "option",
      { name: "Junior Developer" }
    )
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("combobox", { name: "Filter by designation" })).queryByRole(
      "option",
      { name: "AI Engineer" }
    )
  ).not.toBeInTheDocument();
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Filter by designation" }),
    "Junior Developer"
  );
  expect(screen.getByRole("row", { name: /aisha@mydgv.com/ })).toBeInTheDocument();
  expect(screen.queryByRole("row", { name: /legacy@mydgv.com/ })).not.toBeInTheDocument();
  await userEvent.selectOptions(departmentFilter, "");
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Filter by designation" }),
    ""
  );

  const search = screen.getByRole("searchbox", { name: "Search employees" });
  await userEvent.type(search, "Engineering");
  expect(screen.queryByRole("row", { name: /aisha@mydgv.com/ })).not.toBeInTheDocument();
  await userEvent.clear(search);
  await userEvent.type(search, "AI Engineer");
  expect(screen.getByRole("row", { name: /aisha@mydgv.com/ })).toBeInTheDocument();
  expect(screen.queryByRole("row", { name: /legacy@mydgv.com/ })).not.toBeInTheDocument();
  await userEvent.clear(search);
  await userEvent.type(search, "Coordinator");
  expect(screen.queryByRole("row", { name: /legacy@mydgv.com/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("row", { name: /aisha@mydgv.com/ })).not.toBeInTheDocument();
  await userEvent.clear(search);
  await userEvent.type(search, "Desk");
  expect(screen.queryByRole("row", { name: /legacy@mydgv.com/ })).not.toBeInTheDocument();
});

test("uses the profile assignment link when the list response omits it", async () => {
  fetchUsers.mockResolvedValueOnce([
    {
      email: "aisha@mydgv.com",
      role: "EMPLOYEE",
      status: "ACTIVE",
      name: "Aisha Khan",
      departmentIds: ["ai"],
      primaryDepartmentId: "ai",
      designation: "Old Title",
    },
  ]);
  fetchUserProfile.mockResolvedValueOnce({
    departmentDesignations: [{ departmentId: "ai", designationId: "ai-eng" }],
  });

  render(<ManageUsers />);

  expect(await screen.findByRole("cell", { name: "AI Engineer" })).toBeInTheDocument();
  expect(screen.queryByRole("cell", { name: "No designation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("cell", { name: "Old Title" })).not.toBeInTheDocument();
  expect(fetchUserProfile).toHaveBeenCalledTimes(1);
  expect(fetchUserProfile).toHaveBeenCalledWith("aisha@mydgv.com");
});

test("Edit and Track keep the existing employee actions and permissions", async () => {
  render(<ManageUsers />);
  const aisha = await screen.findByRole("row", { name: /aisha@mydgv.com/ });

  expect(within(aisha).getByRole("button", { name: "Track" })).toBeInTheDocument();
  await userEvent.click(within(aisha).getByRole("button", { name: "Edit ▾" }));
  expect(screen.getByRole("menuitem", { name: "Edit profile" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "View" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Deactivate" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Reset password" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Track" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("menuitem", { name: "Edit profile" }));
  expect(mockNavigate).toHaveBeenCalledWith("/admin/employees/aisha%40mydgv.com?edit=1");

  await userEvent.click(within(rowFor("aisha@mydgv.com")).getByRole("button", { name: "Track" }));
  expect(mockNavigate).toHaveBeenCalledWith("/admin/employees/aisha%40mydgv.com/track");

  await userEvent.click(within(rowFor("aisha@mydgv.com")).getByRole("button", { name: "Edit ▾" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "View" }));
  expect(mockNavigate).toHaveBeenCalledWith("/admin/employees/aisha%40mydgv.com");

  await userEvent.click(within(rowFor("aisha@mydgv.com")).getByRole("button", { name: "Edit ▾" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Deactivate" }));
  expect(updateUserStatus).toHaveBeenCalledWith("aisha@mydgv.com", "deactivate");
  const oldDesk = await screen.findByRole("row", { name: /old.desk@mydgv.com/ });

  await userEvent.click(within(oldDesk).getByRole("button", { name: "Edit ▾" }));
  expect(screen.getByRole("menuitem", { name: "Activate" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Deactivate" })).not.toBeInTheDocument();

  await userEvent.click(document.body);
  expect(screen.queryByRole("menuitem", { name: "Activate" })).not.toBeInTheDocument();

  await userEvent.click(within(rowFor("admin@mydgv.com")).getByRole("button", { name: "Edit ▾" }));
  expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
});

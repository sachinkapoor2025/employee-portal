jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock(
  "react-router-dom",
  () => ({
    Link: ({ children, to }) => <a href={to}>{children}</a>,
    useNavigate: () => jest.fn(),
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(), jest.fn()],
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchUsers: jest.fn(),
  fetchSkills: jest.fn(),
  fetchDepartments: jest.fn(),
  fetchDepartmentDesignations: jest.fn(),
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

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminEmployeeProfile from "./AdminEmployeeProfile";
import {
  fetchDepartmentDesignations,
  fetchDepartments,
  fetchSkills,
  fetchUsers,
  saveUserProfile,
} from "../../services/api";

beforeEach(() => {
  jest.clearAllMocks();
  fetchUsers.mockResolvedValue([
    { email: "admin@mydgv.com", role: "ADMIN", status: "ACTIVE" },
  ]);
  fetchSkills.mockResolvedValue([{ code: "SEO", name: "SEO" }]);
  fetchDepartmentDesignations.mockResolvedValue({ designations: [] });
  fetchDepartments.mockResolvedValue({
    departments: [
      { departmentId: "it", name: "IT — Software Development", status: "ACTIVE" },
      { departmentId: "ai", name: "AI & Automation", status: "ACTIVE" },
    ],
  });
  saveUserProfile.mockResolvedValue({ message: "User saved successfully" });
});

test("creates an employee in multiple departments without changing designation", async () => {
  render(<AdminEmployeeProfile />);
  await screen.findByLabelText("IT — Software Development");
  await userEvent.type(screen.getByLabelText("Email"), "new.person@mydgv.com");
  await userEvent.selectOptions(screen.getByLabelText("Skill"), "SEO");
  await userEvent.click(screen.getByLabelText("IT — Software Development"));
  await userEvent.click(screen.getByLabelText("AI & Automation"));
  await userEvent.selectOptions(screen.getByLabelText("Primary department"), "ai");
  await userEvent.type(screen.getByLabelText("Designation"), "Analyst");
  await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  await waitFor(() => expect(saveUserProfile).toHaveBeenCalled());
  expect(saveUserProfile).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "CREATE",
      email: "new.person@mydgv.com",
      role: "EMPLOYEE",
      profile: expect.objectContaining({
        designation: "Analyst",
        skill: "SEO",
        departmentIds: ["it", "ai"],
        primaryDepartmentId: "ai",
      }),
    })
  );
  const payload = saveUserProfile.mock.calls[0][0].profile;
  expect(payload.department).toBeUndefined();
  expect(payload.departmentIds).toEqual(["it", "ai"]);
});

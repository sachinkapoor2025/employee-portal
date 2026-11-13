jest.mock("../components/Layout", () => {
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

jest.mock("../services/auth", () => ({
  getLoggedInEmail: jest.fn(() => "asha@mydgv.com"),
}));

jest.mock("../services/api", () => ({
  fetchUserProfile: jest.fn(),
  fetchDepartments: jest.fn(),
  fetchDepartmentDesignations: jest.fn(),
  saveUserProfile: jest.fn(),
  getProfileImageUploadUrl: jest.fn(),
  apiOptional: jest.fn(),
  fetchEmployeeShift: jest.fn(),
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Profile from "./Profile";
import { getLoggedInEmail } from "../services/auth";
import {
  fetchDepartmentDesignations,
  fetchDepartments,
  fetchEmployeeShift,
  fetchUserProfile,
  saveUserProfile,
} from "../services/api";

const DEPARTMENTS = [
  { departmentId: "it", name: "IT — Software Development", status: "ACTIVE" },
];

const CATALOG_PROFILE = {
  name: "Asha Rao",
  empId: "DGV014",
  email: "asha@mydgv.com",
  phone: "9876543210",
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

function fieldValue(container, label) {
  const labelEl = within(container).getByText(label, { selector: "label" });
  return labelEl.parentElement.querySelector(".dgv-profile-value").textContent;
}

beforeEach(() => {
  mockNavigate.mockReset();
  getLoggedInEmail.mockReturnValue("asha@mydgv.com");
  fetchUserProfile.mockResolvedValue(CATALOG_PROFILE);
  fetchDepartments.mockResolvedValue({ departments: DEPARTMENTS });
  fetchDepartmentDesignations.mockResolvedValue({
    designations: [
      {
        designationId: "junior",
        departmentId: "it",
        name: "Junior Developer",
        track: "Engineering",
        status: "ACTIVE",
      },
    ],
  });
  fetchEmployeeShift.mockResolvedValue({
    shift: {
      name: "General",
      startTime: "09:30",
      endTime: "18:30",
      crossesMidnight: false,
    },
  });
  saveUserProfile.mockResolvedValue({ message: "User saved successfully" });
});

test("shows employment and reporting details without a skills section", async () => {
  render(<Profile />);

  expect(await screen.findByRole("heading", { name: "Employment Details" })).toBeInTheDocument();
  const employment = screen.getByRole("heading", { name: "Employment Details" }).parentElement;
  expect(fieldValue(employment, "Department")).toBe("IT — Software Development");
  expect(fieldValue(employment, "Designation")).toBe("Junior Developer");
  expect(fieldValue(employment, "Track")).toBe("Engineering");
  expect(fieldValue(employment, "Date of Joining")).toBe("20 Aug 2026");
  expect(screen.queryByText(/Legacy unmatched/)).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Skills" })).not.toBeInTheDocument();
  expect(screen.queryByText("Skill", { selector: "label" })).not.toBeInTheDocument();
  expect(screen.queryByText("SEO")).not.toBeInTheDocument();
  expect(screen.queryByText("SKILL#SEO")).not.toBeInTheDocument();

  expect(screen.getByText("Junior Developer · Employee ID: DGV014")).toBeInTheDocument();
  const reporting = screen.getByRole("heading", { name: "Reporting Structure" }).parentElement;
  expect(fieldValue(reporting, "Manager")).toBe("Priya Shah");
  expect(fieldValue(reporting, "Group Lead")).toBe("Rahul Mehta");
  expect(screen.getByText("General (09:30 – 18:30)")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit Profile" })).toBeInTheDocument();
  expect(reporting.parentElement.querySelectorAll(".dgv-profile-subsection")).toHaveLength(2);
});

test("personal profile save keeps structured assignments and omits legacy text", async () => {
  fetchUserProfile.mockResolvedValue({
    name: "Asha Rao",
    empId: "DGV014",
    email: "asha@mydgv.com",
    designation: "Coordinator",
    department: "Operations",
    skill: "",
    manager: "Priya Shah",
    groupLead: "Rahul Mehta",
    doj: "2024-01-05",
  });
  fetchDepartmentDesignations.mockResolvedValue({ designations: [] });

  render(<Profile />);

  const employment = (await screen.findByRole("heading", { name: "Employment Details" }))
    .parentElement;
  expect(within(employment).queryByText("Department", { selector: "label" })).not.toBeInTheDocument();
  expect(within(employment).queryByText("Designation", { selector: "label" })).not.toBeInTheDocument();
  expect(fieldValue(employment, "Date of Joining")).toBe("5 Jan 2024");
  expect(screen.queryByText("Operations")).not.toBeInTheDocument();
  expect(screen.queryByText("Coordinator")).not.toBeInTheDocument();
  expect(screen.getByText("— · Employee ID: DGV014")).toBeInTheDocument();
  expect(screen.getByText("General (09:30 – 18:30)")).toBeInTheDocument();
});

test("editing the profile keeps the stored skill and does not show it", async () => {
  render(<Profile />);
  await screen.findByText("Junior Developer");
  await userEvent.click(screen.getByRole("button", { name: "Edit Profile" }));

  expect(screen.queryByLabelText("Skill")).not.toBeInTheDocument();
  expect(screen.queryByText("SEO")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Full Name")).toHaveValue("Asha Rao");
  expect(screen.queryByLabelText("Designation")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  await waitFor(() => expect(saveUserProfile).toHaveBeenCalled());
  const payload = saveUserProfile.mock.calls[0][0].profile;
  expect(payload.skill).toBe("SKILL#SEO");
  expect(payload.designation).toBeUndefined();
  expect(payload.department).toBeUndefined();
  expect(payload.departmentIds).toEqual(["it"]);
  expect(payload.primaryDepartmentId).toBe("it");
  expect(payload.departmentDesignations).toEqual([
    { departmentId: "it", designationId: "junior" },
  ]);
});

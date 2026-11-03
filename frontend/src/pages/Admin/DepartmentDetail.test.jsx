jest.mock(
  "react-router-dom",
  () => ({
    Link: ({ children, to }) => <a href={to}>{children}</a>,
    useParams: () => ({ departmentId: "it-software-development" }),
  }),
  { virtual: true }
);

jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../../services/api", () => ({
  fetchAdminDepartments: jest.fn(),
  fetchAdminDepartmentDesignations: jest.fn(),
  updateDepartment: jest.fn(),
  createDepartmentDesignation: jest.fn(),
  updateDepartmentDesignation: jest.fn(),
  setDepartmentDesignationStatus: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DepartmentDetail from "./DepartmentDetail";
import {
  createDepartmentDesignation,
  fetchAdminDepartmentDesignations,
  fetchAdminDepartments,
  setDepartmentDesignationStatus,
  updateDepartment,
} from "../../services/api";

const DEPARTMENT = {
  departmentId: "it-software-development",
  name: "IT — Software Development",
  description: "Client websites",
  status: "ACTIVE",
  employeeCount: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
  fetchAdminDepartments.mockResolvedValue({ departments: [DEPARTMENT] });
  fetchAdminDepartmentDesignations.mockResolvedValue({ designations: [] });
  updateDepartment.mockResolvedValue({
    department: { ...DEPARTMENT, name: "IT Platform" },
  });
  setDepartmentDesignationStatus.mockResolvedValue({
    designation: { designationId: "role-1", status: "INACTIVE" },
  });
});

test("opens a department with an empty designation list and keeps its ID on rename", async () => {
  render(<DepartmentDetail />);
  expect(await screen.findByText("IT — Software Development")).toBeInTheDocument();
  expect(screen.getByText("it-software-development")).toBeInTheDocument();
  expect(screen.getByText(/senior-to-entry/i)).toBeInTheDocument();
  expect(screen.getByText("No designations for this department yet.")).toBeInTheDocument();
  expect(createDepartmentDesignation).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Edit department" }));
  const name = screen.getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "IT Platform");
  await userEvent.click(screen.getByRole("button", { name: "Save department" }));
  await waitFor(() =>
    expect(updateDepartment).toHaveBeenCalledWith("it-software-development", {
      name: "IT Platform",
      description: "Client websites",
    })
  );
});

test("deactivates an existing designation instead of deleting it", async () => {
  fetchAdminDepartmentDesignations.mockResolvedValue({
    designations: [
      {
        designationId: "role-1",
        departmentId: "it-software-development",
        name: "Existing role",
        status: "ACTIVE",
      },
    ],
  });
  render(<DepartmentDetail />);
  expect(await screen.findByText("Existing role")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));
  await waitFor(() =>
    expect(setDepartmentDesignationStatus).toHaveBeenCalledWith(
      "it-software-development",
      "role-1",
      "INACTIVE"
    )
  );
});

jest.mock(
  "react-router-dom",
  () => ({
    Link: ({ children, to }) => <a href={to}>{children}</a>,
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
  createDepartment: jest.fn(),
  updateDepartment: jest.fn(),
  setDepartmentStatus: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManageDepartments from "./ManageDepartments";
import {
  createDepartment,
  fetchAdminDepartments,
  setDepartmentStatus,
  updateDepartment,
} from "../../services/api";

const IT = {
  departmentId: "it-software-development",
  name: "IT — Software Development",
  description: "Client websites",
  status: "ACTIVE",
  employeeCount: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
  fetchAdminDepartments.mockResolvedValue({ departments: [IT] });
  createDepartment.mockResolvedValue({ department: IT });
  updateDepartment.mockResolvedValue({ department: { ...IT, name: "IT Platform" } });
  setDepartmentStatus.mockResolvedValue({
    department: { ...IT, status: "INACTIVE" },
  });
});

test("searches departments and deactivates without deleting", async () => {
  render(<ManageDepartments />);
  expect(await screen.findByText("IT — Software Development")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
    "href",
    "/admin/departments/it-software-development"
  );
  expect(screen.getByText("2")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Search"), "missing");
  expect(screen.getByText("No departments found.")).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText("Search"));
  await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));
  await waitFor(() =>
    expect(setDepartmentStatus).toHaveBeenCalledWith(
      "it-software-development",
      "INACTIVE"
    )
  );
  expect(await screen.findByText("Department deactivated.")).toBeInTheDocument();
});

test("creates a department from the catalog form", async () => {
  render(<ManageDepartments />);
  await screen.findByText("IT — Software Development");
  await userEvent.type(screen.getByLabelText("Name"), "Research");
  await userEvent.type(screen.getByLabelText("Description"), "Labs");
  await userEvent.click(screen.getByRole("button", { name: "Create department" }));
  await waitFor(() =>
    expect(createDepartment).toHaveBeenCalledWith({
      name: "Research",
      description: "Labs",
    })
  );
  expect(await screen.findByText("Department created.")).toBeInTheDocument();
});

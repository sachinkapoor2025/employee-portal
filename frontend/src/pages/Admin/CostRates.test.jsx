jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../../services/api", () => ({
  fetchCostRateDesignations: jest.fn(),
  createCostRateDesignation: jest.fn(),
  updateCostRateDesignation: jest.fn(),
  setCostRateDesignationStatus: jest.fn(),
  fetchCostRateEmployees: jest.fn(),
  fetchCostRateEmployee: jest.fn(),
  fetchDepartments: jest.fn(),
  fetchDepartmentDesignations: jest.fn(),
  saveCostRateEmployee: jest.fn(),
  setCostRateEmployeeStatus: jest.fn(),
  fetchCostingRoster: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CostRates from "./CostRates";
import {
  createCostRateDesignation,
  fetchCostRateDesignations,
  fetchCostRateEmployee,
  fetchCostRateEmployees,
  fetchDepartments,
  fetchDepartmentDesignations,
  saveCostRateEmployee,
  setCostRateDesignationStatus,
  updateCostRateDesignation,
} from "../../services/api";

const DESIGNATION = {
  designationId: "seo",
  departmentId: "it",
  track: "SEO",
  trackSort: 1,
  sortOrder: 2,
  name: "SEO Executive",
  internalHourlyRate: 2,
  externalHourlyRate: 3,
  status: "ACTIVE",
  hasConfiguredRate: true,
};

const EMPLOYEE = {
  email: "rahul@mydgv.com",
  name: "Rahul",
  empId: "E1",
  profileDesignation: "Free text SEO",
  departmentIds: ["it"],
  departmentDesignations: [{ departmentId: "it", designationId: "seo" }],
  designationId: "seo",
  designationName: "SEO Executive",
  internalHourlyRate: 2.25,
  externalHourlyRate: null,
  status: "ACTIVE",
  hasRateRecord: true,
  resolved: {
    internal: { rate: 2.25, source: "EMPLOYEE" },
    external: { rate: 3, source: "DESIGNATION" },
  },
};

async function openRahul() {
  await userEvent.click(screen.getByRole("tab", { name: "Employees" }));
  const search = screen.getByRole("combobox", { name: "Search employees" });
  await userEvent.type(search, "rah");
  await userEvent.click(screen.getByRole("option", { name: /Rahul/ }));
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchCostRateDesignations.mockResolvedValue({
    designations: [DESIGNATION],
    legacyReport: {
      unmatched: [
        {
          designationId: "legacy-seo",
          name: "Legacy Contractor",
          reason: "No department designation has this exact name.",
        },
      ],
      ambiguous: [],
      pendingMatches: [],
    },
  });
  fetchCostRateEmployees.mockResolvedValue({ employees: [EMPLOYEE] });
  fetchDepartments.mockResolvedValue({
    departments: [
      { departmentId: "it", name: "IT — Software Development", status: "ACTIVE" },
      { departmentId: "ai", name: "AI & Automation", status: "ACTIVE" },
    ],
  });
  fetchDepartmentDesignations.mockResolvedValue({ designations: [] });
  fetchCostRateEmployee.mockResolvedValue({ employee: EMPLOYEE });
  createCostRateDesignation.mockResolvedValue({ designation: DESIGNATION });
  updateCostRateDesignation.mockResolvedValue({ designation: DESIGNATION });
  setCostRateDesignationStatus.mockResolvedValue({
    designation: { ...DESIGNATION, status: "INACTIVE" },
  });
  saveCostRateEmployee.mockResolvedValue({ employee: EMPLOYEE });
});

test("loads costing designations and does not create one from Cost Rates", async () => {
  render(<CostRates />);
  expect(await screen.findByText(/Legacy Contractor/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "+ New designation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create designation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();

  await userEvent.selectOptions(screen.getByLabelText("Department"), "it");
  await userEvent.selectOptions(screen.getByLabelText("Track"), "SEO");
  expect(await screen.findByText("SEO Executive")).toBeInTheDocument();
  expect(screen.getAllByText("$2.00").length).toBeGreaterThan(0);

  await userEvent.click(screen.getByRole("button", { name: "Edit rate" }));
  expect(screen.getByLabelText("Designation name")).toHaveAttribute("readonly");
  await userEvent.click(screen.getByRole("button", { name: "Save designation" }));
  await waitFor(() =>
    expect(updateCostRateDesignation).toHaveBeenCalledWith(
      "seo",
      expect.objectContaining({ internalHourlyRate: 2, externalHourlyRate: 3 })
    )
  );
  expect(updateCostRateDesignation.mock.calls[0][1].name).toBeUndefined();
});

test("filters employees by department before search", async () => {
  fetchCostRateEmployees.mockResolvedValue({
    employees: [
      { ...EMPLOYEE, departmentIds: ["it"] },
      {
        ...EMPLOYEE,
        email: "other@mydgv.com",
        name: "Other Person",
        departmentIds: ["ai"],
      },
    ],
  });
  render(<CostRates />);
  await screen.findByRole("heading", { name: "Cost Rates" });
  await userEvent.click(screen.getByRole("tab", { name: "Employees" }));
  await userEvent.selectOptions(screen.getByLabelText("Department"), "it");
  await userEvent.click(screen.getByRole("button", { name: "Show employees" }));
  expect(screen.getByRole("option", { name: /Rahul/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Other Person/ })).not.toBeInTheDocument();
});

test("employee rates show resolved source and can clear a personal rate", async () => {
  const cleared = {
    ...EMPLOYEE,
    internalHourlyRate: null,
    resolved: {
      internal: { rate: 2, source: "DESIGNATION" },
      external: { rate: 3, source: "DESIGNATION" },
    },
  };
  saveCostRateEmployee.mockResolvedValueOnce({ employee: cleared });
  fetchCostRateEmployee
    .mockResolvedValueOnce({ employee: EMPLOYEE })
    .mockResolvedValueOnce({ employee: cleared });

  render(<CostRates />);
  await screen.findByRole("heading", { name: "Cost Rates" });
  await openRahul();
  expect(await screen.findByText(/Resolved Internal/)).toHaveTextContent("$2.25");
  expect(screen.getByText(/Resolved Internal/)).toHaveTextContent("(Employee)");
  expect(screen.getByText(/Resolved External/)).toHaveTextContent("$3.00");
  expect(screen.getByText(/Resolved External/)).toHaveTextContent("(Designation)");
  expect(screen.getByText(/Profile designation/)).toHaveTextContent("Free text SEO");

  const internal = screen.getByLabelText("Internal hourly rate (USD)");
  await userEvent.clear(internal);
  await userEvent.click(screen.getByRole("button", { name: "Save employee rates" }));
  await waitFor(() =>
    expect(saveCostRateEmployee).toHaveBeenCalledWith("rahul@mydgv.com", {
      designationId: "seo",
      internalHourlyRate: null,
      externalHourlyRate: null,
    })
  );
});

test("shows API errors when Super Admin load fails", async () => {
  fetchCostRateDesignations.mockRejectedValueOnce(
    new Error("Super Admin required")
  );
  render(<CostRates />);
  expect(await screen.findByText("Super Admin required")).toBeInTheDocument();
});

test("shows validation error for invalid employee rate", async () => {
  render(<CostRates />);
  await screen.findByRole("heading", { name: "Cost Rates" });
  await openRahul();
  const internal = await screen.findByLabelText("Internal hourly rate (USD)");
  await userEvent.clear(internal);
  await userEvent.type(internal, "1.234");
  await userEvent.click(screen.getByRole("button", { name: "Save employee rates" }));
  expect(
    await screen.findByText(/at most two decimal places/)
  ).toBeInTheDocument();
  expect(saveCostRateEmployee).not.toHaveBeenCalled();
});

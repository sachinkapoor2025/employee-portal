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
  saveCostRateEmployee,
  setCostRateDesignationStatus,
  updateCostRateDesignation,
} from "../../services/api";

const DESIGNATION = {
  designationId: "seo",
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
  fetchCostRateDesignations.mockResolvedValue({ designations: [DESIGNATION] });
  fetchCostRateEmployees.mockResolvedValue({ employees: [EMPLOYEE] });
  fetchCostRateEmployee.mockResolvedValue({ employee: EMPLOYEE });
  createCostRateDesignation.mockResolvedValue({ designation: DESIGNATION });
  updateCostRateDesignation.mockResolvedValue({ designation: DESIGNATION });
  setCostRateDesignationStatus.mockResolvedValue({
    designation: { ...DESIGNATION, status: "INACTIVE" },
  });
  saveCostRateEmployee.mockResolvedValue({ employee: EMPLOYEE });
});

test("loads designations and supports create, edit, and deactivate", async () => {
  render(<CostRates />);
  expect(await screen.findByText("SEO Executive")).toBeInTheDocument();
  expect(screen.queryByText("No configured rate")).not.toBeInTheDocument();
  expect(screen.getAllByText("$2.00").length).toBeGreaterThan(0);

  await userEvent.click(screen.getByRole("button", { name: "+ New designation" }));
  await userEvent.type(screen.getByLabelText("Designation name"), "QA");
  await userEvent.type(screen.getByLabelText("Internal hourly rate (USD)"), "4.50");
  await userEvent.click(screen.getByRole("button", { name: "Create designation" }));
  await waitFor(() =>
    expect(createCostRateDesignation).toHaveBeenCalledWith({
      name: "QA",
      internalHourlyRate: 4.5,
      externalHourlyRate: null,
    })
  );

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const name = screen.getByLabelText("Designation name");
  await userEvent.clear(name);
  await userEvent.type(name, "SEO Lead");
  await userEvent.click(screen.getByRole("button", { name: "Save designation" }));
  await waitFor(() =>
    expect(updateCostRateDesignation).toHaveBeenCalledWith(
      "seo",
      expect.objectContaining({ name: "SEO Lead" })
    )
  );

  await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));
  await waitFor(() =>
    expect(setCostRateDesignationStatus).toHaveBeenCalledWith("seo", "INACTIVE")
  );
});

test("shows API errors from designation create", async () => {
  createCostRateDesignation.mockRejectedValueOnce(
    new Error("A designation with this name already exists.")
  );
  render(<CostRates />);
  await screen.findByText("SEO Executive");
  await userEvent.click(screen.getByRole("button", { name: "+ New designation" }));
  await userEvent.type(screen.getByLabelText("Designation name"), "SEO Executive");
  await userEvent.click(screen.getByRole("button", { name: "Create designation" }));
  expect(
    await screen.findByText("A designation with this name already exists.")
  ).toBeInTheDocument();
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
  await screen.findByText("SEO Executive");
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
  await screen.findByText("SEO Executive");
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

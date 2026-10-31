jest.mock("../../services/api", () => ({
  fetchCostingRoster: jest.fn(),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CostRatesCosting from "./CostRatesCosting";
import { fetchCostingRoster } from "../../services/api";
import { addDaysToKey, companyDateKey } from "../../utils/costingReports";

const RAHUL = {
  email: "rahul@mydgv.com",
  name: "Rahul",
  confirmedCostUsd: 10,
  truncated: false,
  projects: [
    { projectId: "p1", name: "Portal", confirmedCostUsd: 6 },
    { projectId: "p2", name: "Site", confirmedCostUsd: 4 },
  ],
};

beforeEach(() => {
  fetchCostingRoster.mockImplementation(async ({ from, to }) => ({
    range: { from, to },
    truncated: false,
    employees: String(from).startsWith("2020") ? [] : [RAHUL],
  }));
});

test("loads confirmed employee totals for the selected date range", async () => {
  render(<CostRatesCosting />);
  expect(await screen.findByText("Rahul")).toBeInTheDocument();
  expect(screen.getByText("rahul@mydgv.com")).toBeInTheDocument();
  expect(screen.getByText("$10.00")).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Task" })).not.toBeInTheDocument();
  const month = rangeFor("1m");
  expect(fetchCostingRoster).toHaveBeenCalledWith(month);

  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "3m" } });
  await waitFor(() => {
    expect(fetchCostingRoster).toHaveBeenLastCalledWith(rangeFor("3m"));
  });

  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2020-01-01" } });
  expect(await screen.findByText("No confirmed costs in this date range.")).toBeInTheDocument();
  expect(fetchCostingRoster).toHaveBeenLastCalledWith(
    expect.objectContaining({ from: "2020-01-01" })
  );
  expect(screen.queryByText("Rahul")).not.toBeInTheDocument();
});

test("opens and closes the project cost breakdown", async () => {
  render(<CostRatesCosting />);
  expect(await screen.findByText("Rahul")).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "View project details" })
  );
  expect(await screen.findByRole("dialog", { name: "Rahul" })).toBeInTheDocument();
  expect(screen.getByText("Portal")).toBeInTheDocument();
  expect(screen.getByText("$6.00")).toBeInTheDocument();
  expect(screen.getByText("Site")).toBeInTheDocument();
  expect(screen.getByText("$4.00")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("Portal")).not.toBeInTheDocument();

  await userEvent.click(
    screen.getByRole("button", { name: "View project details" })
  );
  expect(await screen.findByRole("dialog", { name: "Rahul" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("shows an empty project breakdown when the employee has no project costs", async () => {
  fetchCostingRoster.mockResolvedValue({
    range: { from: "2026-01-01", to: "2026-01-31" },
    truncated: false,
    employees: [{ ...RAHUL, projects: [] }],
  });
  render(<CostRatesCosting />);
  expect(await screen.findByText("Rahul")).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "View project details" })
  );
  expect(
    await screen.findByText("No project costs in this date range.")
  ).toBeInTheDocument();
});

function rangeFor(preset) {
  const to = companyDateKey();
  if (preset === "3m") return { from: addDaysToKey(to, -89), to };
  return { from: addDaysToKey(to, -29), to };
}

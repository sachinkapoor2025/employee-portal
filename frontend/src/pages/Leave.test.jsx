jest.mock("../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../services/api", () => ({
  fetchMyLeave: jest.fn(),
  applyLeave: jest.fn(),
  cancelLeave: jest.fn(),
  fetchWeekOffState: jest.fn(),
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Leave from "./Leave";
import { fetchMyLeave, applyLeave, fetchWeekOffState } from "../services/api";

const AVAILABLE = {
  weekStart: "2026-09-28",
  weekEnd: "2026-10-04",
  weekOffEntitlement: 1,
  weekOffUsed: 0,
  weekOffAvailable: 1,
  leaveUsed: 0,
  balance: 1,
};

const USED = {
  ...AVAILABLE,
  weekOffUsed: 1,
  weekOffAvailable: 0,
  balance: 0,
};

beforeEach(() => {
  fetchMyLeave.mockResolvedValue([]);
  fetchWeekOffState.mockResolvedValue(AVAILABLE);
  applyLeave.mockReset();
});

test("Week Off still sends PLANNED_OFF to the existing API", async () => {
  applyLeave.mockResolvedValue({ leaveId: "wo-1", status: "PLANNED_OFF" });
  render(<Leave />);
  expect(await screen.findByTestId("week-off-state")).toHaveTextContent(
    "Week Off: Available"
  );

  await userEvent.click(screen.getByText("WEEK OFF"));
  const date = document.querySelector('input[type="date"]');
  fireEvent.change(date, { target: { value: "2099-12-31" } });
  await userEvent.click(screen.getByRole("button", { name: "Submit Week Off" }));

  await waitFor(() => {
    expect(applyLeave).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PLANNED_OFF",
        type: "PLANNED_OFF",
        fromDate: "2099-12-31",
        toDate: "2099-12-31",
        startDate: "2099-12-31",
        endDate: "2099-12-31",
      })
    );
  });
});

test("current Monday-Sunday range and available Week Off are displayed", async () => {
  render(<Leave />);
  const state = await screen.findByTestId("week-off-state");
  expect(state).toHaveTextContent("This week: 28 Sept – 04 Oct");
  expect(state).toHaveTextContent("Week Off: Available");
  expect(state).toHaveTextContent("1 day available");
});

test("used Week Off disables the action", async () => {
  fetchWeekOffState.mockResolvedValue(USED);
  render(<Leave />);
  const state = await screen.findByTestId("week-off-state");
  expect(state).toHaveTextContent("Week Off: Used");
  expect(state).toHaveTextContent(
    "You have already used your Week Off for this week."
  );
  expect(screen.getByRole("button", { name: /WEEK OFF/i })).toBeDisabled();
});

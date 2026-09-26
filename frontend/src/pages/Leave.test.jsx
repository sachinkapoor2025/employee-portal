jest.mock("../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../services/api", () => ({
  fetchMyLeave: jest.fn(),
  applyLeave: jest.fn(),
  cancelLeave: jest.fn(),
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Leave from "./Leave";
import { fetchMyLeave, applyLeave } from "../services/api";

test("Week Off still sends PLANNED_OFF to the existing API", async () => {
  fetchMyLeave.mockResolvedValue([]);
  applyLeave.mockResolvedValue({ leaveId: "wo-1", status: "PLANNED_OFF" });
  render(<Leave />);
  await waitFor(() => expect(fetchMyLeave).toHaveBeenCalled());

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

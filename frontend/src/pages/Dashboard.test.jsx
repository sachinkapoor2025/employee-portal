jest.mock("../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock(
  "react-router-dom",
  () => ({
    useNavigate: () => jest.fn(),
  }),
  { virtual: true }
);

jest.mock("../services/api", () => ({
  fetchAnnouncements: jest.fn(),
  fetchTasks: jest.fn(),
  fetchWeekOffState: jest.fn(),
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import Dashboard from "./Dashboard";
import {
  fetchAnnouncements,
  fetchTasks,
  fetchWeekOffState,
} from "../services/api";

function cardValue(label) {
  const labelEl = screen.getByText(label);
  const card = labelEl.closest(".dgv-stat-card");
  return within(card).getByText((_, node) =>
    node?.classList?.contains("dgv-stat-card__value")
  ).textContent;
}

beforeEach(() => {
  fetchAnnouncements.mockResolvedValue([]);
  fetchTasks.mockResolvedValue([]);
  fetchWeekOffState.mockResolvedValue({
    weekStart: "2026-09-28",
    weekEnd: "2026-10-04",
    weekOffEntitlement: 1,
    weekOffUsed: 0,
    weekOffAvailable: 1,
    leaveUsed: 0,
    balance: 1,
  });
});

test("dashboard shows current Week Off available state", async () => {
  render(<Dashboard />);
  expect(await screen.findByText("This week · Available")).toBeInTheDocument();
  expect(cardValue("Week Off")).toBe("1");
  expect(screen.getByText("Open Tasks")).toBeInTheDocument();
  expect(cardValue("Open Tasks")).toBe("0");
  expect(screen.queryByText("Pending Leave")).not.toBeInTheDocument();
});

test("dashboard shows current Week Off used state", async () => {
  fetchWeekOffState.mockResolvedValue({
    weekStart: "2026-09-28",
    weekEnd: "2026-10-04",
    weekOffEntitlement: 1,
    weekOffUsed: 1,
    weekOffAvailable: 0,
    leaveUsed: 0,
    balance: 0,
  });
  render(<Dashboard />);
  await waitFor(() => expect(screen.getByText("This week · Used")).toBeInTheDocument());
  expect(cardValue("Week Off")).toBe("0");
  expect(screen.getByText("Open Tasks")).toBeInTheDocument();
  expect(cardValue("Open Tasks")).toBe("0");
  expect(screen.queryByText("Pending Leave")).not.toBeInTheDocument();
});

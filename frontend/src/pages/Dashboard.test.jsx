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
  getLoggedInDisplayName: jest.fn(() => "Nitin"),
  getLoggedInEmail: jest.fn(() => "nitin@mydgv.com"),
}));

jest.mock("../services/api", () => ({
  fetchAttendance: jest.fn(),
  fetchEmployeeShift: jest.fn(),
  fetchTasks: jest.fn(),
  fetchUserProfile: jest.fn(),
  fetchWeekOffState: jest.fn(),
}));

import { readFileSync } from "fs";
import path from "path";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard from "./Dashboard";
import { getLoggedInDisplayName, getLoggedInEmail } from "../services/auth";
import {
  fetchAttendance,
  fetchEmployeeShift,
  fetchTasks,
  fetchUserProfile,
  fetchWeekOffState,
} from "../services/api";

const NOW = Date.parse("2026-11-02T08:00:00+05:30");

function task(id, assignedAt) {
  return {
    taskId: id,
    title: id,
    status: "TODO",
    createdAt: "2026-11-02T08:00:00+05:30",
    dueDate: "2026-11-02",
    myAssignment: {
      status: "TODO",
      zone: "GREEN",
      ...(assignedAt ? { assignedAt } : {}),
    },
  };
}

function statValue(label) {
  const button = screen.getByRole("button", { name: new RegExp(label) });
  return button.querySelector("strong").textContent;
}

beforeEach(() => {
  mockNavigate.mockReset();
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  fetchTasks.mockReset();
  fetchTasks.mockResolvedValue([]);
  fetchAttendance.mockReset();
  fetchAttendance.mockResolvedValue([]);
  fetchEmployeeShift.mockReset();
  fetchEmployeeShift.mockResolvedValue({ shift: null });
  getLoggedInDisplayName.mockReset();
  getLoggedInDisplayName.mockReturnValue("Nitin");
  getLoggedInEmail.mockReset();
  getLoggedInEmail.mockReturnValue("nitin@mydgv.com");
  fetchUserProfile.mockReset();
  fetchUserProfile.mockResolvedValue({ name: "Nitin Sharma" });
  fetchWeekOffState.mockReset();
  fetchWeekOffState.mockResolvedValue({
    weekStart: "2026-11-02",
    weekEnd: "2026-11-08",
    weekOffEntitlement: 1,
    weekOffUsed: 0,
    weekOffAvailable: 1,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("week and day counts follow assignment date across Monday and Sunday boundaries", async () => {
  fetchTasks.mockResolvedValue([
    task("monday-start", "2026-11-01T18:30:00.000Z"),
    task("sunday-before", "2026-11-01T18:29:59.999Z"),
    task("tuesday", "2026-11-02T18:30:00.000Z"),
    task("sunday-end", "2026-11-08T18:29:59.999Z"),
    task("next-monday", "2026-11-08T18:30:00.000Z"),
    task("missing-date"),
  ]);
  render(<Dashboard />);
  await waitFor(() => expect(statValue("Tasks This Week")).toBe("3"));
  expect(statValue("Assigned Today")).toBe("1");
  expect(screen.getByRole("heading", { name: "Good morning, Nitin" })).toBeInTheDocument();
  expect(screen.getAllByText("Mon, 02 Nov – Sun, 08 Nov 2026").length).toBe(2);
  expect(screen.getByText(/Today, Mon, 02 Nov 2026/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "This Week Overview" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Attendance Today" })).toBeInTheDocument();
  expect(screen.queryByText("monday-start")).not.toBeInTheDocument();
  expect(screen.queryByText(/requiring action|in review|Red Zone/i)).not.toBeInTheDocument();
});

test("the greeting uses the saved profile name when the session has none", async () => {
  getLoggedInDisplayName.mockReturnValue("");
  render(<Dashboard />);
  expect(await screen.findByRole("heading", { name: "Good morning, Nitin Sharma" })).toBeInTheDocument();
  expect(fetchUserProfile).toHaveBeenCalledWith("nitin@mydgv.com");
});

test("weekly day off shows one remaining until it is used", async () => {
  render(<Dashboard />);
  await waitFor(() => expect(statValue("Weekly Day Off")).toBe("1 remaining"));
  expect(screen.getByText("Not taken yet")).toBeInTheDocument();
  expect(screen.getByText("1 day off per week (Monday – Sunday)")).toBeInTheDocument();
});

test("weekly day off shows zero remaining after it is used", async () => {
  fetchWeekOffState.mockResolvedValue({
    weekStart: "2026-11-02",
    weekEnd: "2026-11-08",
    weekOffEntitlement: 1,
    weekOffUsed: 1,
    weekOffAvailable: 0,
  });
  render(<Dashboard />);
  await waitFor(() => expect(statValue("Weekly Day Off")).toBe("0 remaining"));
  expect(screen.getByText("Used")).toBeInTheDocument();
});

test("attendance shows on time, late, check-in, and shift only from recorded data", async () => {
  fetchAttendance.mockResolvedValue([
    {
      date: "2026-11-02",
      status: "Working",
      sessionStatus: "Present",
      timingStatus: "LATE",
      shiftName: "Morning",
      expectedStartTime: "2026-11-02T11:00:00+05:30",
      expectedEndTime: "2026-11-02T20:00:00+05:30",
      actualCheckInTime: "2026-11-02T11:02:00+05:30",
      attendanceSubmittedAt: "2026-11-02T11:02:00+05:30",
    },
  ]);
  const { unmount } = render(<Dashboard />);
  const late = await screen.findByRole("group", { name: "Today's attendance" });
  expect(late).toHaveClass("is-late");
  expect(late.querySelector(".dgv-home__status svg")).toBeInTheDocument();
  expect(screen.getByText("Late")).toBeInTheDocument();
  expect(screen.getByText("Checked in at")).toBeInTheDocument();
  expect(screen.getByText("11:02 AM")).toBeInTheDocument();
  expect(screen.getByText(/Shift: Morning/)).toBeInTheDocument();
  expect(document.querySelector(".dgv-home__panel--attendance header")).toBeInTheDocument();

  unmount();
  fetchAttendance.mockResolvedValue([
    {
      date: "2026-11-02",
      status: "Working",
      sessionStatus: "Present",
      timingStatus: "WITHIN_GRACE",
      shiftName: "Morning",
      expectedStartTime: "2026-11-02T11:00:00+05:30",
      expectedEndTime: "2026-11-02T20:00:00+05:30",
      actualCheckInTime: "2026-11-02T10:55:00+05:30",
      attendanceSubmittedAt: "2026-11-02T10:55:00+05:30",
    },
  ]);
  render(<Dashboard />);
  const onTime = await screen.findByRole("group", { name: "Today's attendance" });
  expect(onTime).toHaveClass("is-ontime");
  expect(onTime.querySelector(".dgv-home__status svg")).toBeInTheDocument();
  expect(screen.getByText("On Time")).toBeInTheDocument();
  expect(screen.getByText("Checked in at")).toBeInTheDocument();
  expect(screen.getByText("10:55 AM")).toBeInTheDocument();
  expect(screen.queryByText("11:02 AM")).not.toBeInTheDocument();
});

test("the attendance row stacks on a narrow screen", () => {
  const css = readFileSync(path.join(__dirname, "../styles/design-system.css"), "utf8");
  expect(css).toMatch(
    /@media \(max-width: 639px\)\s*\{[\s\S]*\.dgv-home__attendance\s*\{[^}]*flex-direction:\s*column/
  );
});

test("attendance stays neutral when nothing is recorded and reports a load failure", async () => {
  render(<Dashboard />);
  expect(await screen.findByText("Not recorded yet")).toBeInTheDocument();
  expect(screen.queryByText(/Checked in at/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Shift:/)).not.toBeInTheDocument();
});

test("a failed attendance load is not shown as not recorded", async () => {
  fetchAttendance.mockRejectedValue(new Error("offline"));
  render(<Dashboard />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load attendance.");
  expect(screen.queryByText("Not recorded yet")).not.toBeInTheDocument();
});

test("summary cards open My Tasks and Attendance", async () => {
  render(<Dashboard />);
  await userEvent.click(await screen.findByRole("button", { name: /Tasks This Week/ }));
  await userEvent.click(screen.getByRole("button", { name: /Assigned Today/ }));
  await userEvent.click(screen.getByRole("button", { name: /Weekly Day Off/ }));
  expect(mockNavigate).toHaveBeenNthCalledWith(1, "/work");
  expect(mockNavigate).toHaveBeenNthCalledWith(2, "/work");
  expect(mockNavigate).toHaveBeenNthCalledWith(3, "/attendance");
});

test("an older dashboard response does not replace a newer assignment count", async () => {
  jest.useFakeTimers({ now: NOW });
  try {
    const pending = [];
    fetchTasks.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        })
    );
    render(<Dashboard />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(60000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(pending.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      pending[1]([task("new", "2026-11-02T08:00:00+05:30")]);
      await Promise.resolve();
    });
    expect(statValue("Tasks This Week")).toBe("1");
    await act(async () => {
      pending[0]([
        task("old", "2026-11-02T08:00:00+05:30"),
        task("older", "2026-11-03T08:00:00+05:30"),
      ]);
      await Promise.resolve();
    });
    expect(statValue("Tasks This Week")).toBe("1");
    expect(screen.queryByText("old")).not.toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});

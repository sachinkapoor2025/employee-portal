jest.mock("./AmbientBackground", () => () => null);
jest.mock("./Footer", () => () => null);
jest.mock("../theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: "light", toggleTheme: jest.fn() }),
}));

jest.mock("../services/auth", () => ({
  logout: jest.fn(),
  canAccessAdmin: () => false,
  switchPortalView: jest.fn(),
  getViewRole: () => "USER",
  getLoggedInEmail: () => "worker@mydgv.com",
}));

jest.mock(
  "react-router-dom",
  () => ({
    useNavigate: () => jest.fn(),
    useLocation: () => ({ pathname: "/" }),
  }),
  { virtual: true }
);

jest.mock("../services/api", () => ({
  fetchLeaveNotifications: jest.fn(),
  markNotificationRead: jest.fn(),
  markAllNotificationsRead: jest.fn(),
  fetchDocumentNotificationFeed: jest.fn(),
  markDocumentNotificationsSeen: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Layout from "./Layout";
import {
  fetchLeaveNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  fetchDocumentNotificationFeed,
  markDocumentNotificationsSeen,
} from "../services/api";

const UNREAD = [
  {
    SK: "NOTIFY#1",
    notifyId: "n1",
    title: "Leave submitted",
    message: "Please review",
    read: false,
    createdAt: "2026-09-29T00:00:00.000Z",
  },
  {
    SK: "NOTIFY#2",
    notifyId: "n2",
    title: "Task assigned",
    message: "New task",
    read: false,
    createdAt: "2026-09-28T00:00:00.000Z",
  },
];

function renderLayout() {
  return render(<Layout>page</Layout>);
}

async function waitForLoaded() {
  await waitFor(() => expect(fetchLeaveNotifications).toHaveBeenCalled());
}

async function openBell() {
  await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
  await screen.findByRole("menu", { name: "Notifications" });
}

beforeEach(() => {
  fetchLeaveNotifications.mockResolvedValue(UNREAD);
  markNotificationRead.mockResolvedValue({ read: true });
  markAllNotificationsRead.mockResolvedValue({ ok: true, updated: 2 });
  fetchDocumentNotificationFeed.mockResolvedValue({
    events: [
      {
        eventId: "doc-1",
        timestamp: "2026-09-29T12:00:00.000Z",
        projectName: "Files",
        fileCount: 1,
      },
    ],
    unreadCount: 4,
    lastSeenAt: null,
  });
  markDocumentNotificationsSeen.mockResolvedValue({ ok: true });
});

test("Mark all as read appears when unread in-app notifications exist", async () => {
  renderLayout();
  await waitForLoaded();
  await openBell();
  expect(screen.getByRole("button", { name: "Mark all as read" })).toBeInTheDocument();
});

test("Mark all as read is hidden when in-app unread count is 0", async () => {
  fetchLeaveNotifications.mockResolvedValue(
    UNREAD.map((row) => ({ ...row, read: true }))
  );
  renderLayout();
  await waitForLoaded();
  await openBell();
  expect(screen.getByText("Leave submitted")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Mark all as read" })).not.toBeInTheDocument();
});

test("successful mark-all makes loaded in-app notifications read and zeros in-app unread", async () => {
  renderLayout();
  await waitForLoaded();
  const bell = screen.getByRole("button", { name: "Notifications" });
  await waitFor(() => expect(bell).toHaveTextContent("6"));
  await openBell();
  await waitFor(() => expect(bell).toHaveTextContent("2"));
  await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
  await waitFor(() =>
    expect(markAllNotificationsRead).toHaveBeenCalledTimes(1)
  );
  expect(markAllNotificationsRead).toHaveBeenCalledWith();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Mark all as read" })).not.toBeInTheDocument()
  );
  expect(screen.getByRole("menu", { name: "Notifications" })).toBeInTheDocument();
  expect(bell).not.toHaveTextContent("2");
  expect(screen.getByText("Leave submitted").closest("button")).not.toHaveClass("is-unread");
});

test("mark-all does not call document notification APIs", async () => {
  renderLayout();
  await waitForLoaded();
  await openBell();
  const feedCalls = fetchDocumentNotificationFeed.mock.calls.length;
  const seenCalls = markDocumentNotificationsSeen.mock.calls.length;
  await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
  await waitFor(() => expect(markAllNotificationsRead).toHaveBeenCalled());
  expect(fetchDocumentNotificationFeed.mock.calls.length).toBe(feedCalls);
  expect(markDocumentNotificationsSeen.mock.calls.length).toBe(seenCalls);
});

test("failed mark-all preserves unread state", async () => {
  markAllNotificationsRead.mockRejectedValue(new Error("network"));
  renderLayout();
  await waitForLoaded();
  await openBell();
  await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
  await waitFor(() => expect(markAllNotificationsRead).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Mark all as read" })).toBeInTheDocument();
  expect(screen.getByText("Leave submitted").closest("button")).toHaveClass("is-unread");
});

test("existing individual mark-read still works", async () => {
  renderLayout();
  await waitForLoaded();
  await openBell();
  await userEvent.click(screen.getByText("Leave submitted"));
  await waitFor(() =>
    expect(markNotificationRead).toHaveBeenCalledWith("NOTIFY#1")
  );
});

test("duplicate mark-all clicks while in flight are ignored", async () => {
  let resolveMark;
  markAllNotificationsRead.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveMark = resolve;
      })
  );
  renderLayout();
  await waitForLoaded();
  await openBell();
  const btn = screen.getByRole("button", { name: "Mark all as read" });
  await userEvent.click(btn);
  await userEvent.click(btn);
  expect(markAllNotificationsRead).toHaveBeenCalledTimes(1);
  resolveMark({ ok: true, updated: 2 });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Mark all as read" })).not.toBeInTheDocument()
  );
});

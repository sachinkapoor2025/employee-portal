jest.mock("./AmbientBackground", () => () => null);
jest.mock("./Footer", () => () => null);
jest.mock("../theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: "light", toggleTheme: jest.fn() }),
}));

jest.mock("../services/auth", () => ({
  logout: jest.fn(),
  canAccessAdmin: () => true,
  switchPortalView: jest.fn(),
  getViewRole: () => "ADMIN",
  getLoggedInEmail: () => "boss@mydgv.com",
  PORTAL_ROLE_KEY: "portalRole",
}));

jest.mock(
  "react-router-dom",
  () => ({
    useNavigate: () => jest.fn(),
    useLocation: () => ({ pathname: "/admin/employees" }),
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
import Layout from "./Layout";
import {
  fetchLeaveNotifications,
  fetchDocumentNotificationFeed,
} from "../services/api";

beforeEach(() => {
  localStorage.clear();
  fetchLeaveNotifications.mockResolvedValue([]);
  fetchDocumentNotificationFeed.mockResolvedValue({
    events: [],
    unreadCount: 0,
    lastSeenAt: null,
  });
});

test("Super Admin sees Cost Rates under People", async () => {
  localStorage.setItem("portalRole", "SUPER_ADMIN");
  render(<Layout>page</Layout>);
  await waitFor(() => expect(fetchLeaveNotifications).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Cost Rates" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Employees" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Shifts" })).toBeInTheDocument();
});

test("Admin does not see Cost Rates", async () => {
  localStorage.setItem("portalRole", "ADMIN");
  render(<Layout>page</Layout>);
  await waitFor(() => expect(fetchLeaveNotifications).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Cost Rates" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Employees" })).toBeInTheDocument();
});

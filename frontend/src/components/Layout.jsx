import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  CalendarCheck,
  GraduationCap,
  ListTodo,
  CalendarDays,
  Package,
  User,
  TrendingUp,
  Wallet,
  LogOut,
  DoorOpen,
  Users,
  Activity,
  Megaphone,
  FileWarning,
  Menu,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Bell,
  Sun,
  Moon,
  ChevronRight,
} from "lucide-react";
import {
  logout,
  canAccessAdmin,
  switchPortalView,
  getViewRole,
  getLoggedInEmail,
} from "../services/auth";
import { useTheme } from "../theme/ThemeProvider";
import AmbientBackground from "./AmbientBackground";
import Footer from "./Footer";

const EMPLOYEE_NAV = [
  { label: "Dashboard", path: "/", icon: LayoutDashboard },
  { label: "Attendance", path: "/attendance", icon: CalendarCheck },
  { label: "Training", path: "/training", icon: GraduationCap },
  { label: "My Tasks", path: "/work", icon: ListTodo },
  { label: "Leave", path: "/leave", icon: CalendarDays },
  { label: "Software Center", path: "/software-center", icon: Package },
  { label: "Profile", path: "/profile", icon: User },
  { label: "Performance", path: "/performance", icon: TrendingUp },
  { label: "Payroll", path: "/payroll", icon: Wallet },
  { label: "Exit", path: "/exit", icon: DoorOpen },
];

const ADMIN_NAV = [
  { label: "Dashboard", path: "/admin/dashboard", icon: LayoutDashboard },
  { label: "Users", path: "/admin/users", icon: Users },
  { label: "Tasks", path: "/admin/tasks", icon: ListTodo },
  { label: "Activity", path: "/admin/activity", icon: Activity },
  { label: "Leave", path: "/admin/leave", icon: CalendarDays },
  { label: "Announce", path: "/admin/announcements", icon: Megaphone },
  { label: "Training", path: "/admin/add-training", icon: GraduationCap },
  { label: "Software Center", path: "/software-center", icon: Package },
  { label: "Resignations", path: "/admin/resignations", icon: FileWarning },
];

function isActivePath(pathname, path) {
  if (path === "/") return pathname === "/";
  return pathname === path || pathname.startsWith(`${path}/`);
}

function initialsFromEmail(email) {
  if (!email) return "DG";
  const local = email.split("@")[0] || "DG";
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

export default function Layout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const [viewRole, setViewRole] = useState(getViewRole());
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= 960 : false
  );
  const [search, setSearch] = useState("");

  const isAdminAccount = canAccessAdmin();
  const showEmployeeNav = viewRole === "USER" || !isAdminAccount;
  const navItems = showEmployeeNav ? EMPLOYEE_NAV : ADMIN_NAV;
  const email = getLoggedInEmail();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth <= 960;
      setIsMobile(mobile);
      if (!mobile) setMobileOpen(false);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handleSwitch = (view) => {
    if (!switchPortalView(view)) return;
    const nextRole = view === "admin" ? "ADMIN" : "USER";
    setViewRole(nextRole);
    navigate(nextRole === "ADMIN" ? "/admin/dashboard" : "/");
  };

  const go = (path) => {
    navigate(path);
    setMobileOpen(false);
  };

  const shellClass = [
    "dgv-shell",
    collapsed ? "sidebar-collapsed" : "",
    mobileOpen ? "sidebar-mobile-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClass}>
      <AmbientBackground />

      <div
        className="dgv-sidebar-backdrop"
        onClick={() => setMobileOpen(false)}
        aria-hidden={!mobileOpen}
      />

      <aside className="dgv-sidebar" aria-label="Main navigation">
        <div className="dgv-sidebar__brand">
          <div className="dgv-sidebar__logo" aria-hidden="true">
            DGV
          </div>
          <div>
            <div className="dgv-sidebar__title">DGV Portal</div>
            <div className="dgv-sidebar__subtitle">Employee workspace</div>
          </div>
        </div>

        <nav className="dgv-sidebar__nav">
          <div className="dgv-sidebar__section">
            {showEmployeeNav ? "Employee" : "Admin"}
          </div>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActivePath(location.pathname, item.path);
            return (
              <button
                key={item.path + item.label}
                type="button"
                className={`dgv-nav-item ${active ? "is-active" : ""}`}
                onClick={() => go(item.path)}
                aria-current={active ? "page" : undefined}
                title={item.label}
              >
                <span className="dgv-nav-item__icon">
                  <Icon size={18} strokeWidth={2} />
                </span>
                <span className="dgv-nav-item__label">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="dgv-sidebar__footer">
          <button
            type="button"
            className="dgv-nav-item"
            onClick={logout}
            title="Logout"
          >
            <span className="dgv-nav-item__icon">
              <LogOut size={18} strokeWidth={2} />
            </span>
            <span className="dgv-nav-item__label">Logout</span>
          </button>
        </div>
      </aside>

      <div className="dgv-main-wrap">
        <header className="dgv-navbar">
          <button
            type="button"
            className="dgv-icon-btn"
            aria-label={
              isMobile
                ? mobileOpen
                  ? "Close menu"
                  : "Open menu"
                : collapsed
                  ? "Expand sidebar"
                  : "Collapse sidebar"
            }
            onClick={() => {
              if (isMobile) setMobileOpen((v) => !v);
              else setCollapsed((v) => !v);
            }}
          >
            {isMobile ? (
              mobileOpen ? <X size={18} /> : <Menu size={18} />
            ) : collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </button>

          {isAdminAccount && (
            <div className="dgv-portal-toggle" role="group" aria-label="Portal view">
              <button
                type="button"
                className={viewRole === "USER" ? "is-active" : ""}
                onClick={() => handleSwitch("employee")}
              >
                Employee
              </button>
              <button
                type="button"
                className={viewRole === "ADMIN" ? "is-active" : ""}
                onClick={() => handleSwitch("admin")}
              >
                Admin
              </button>
            </div>
          )}

          <label className="dgv-navbar__search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              placeholder="Search pages..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !search.trim()) return;
                const q = search.trim().toLowerCase();
                const match = navItems.find(
                  (n) =>
                    n.label.toLowerCase().includes(q) ||
                    n.path.toLowerCase().includes(q)
                );
                if (match) {
                  go(match.path);
                  setSearch("");
                }
              }}
              aria-label="Search pages"
            />
          </label>

          <div className="dgv-navbar__actions">
            <button
              type="button"
              className="dgv-icon-btn"
              aria-label="Notifications"
              title="Notifications"
            >
              <Bell size={18} />
            </button>

            <button
              type="button"
              className="dgv-icon-btn"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title="Toggle theme"
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            <button
              type="button"
              className="dgv-avatar"
              title={email || "Profile"}
              aria-label="Open profile"
              onClick={() => go("/profile")}
            >
              {initialsFromEmail(email)}
            </button>
          </div>
        </header>

        <main className="dgv-content">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 14,
              fontSize: 12,
              color: "var(--dgv-text-muted)",
              fontWeight: 500,
            }}
          >
            <span>Portal</span>
            <ChevronRight size={12} />
            <span style={{ color: "var(--dgv-text-secondary)" }}>
              {navItems.find((n) => isActivePath(location.pathname, n.path))?.label ||
                "Workspace"}
            </span>
          </div>
          {children}
        </main>

        <Footer />
      </div>
    </div>
  );
}

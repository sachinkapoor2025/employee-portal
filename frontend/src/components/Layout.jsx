import { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
  ClipboardList,
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
  FileText,
  Video,
  Settings,
} from "lucide-react";
import {
  logout,
  canAccessAdmin,
  switchPortalView,
  getViewRole,
  getLoggedInEmail,
} from "../services/auth";
import { fetchLeaveNotifications, markNotificationRead, fetchDocumentNotificationFeed, markDocumentNotificationsSeen } from "../services/api";
import {
  isZoneNotification,
  isRedZoneNotification,
  notificationTaskPath,
  notificationDocumentPath,
  relativeTime,
  unreadCount,
  isDocumentEventUnread,
  documentEventTitle,
  documentEventBody,
} from "../utils/notifications";
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
  { label: "Documents", path: "/documents", icon: FileText },
  { label: "Meetings", path: "/meetings", icon: Video },
  { label: "Performance", path: "/performance", icon: TrendingUp },
  { label: "Payroll", path: "/payroll", icon: Wallet },
  { label: "Exit", path: "/exit", icon: DoorOpen },
];

/** Grouped Admin IA — existing features wired; new modules use coming-soon routes */
const ADMIN_NAV_SECTIONS = [
  {
    title: "Overview",
    items: [
      { label: "Dashboard", path: "/admin/dashboard", icon: LayoutDashboard },
    ],
  },
  {
    title: "People",
    items: [{ label: "Employees", path: "/admin/employees", icon: Users }],
  },
  {
    title: "Work Management",
    items: [
      { label: "Tasks", path: "/admin/tasks", icon: ListTodo },
      {
        label: "Attendance",
        path: "/admin/attendance-activity",
        icon: ClipboardList,
      },
      { label: "Leave", path: "/admin/leave", icon: CalendarDays },
    ],
  },
  {
    title: "Company",
    items: [
      { label: "Documents", path: "/admin/documents", icon: FileText },
      { label: "Announcements", path: "/admin/announcements", icon: Megaphone },
      { label: "Training", path: "/admin/add-training", icon: GraduationCap },
      { label: "Meetings", path: "/admin/meetings", icon: Video },
      { label: "Software Center", path: "/software-center", icon: Package },
    ],
  },
  {
    title: "Administration",
    items: [
      { label: "Activity", path: "/admin/activity", icon: Activity },
      { label: "Resignations", path: "/admin/resignations", icon: FileWarning },
      { label: "Settings", path: "/admin/settings", icon: Settings },
    ],
  },
];

const ADMIN_NAV_FLAT = ADMIN_NAV_SECTIONS.flatMap((s) => s.items);

function isActivePath(pathname, path) {
  if (path === "/") return pathname === "/";
  if (path === "/admin/employees") {
    return (
      pathname === "/admin/employees" ||
      pathname === "/admin/users" ||
      pathname.startsWith("/admin/employees/")
    );
  }
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
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [docEvents, setDocEvents] = useState([]);
  const [docUnread, setDocUnread] = useState(0);
  const [docLastSeenAt, setDocLastSeenAt] = useState(null);
  const notifyWrapRef = useRef(null);

  const isAdminAccount = canAccessAdmin();
  const showEmployeeNav = viewRole === "USER" || !isAdminAccount;
  const navItems = showEmployeeNav ? EMPLOYEE_NAV : ADMIN_NAV_FLAT;
  const email = getLoggedInEmail();

  useEffect(() => {
    setMobileOpen(false);
    setNotifyOpen(false);
  }, [location.pathname]);

  const loadNotifications = useCallback(() => {
    fetchLeaveNotifications()
      .then((items) =>
        setNotifications(
          Array.isArray(items)
            ? items.filter((n) => n.notifyId || n.title)
            : []
        )
      )
      .catch(() => setNotifications([]));
  }, []);

  const applyDocFeed = useCallback((feed, { preserveSeen = false } = {}) => {
    const events = Array.isArray(feed?.events) ? feed.events : [];
    setDocEvents(events);
    if (preserveSeen) return;
    if (feed?.lastSeenAt) setDocLastSeenAt(feed.lastSeenAt);
    setDocUnread(
      Number.isFinite(Number(feed?.unreadCount)) ? Number(feed.unreadCount) : 0
    );
  }, []);

  const loadDocFeed = useCallback(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    fetchDocumentNotificationFeed()
      .then(applyDocFeed)
      .catch(() => {});
  }, [applyDocFeed]);

  useEffect(() => {
    loadNotifications();
    const timer = setInterval(loadNotifications, 60000);
    return () => clearInterval(timer);
  }, [loadNotifications, location.pathname]);

  useEffect(() => {
    loadDocFeed();
    const timer = setInterval(loadDocFeed, 10000);
    const onVis = () => {
      if (document.visibilityState === "visible") loadDocFeed();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", loadDocFeed);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", loadDocFeed);
    };
  }, [loadDocFeed]);

  useEffect(() => {
    if (!notifyOpen) return undefined;
    const onPointerDown = (e) => {
      if (!notifyWrapRef.current?.contains(e.target)) {
        setNotifyOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [notifyOpen]);

  const toggleNotify = async () => {
    const next = !notifyOpen;
    setNotifyOpen(next);
    if (!next) return;
    const iso = new Date().toISOString();
    setDocLastSeenAt(iso);
    setDocUnread(0);
    try {
      const feed = await fetchDocumentNotificationFeed();
      applyDocFeed(feed, { preserveSeen: true });
      setDocLastSeenAt(iso);
      setDocUnread(0);
      await markDocumentNotificationsSeen(iso);
    } catch {
      /* keep the panel open even if mark-seen is unavailable */
    }
  };

  const openNotification = async (item) => {
    if (item?.kind === "document") {
      setNotifyOpen(false);
      navigate(notificationDocumentPath(showEmployeeNav));
      return;
    }
    if (item?.SK && item.read !== true) {
      try {
        await markNotificationRead(item.SK);
        setNotifications((prev) =>
          prev.map((n) =>
            n.SK === item.SK
              ? { ...n, read: true, readAt: new Date().toISOString() }
              : n
          )
        );
      } catch {
        /* keep local navigation even if mark-read fails */
      }
    }
    const path = notificationTaskPath(item, showEmployeeNav);
    if (path) {
      setNotifyOpen(false);
      navigate(path);
    }
  };

  const notifyItems = useMemo(() => {
    const docs = (docEvents || []).map((event) => ({
      kind: "document",
      eventId: event.eventId || event.key,
      title: documentEventTitle(event),
      message: documentEventBody(event),
      createdAt: event.timestamp,
      read: !isDocumentEventUnread(event, docLastSeenAt),
      projectId: event.projectId,
    }));
    const leave = (notifications || []).map((n) => ({
      ...n,
      kind: "leave",
      createdAt: n.createdAt || n.updatedAt || n.readAt,
    }));
    return [...docs, ...leave].sort((a, b) => {
      const am = Date.parse(a.createdAt || "") || 0;
      const bm = Date.parse(b.createdAt || "") || 0;
      return bm - am;
    });
  }, [docEvents, docLastSeenAt, notifications]);

  const unread = unreadCount(notifications) + docUnread;

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
          {showEmployeeNav ? (
            <>
              <div className="dgv-sidebar__section">Employee</div>
              {EMPLOYEE_NAV.map((item) => {
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
                      <Icon size={20} strokeWidth={1.75} />
                    </span>
                    <span className="dgv-nav-item__label">{item.label}</span>
                  </button>
                );
              })}
            </>
          ) : (
            ADMIN_NAV_SECTIONS.map((section) => (
              <div key={section.title}>
                <div className="dgv-sidebar__section">{section.title}</div>
                {section.items.map((item) => {
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
                        <Icon size={20} strokeWidth={1.75} />
                      </span>
                      <span className="dgv-nav-item__label">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </nav>

        <div className="dgv-sidebar__footer">
          <button
            type="button"
            className="dgv-nav-item"
            onClick={logout}
            title="Logout"
          >
            <span className="dgv-nav-item__icon">
              <LogOut size={20} strokeWidth={1.75} />
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
              mobileOpen ? <X size={20} strokeWidth={1.75} /> : <Menu size={20} strokeWidth={1.75} />
            ) : collapsed ? (
              <PanelLeftOpen size={20} strokeWidth={1.75} />
            ) : (
              <PanelLeftClose size={20} strokeWidth={1.75} />
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
            <Search size={16} strokeWidth={1.75} aria-hidden="true" />
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
            <div style={{ position: "relative" }} ref={notifyWrapRef}>
              <button
                type="button"
                className="dgv-icon-btn"
                aria-label="Notifications"
                aria-expanded={notifyOpen}
                title="Notifications"
                onClick={toggleNotify}
              >
                <Bell size={20} strokeWidth={1.75} />
                {unread > 0 ? (
                  <span
                    style={{
                      position: "absolute",
                      top: -2,
                      right: -2,
                      minWidth: 16,
                      height: 16,
                      borderRadius: 999,
                      background: "var(--dgv-danger)",
                      color: "#fff",
                      fontSize: 10,
                      fontWeight: 700,
                      display: "grid",
                      placeItems: "center",
                      padding: "0 4px",
                    }}
                  >
                    {unread > 9 ? "9+" : unread}
                  </span>
                ) : null}
              </button>
              {notifyOpen ? (
                <div className="dgv-notify-panel" role="menu" aria-label="Notifications">
                  {notifyItems.length === 0 ? (
                    <p style={{ margin: 12, fontSize: 13, color: "var(--dgv-text-muted)" }}>
                      No notifications.
                    </p>
                  ) : (
                    notifyItems.map((n) => {
                      const isDoc = n.kind === "document";
                      const zone = !isDoc && isZoneNotification(n);
                      const red = !isDoc && isRedZoneNotification(n);
                      const unreadItem = n.read !== true;
                      const tone = isDoc ? "" : red ? "is-error" : zone ? "is-warning" : "";
                      return (
                        <button
                          type="button"
                          key={isDoc ? `doc-${n.eventId}` : n.notifyId || n.SK}
                          className={`dgv-notify-item ${unreadItem ? "is-unread" : ""} ${tone}`.trim()}
                          onClick={() => openNotification(n)}
                          style={{
                            cursor: isDoc || n.taskId || zone ? "pointer" : "default",
                          }}
                        >
                          <div className="dgv-notify-item__title">
                            {n.title || "Notification"}
                          </div>
                          <div className="dgv-notify-item__body">{n.message}</div>
                          {n.createdAt ? (
                            <div className="dgv-notify-item__time">
                              {relativeTime(n.createdAt)}
                            </div>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="dgv-icon-btn"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title="Toggle theme"
            >
              {theme === "dark" ? <Sun size={20} strokeWidth={1.75} /> : <Moon size={20} strokeWidth={1.75} />}
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
          <div className="dgv-breadcrumb">
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

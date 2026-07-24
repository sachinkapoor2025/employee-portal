import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  logout,
  canAccessAdmin,
  switchPortalView,
  getViewRole,
} from "../services/auth";
import { colors, navButton } from "../theme";
import Footer from "./Footer";

export default function Layout({ children }) {
  const navigate = useNavigate();
  const [viewRole, setViewRole] = useState(getViewRole());
  const isAdminAccount = canAccessAdmin();

  const activeBtn = { ...navButton, opacity: 1 };
  const inactiveBtn = { ...navButton, opacity: 0.55 };

  const handleSwitch = (view) => {
    if (!switchPortalView(view)) return;
    const nextRole = view === "admin" ? "ADMIN" : "USER";
    setViewRole(nextRole);
    navigate(nextRole === "ADMIN" ? "/admin/dashboard" : "/");
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: "20px 20px 0",
        fontFamily: "Arial, sans-serif",
        backgroundImage: "url('/images/dgv_bg.png')",
        backgroundSize: "cover",
        backgroundPosition: "center top",
        backgroundRepeat: "no-repeat",
        backgroundAttachment: "fixed",
      }}
    >
      <nav
        style={{
          backgroundColor: "rgba(255,255,255,0.9)",
          padding: "10px",
          borderRadius: "8px",
          marginBottom: "20px",
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        {isAdminAccount && (
          <div
            style={{
              marginBottom: 8,
              padding: "8px 12px",
              background: colors.primaryLight,
              borderRadius: 8,
              display: "inline-block",
            }}
          >
            <span style={{ marginRight: 10, fontWeight: 600, color: colors.text }}>
              Portal view:
            </span>
            <button
              style={viewRole === "USER" ? activeBtn : inactiveBtn}
              onClick={() => handleSwitch("employee")}
            >
              Employee
            </button>
            <button
              style={viewRole === "ADMIN" ? activeBtn : inactiveBtn}
              onClick={() => handleSwitch("admin")}
            >
              Admin
            </button>
          </div>
        )}

        {(viewRole === "USER" || !isAdminAccount) && (
          <>
            <button style={navButton} onClick={() => navigate("/")}>Dashboard</button>
            <button style={navButton} onClick={() => navigate("/attendance")}>Attendance</button>
            <button style={navButton} onClick={() => navigate("/training")}>Training</button>
            <button style={navButton} onClick={() => navigate("/work")}>My Tasks</button>
            <button style={navButton} onClick={() => navigate("/leave")}>Leave</button>
            <button style={navButton} onClick={() => navigate("/software-center")}>Software Center</button>
            <button style={navButton} onClick={() => navigate("/profile")}>Profile</button>
            <button style={navButton} onClick={() => navigate("/performance")}>Performance</button>
            <button style={navButton} onClick={() => navigate("/payroll")}>Payroll</button>
            <button style={navButton} onClick={() => navigate("/exit")}>Exit</button>
          </>
        )}

        {viewRole === "ADMIN" && isAdminAccount && (
          <>
            <button style={navButton} onClick={() => navigate("/admin/dashboard")}>Dashboard</button>
            <button style={navButton} onClick={() => navigate("/admin/users")}>Users</button>
            <button style={navButton} onClick={() => navigate("/admin/tasks")}>Tasks</button>
            <button style={navButton} onClick={() => navigate("/admin/activity")}>Activity</button>
            <button style={navButton} onClick={() => navigate("/admin/leave")}>Leave</button>
            <button style={navButton} onClick={() => navigate("/admin/announcements")}>Announce</button>
            <button style={navButton} onClick={() => navigate("/admin/add-training")}>Training</button>
            <button style={navButton} onClick={() => navigate("/software-center")}>Software Center</button>
            <button style={navButton} onClick={() => navigate("/admin/resignations")}>Resignations</button>
          </>
        )}

        <button style={navButton} onClick={logout}>Logout</button>
      </nav>

      <main style={{ flex: "1 0 auto", width: "100%", maxWidth: 1200, margin: "0 auto" }}>
        {children}
      </main>

      {/* Spacer clears background tagline ("Your gateway to company resources") */}
      <div style={{ flex: "1 1 180px", minHeight: 120, maxHeight: 280 }} aria-hidden="true" />

      <div style={{ flexShrink: 0, width: "100%", marginTop: "auto" }}>
        <Footer />
      </div>
    </div>
  );
}

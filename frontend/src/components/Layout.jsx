import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  logout,
  canAccessAdmin,
  switchPortalView,
  getViewRole,
} from "../services/auth";
import { colors, navButton } from "../theme";

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
    navigate(nextRole === "ADMIN" ? "/admin/users" : "/");
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "20px",
        fontFamily: "Arial, sans-serif",
        backgroundImage: "url('/images/dgv_bg.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
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
            <button style={navButton} onClick={() => navigate("/work")}>Work</button>
            <button style={navButton} onClick={() => navigate("/performance")}>Performance</button>
            <button style={navButton} onClick={() => navigate("/expertise")}>Expertise</button>
            <button style={navButton} onClick={() => navigate("/profile")}>Profile</button>
            <button style={navButton} onClick={() => navigate("/payroll")}>Payroll</button>
            <button style={navButton} onClick={() => navigate("/exit")}>Exit the Firm</button>
          </>
        )}

        {viewRole === "ADMIN" && isAdminAccount && (
          <>
            <button style={navButton} onClick={() => navigate("/admin/users")}>Manage Users</button>
            <button style={navButton} onClick={() => navigate("/admin/tasks")}>Manage Tasks</button>
            <button style={navButton} onClick={() => navigate("/admin/resignations")}>Resignations</button>
            <button style={navButton} onClick={() => navigate("/admin/add-training")}>Add Training</button>
          </>
        )}

        <button style={navButton} onClick={logout}>Logout</button>
      </nav>

      {children}
    </div>
  );
}

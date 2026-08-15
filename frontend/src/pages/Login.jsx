import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Moon, Sun, Building2 } from "lucide-react";
import { login } from "../services/auth";
import { useTheme } from "../theme/ThemeProvider";
import AmbientBackground from "../components/AmbientBackground";
import Button from "../components/ui/Button";

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { theme, toggleTheme } = useTheme();
  const adminDenied = params.get("adminDenied") === "1";
  const domainDenied = params.get("domainDenied") === "1";

  useEffect(() => {
    if (adminDenied || domainDenied) return;

    const token = localStorage.getItem("token");
    const role = localStorage.getItem("role");

    if (token && role) {
      navigate(role === "ADMIN" ? "/admin/users" : "/", { replace: true });
    } else if (token && !role) {
      navigate("/request-access", { replace: true });
    }
  }, [navigate, adminDenied, domainDenied]);

  return (
    <div className="dgv-auth-shell">
      <AmbientBackground />

      <button
        type="button"
        className="dgv-icon-btn"
        onClick={toggleTheme}
        aria-label="Toggle theme"
        style={{ position: "absolute", top: 20, right: 20, zIndex: 2 }}
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <div className="dgv-auth-card">
        <div
          style={{
            width: 52,
            height: 52,
            margin: "0 auto 16px",
            borderRadius: 14,
            display: "grid",
            placeItems: "center",
            background: "linear-gradient(135deg, var(--dgv-accent), var(--dgv-accent-2))",
            color: "#fff",
          }}
        >
          <Building2 size={26} />
        </div>

        <h1 className="dgv-page-title" style={{ fontSize: 24 }}>
          DGV Employee Portal
        </h1>
        <p className="dgv-page-subtitle" style={{ marginBottom: 8 }}>
          Sign in with your <strong>@mydgv.com</strong> account
        </p>
        <p className="dgv-page-subtitle">Choose employee or admin portal</p>

        {adminDenied && (
          <div className="dgv-alert dgv-alert--error">
            You are not in the Admin group. Sign in as Employee or contact your administrator.
          </div>
        )}

        {domainDenied && (
          <div className="dgv-alert dgv-alert--error">
            Only @mydgv.com email addresses can access this portal.
          </div>
        )}

        <Button
          variant="primary"
          onClick={() => login("employee")}
          style={{ width: "100%", marginBottom: 12, padding: "12px 28px", fontSize: 16 }}
        >
          Sign in as Employee
        </Button>

        <Button
          variant="outline"
          onClick={() => login("admin")}
          style={{ width: "100%", padding: "12px 28px", fontSize: 16 }}
        >
          Sign in as Admin
        </Button>

        <p style={{ margin: "16px 0 0", fontSize: 12, color: "var(--dgv-text-muted)" }}>
          Public sign-up is disabled. Admins create accounts from Manage Users.
        </p>
      </div>
    </div>
  );
}

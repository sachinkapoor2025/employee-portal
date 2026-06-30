import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { login } from "../services/auth";
import { colors, buttonPrimary } from "../theme";

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
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

  const btnStyle = {
    ...buttonPrimary,
    width: "100%",
    padding: "12px 28px",
    fontSize: 16,
    marginBottom: 12,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundImage: "url('/images/dgv_bg.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div
        style={{
          background: "rgba(255,255,255,0.95)",
          padding: "40px 48px",
          borderRadius: 12,
          textAlign: "center",
          boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
          minWidth: 320,
        }}
      >
        <h1 style={{ margin: "0 0 8px", color: colors.primary }}>DGV Employee Portal</h1>
        <p style={{ margin: "0 0 8px", color: colors.textMuted }}>
          Sign in with your <strong>@mydgv.com</strong> account
        </p>
        <p style={{ margin: "0 0 24px", color: colors.textMuted, fontSize: 14 }}>
          Choose employee or admin portal
        </p>

        {adminDenied && (
          <p style={{ color: colors.error, marginBottom: 16, fontSize: 14 }}>
            You are not in the Admin group. Sign in as Employee or contact your administrator.
          </p>
        )}

        {domainDenied && (
          <p style={{ color: colors.error, marginBottom: 16, fontSize: 14 }}>
            Only @mydgv.com email addresses can access this portal.
          </p>
        )}

        <button onClick={() => login("employee")} style={btnStyle}>
          Sign in as Employee
        </button>

        <button
          onClick={() => login("admin")}
          style={{ ...btnStyle, marginBottom: 0 }}
        >
          Sign in as Admin
        </button>

        <p style={{ margin: "16px 0 0", fontSize: 12, color: "#888" }}>
          Public sign-up is disabled. Admins create accounts from Manage Users.
        </p>
      </div>
    </div>
  );
}

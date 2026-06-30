import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { login } from "../services/auth";

const btnBase = {
  padding: "12px 28px",
  fontSize: 16,
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
  width: "100%",
  marginBottom: 12,
};

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const adminDenied = params.get("adminDenied") === "1";

  useEffect(() => {
    if (adminDenied) return;

    const token = localStorage.getItem("token");
    const role = localStorage.getItem("role");

    if (token && role) {
      navigate(role === "ADMIN" ? "/admin/users" : "/", { replace: true });
    } else if (token && !role) {
      navigate("/request-access", { replace: true });
    }
  }, [navigate]);

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
        <h1 style={{ margin: "0 0 8px", color: "#1976d2" }}>DGV Employee Portal</h1>
        <p style={{ margin: "0 0 24px", color: "#555" }}>
          Choose how you want to sign in
        </p>

        {adminDenied && (
          <p style={{ color: "#d32f2f", marginBottom: 16, fontSize: 14 }}>
            Your account does not have admin access. Please sign in as Employee
            or contact an administrator.
          </p>
        )}

        <button
          onClick={() => login("employee")}
          style={{ ...btnBase, background: "#1976d2", color: "#fff" }}
        >
          Sign in as Employee
        </button>

        <button
          onClick={() => login("admin")}
          style={{ ...btnBase, background: "#ff9800", color: "#fff", marginBottom: 0 }}
        >
          Sign in as Admin
        </button>

        <p style={{ margin: "16px 0 0", fontSize: 12, color: "#888" }}>
          Same company login for both. Admin access is granted by your administrator.
        </p>
      </div>
    </div>
  );
}

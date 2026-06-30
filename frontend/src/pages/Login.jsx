import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "../services/auth";

export default function Login() {
  const navigate = useNavigate();

  useEffect(() => {
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
        }}
      >
        <h1 style={{ margin: "0 0 8px", color: "#1976d2" }}>DGV Employee Portal</h1>
        <p style={{ margin: "0 0 24px", color: "#555" }}>
          Sign in with your company account
        </p>
        <button
          onClick={login}
          style={{
            padding: "12px 28px",
            fontSize: 16,
            background: "#1976d2",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Login with Company Account
        </button>
      </div>
    </div>
  );
}

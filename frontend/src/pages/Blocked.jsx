import AmbientBackground from "../components/AmbientBackground";

export default function Blocked() {
  return (
    <div className="dgv-auth-shell">
      <AmbientBackground />
      <div className="dgv-auth-card">
        <h1 className="dgv-page-title" style={{ fontSize: 24 }}>
          Account Blocked
        </h1>
        <p style={{ color: "var(--dgv-text-secondary)" }}>
          Your account has been blocked by the administrator.
        </p>
        <p style={{ color: "var(--dgv-text-muted)" }}>
          Please contact admin for further assistance.
        </p>
      </div>
    </div>
  );
}

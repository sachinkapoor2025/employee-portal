import { useEffect } from "react";
import { handleCallback } from "../services/auth";
import AmbientBackground from "../components/AmbientBackground";

export default function Callback() {
  useEffect(() => {
    handleCallback();
  }, []);

  return (
    <div className="dgv-auth-shell">
      <AmbientBackground />
      <div className="dgv-auth-card">
        <h3 className="dgv-page-title" style={{ fontSize: 22 }}>
          Signing you in...
        </h3>
        <p style={{ color: "var(--dgv-text-muted)" }}>
          Please wait, redirecting to the portal.
        </p>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { fetchConsent, acceptConsent } from "../services/api";
import { colors, pageCard, buttonPrimary } from "../theme";

export default function ConsentGate({ children }) {
  const [loading, setLoading] = useState(true);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    fetchConsent()
      .then((r) => setAccepted(!!r.accepted))
      .catch(() => setAccepted(false))
      .finally(() => setLoading(false));
  }, []);

  const handleAccept = async () => {
    await acceptConsent();
    setAccepted(true);
  };

  if (loading) return null;

  if (accepted) return children;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 16,
      }}
    >
      <div style={{ ...pageCard, maxWidth: 520 }}>
        <h2 style={{ marginTop: 0 }}>DGV Portal — Usage Policy</h2>
        <p style={{ color: colors.textMuted, lineHeight: 1.6 }}>
          By using the DGV Employee Portal, you agree that DGV may log session activity
          including login times, IP address, device type, and pages accessed for attendance
          and security purposes. Data is retained per company policy.
        </p>
        <ul style={{ color: colors.textMuted, fontSize: 14, lineHeight: 1.8 }}>
          <li>Login / logout times and session duration</li>
          <li>IP address and approximate location (city level)</li>
          <li>Device and browser information</li>
          <li>Task and attendance records you submit</li>
        </ul>
        <button style={{ ...buttonPrimary, width: "100%" }} onClick={handleAccept}>
          I Agree — Continue to Portal
        </button>
      </div>
    </div>
  );
}

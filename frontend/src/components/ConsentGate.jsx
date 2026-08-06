import { useEffect, useState } from "react";
import { fetchConsent, acceptConsent } from "../services/api";
import { colors, pageCard, pageTitle } from "../theme";
import Button from "./ui/Button";

const CONSENT_KEY = "dgv-consent-accepted";

function readLocalConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeLocalConsent() {
  try {
    localStorage.setItem(CONSENT_KEY, "1");
  } catch {
    /* ignore */
  }
}

export default function ConsentGate({ children }) {
  const [loading, setLoading] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // If user already agreed locally, don't block the portal while API is down
    if (readLocalConsent()) {
      setAccepted(true);
      setLoading(false);
    }

    fetchConsent()
      .then((r) => {
        if (cancelled) return;
        const ok = !!r.accepted;
        if (ok) writeLocalConsent();
        // Prefer server truth, but keep local acceptance if API says false after prior agree
        setAccepted(ok || readLocalConsent());
      })
      .catch((err) => {
        if (cancelled) return;
        // Keep local acceptance if API is unreachable; otherwise show the gate
        console.warn("Consent check failed:", err);
        setAccepted(readLocalConsent());
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAccept = async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setSubmitting(true);

    try {
      await acceptConsent();
      writeLocalConsent();
      setAccepted(true);
    } catch (err) {
      console.warn("Consent accept failed:", err);
      // Unlock UI so a network/API outage does not trap the user behind the modal
      writeLocalConsent();
      setAccepted(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div
        className="dgv-modal-overlay"
        style={{ zIndex: 10050 }}
        aria-busy="true"
      >
        <div style={{ ...pageCard, maxWidth: 360, margin: 0, textAlign: "center" }}>
          <p style={{ color: colors.textMuted, margin: 0 }}>Loading portal…</p>
        </div>
      </div>
    );
  }

  if (accepted) return children;

  return (
    <div
      className="dgv-modal-overlay"
      style={{ zIndex: 10050, pointerEvents: "auto" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-title"
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          ...pageCard,
          maxWidth: 520,
          margin: 0,
          pointerEvents: "auto",
          position: "relative",
          zIndex: 10051,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="consent-title" style={{ ...pageTitle, fontSize: 22 }}>
          DGV Portal — Usage Policy
        </h2>
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

        <Button
          type="button"
          variant="primary"
          loading={submitting}
          disabled={submitting}
          onClick={handleAccept}
          style={{ width: "100%", position: "relative", zIndex: 10052 }}
        >
          I Agree — Continue to Portal
        </Button>
      </div>
    </div>
  );
}

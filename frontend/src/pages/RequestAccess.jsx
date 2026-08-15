import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  requestAccess,
  checkAccess,
  applyAccessRedirect,
  getLoggedInEmail,
} from "../services/auth";
import AmbientBackground from "../components/AmbientBackground";
import Button from "../components/ui/Button";

export default function RequestAccess() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const status = params.get("status");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const email = getLoggedInEmail();

  useEffect(() => {
    const verifyAccess = async () => {
      try {
        const data = await checkAccess();
        if (data.access === "USER" || data.access === "ADMIN") {
          applyAccessRedirect(data);
          return;
        }
        if (data.access === "PENDING") {
          navigate("/request-access?status=pending", { replace: true });
        }
      } catch {
        navigate("/login", { replace: true });
      } finally {
        setLoading(false);
      }
    };

    verifyAccess();
  }, [navigate]);

  const handleRequest = async () => {
    setMsg("");
    setLoading(true);
    try {
      const data = await requestAccess();
      if (data.access === "USER" || data.access === "ADMIN") {
        return;
      }
      setMsg(data.message || "Access request sent. Please wait for approval.");
      navigate("/request-access?status=pending", { replace: true });
    } catch (err) {
      setMsg(err.message || "Failed to send access request.");
    } finally {
      setLoading(false);
    }
  };

  if (loading && !msg) {
    return (
      <div className="dgv-auth-shell">
        <AmbientBackground />
        <div className="dgv-auth-card">
          <h2 className="dgv-page-title" style={{ fontSize: 22 }}>
            Checking access...
          </h2>
        </div>
      </div>
    );
  }

  return (
    <div className="dgv-auth-shell">
      <AmbientBackground />
      <div className="dgv-auth-card">
        <h2 className="dgv-page-title" style={{ fontSize: 22 }}>
          Request Portal Access
        </h2>

        {email && (
          <p className="dgv-page-subtitle">
            Signed in as <strong>{email}</strong>
          </p>
        )}

        {status === "pending" ? (
          <>
            <p style={{ color: "var(--dgv-text-secondary)" }}>
              Your request is under review. An admin will approve your access.
            </p>
            <p style={{ color: "var(--dgv-text-muted)", fontSize: 14 }}>
              Once approved, log out and sign in again to enter the portal.
            </p>
          </>
        ) : (
          <>
            <p style={{ color: "var(--dgv-text-secondary)" }}>
              You do not have portal access yet.
            </p>
            <p style={{ color: "var(--dgv-text-muted)", fontSize: 14, marginBottom: 16 }}>
              Click below to submit an access request. No email entry needed — we use
              your company login email automatically.
            </p>
            <Button onClick={handleRequest} disabled={loading} loading={loading} style={{ width: "100%" }}>
              Request Access
            </Button>
          </>
        )}

        {msg && (
          <div className="dgv-alert dgv-alert--info" style={{ marginTop: 16 }}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}

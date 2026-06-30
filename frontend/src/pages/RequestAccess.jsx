import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  requestAccess,
  checkAccess,
  applyAccessRedirect,
  getLoggedInEmail,
} from "../services/auth";

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
      <div style={{ textAlign: "center", marginTop: 80 }}>
        <h2>Checking access...</h2>
      </div>
    );
  }

  return (
    <div style={{ textAlign: "center", marginTop: 80, padding: 24 }}>
      <h2>Request Portal Access</h2>

      {email && (
        <p style={{ color: "#555" }}>
          Signed in as <strong>{email}</strong>
        </p>
      )}

      {status === "pending" ? (
        <>
          <p>Your request is under review. An admin will approve your access.</p>
          <p style={{ color: "#666", fontSize: 14 }}>
            Once approved, log out and sign in again to enter the portal.
          </p>
        </>
      ) : (
        <>
          <p>You do not have portal access yet.</p>
          <p style={{ color: "#666", fontSize: 14, marginBottom: 16 }}>
            Click below to submit an access request. No email entry needed — we use
            your company login email automatically.
          </p>
          <button onClick={handleRequest} disabled={loading}>
            {loading ? "Submitting..." : "Request Access"}
          </button>
        </>
      )}

      {msg && <p style={{ marginTop: 16, color: "#1976d2" }}>{msg}</p>}
    </div>
  );
}

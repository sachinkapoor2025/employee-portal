import { useEffect, useState } from "react";

export default function RequestAccess() {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const token = localStorage.getItem("token");

  /**
   * SAFETY CHECK
   * If user already has access, they should NEVER see this page
   */
  useEffect(() => {
    const checkExistingAccess = async () => {
      if (!token) return;

      try {
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/access`,
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );

        if (!res.ok) return;

        const data = await res.json();

        if (data.access === "USER") {
          window.location.replace("/");
        }

        if (data.access === "ADMIN") {
          window.location.replace("/admin/users");
        }

        if (data.access === "BLOCKED") {
          window.location.replace("/blocked");
        }

        // ONLY DENIED users remain here
      } catch (err) {
        console.error("Access re-check failed:", err);
      }
    };

    checkExistingAccess();
  }, [token]);

  /**
   * REQUEST ACCESS (ONLY FOR NEW USERS)
   */
  const requestAccess = async () => {
    if (!token) {
      setMessage("You are not logged in");
      return;
    }

    try {
      setLoading(true);
      setMessage("");

      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/request-access`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Request failed");
      }

      setMessage("✅ Access request submitted. Please wait for admin approval.");

    } catch (err) {
      console.error("Request access failed:", err);
      setMessage("❌ Failed to submit access request");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        backgroundColor: "rgba(255,255,255,0.95)",
        padding: "32px",
        borderRadius: "12px",
        textAlign: "center",
        maxWidth: "420px",
        margin: "80px auto"
      }}
    >
      <h2>Request MYDGV Portal Access</h2>

      <p style={{ marginBottom: 16 }}>
        Your email is not registered yet. Click below to request access.
      </p>

      <button
        onClick={requestAccess}
        disabled={loading}
        style={{
          padding: "10px 20px",
          backgroundColor: "#1976d2",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer"
        }}
      >
        {loading ? "Submitting..." : "Request Access"}
      </button>

      {message && (
        <p style={{ marginTop: 16 }}>
          {message}
        </p>
      )}
    </div>
  );
}

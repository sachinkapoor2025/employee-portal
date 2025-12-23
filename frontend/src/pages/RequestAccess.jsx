import { useState } from "react";

export default function RequestAccess() {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const requestAccess = async () => {
    const token = localStorage.getItem("token");

    console.log("Request Access clicked");
    console.log("Token present:", !!token);
    console.log("API URL:", process.env.REACT_APP_API_URL);

    if (!token) {
      setMessage("You are not logged in");
      return;
    }

    try {
      setLoading(true);

      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/request-access`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          }
        }
      );

      console.log("Response status:", res.status);

      const data = await res.json();
      console.log("Response body:", data);

      setMessage(data.message || "Request submitted");
    } catch (error) {
      console.error("Request access failed:", error);
      setMessage("Error requesting access");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        backgroundColor: "rgba(255,255,255,0.9)",
        padding: "24px",
        borderRadius: "12px",
        textAlign: "center"
      }}
    >
      <h2>Please request MYDGV Portal access</h2>

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

      {message && <p>{message}</p>}
    </div>
  );
}

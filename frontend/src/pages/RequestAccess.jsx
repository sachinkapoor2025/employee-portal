import { useState } from "react";

export default function RequestAccess() {
  const [message, setMessage] = useState("");

  const requestAccess = async () => {
    const token = localStorage.getItem("token");
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/request-access`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`
        }
        });
      const data = await res.json();
      setMessage(data.message || "Request submitted");
    } catch (error) {
      setMessage("Error requesting access");
    }
  };

  return (
    <div style={{ backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px", textAlign: "center" }}>
      <h2>Please request MYDGV Portal access</h2>
      <button
        onClick={requestAccess}
        style={{
          padding: "10px 20px",
          backgroundColor: "#1976d2",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer"
        }}
      >
        Request Access
      </button>
      {message && <p>{message}</p>}
    </div>
  );
}

import { useState } from "react";

export default function RequestAccess() {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const requestAccess = async () => {
    const token = localStorage.getItem("token");
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

      const data = await res.json();
      setMessage(data.message || "Request submitted");
    } catch (err) {
      setMessage("Error requesting access");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24, textAlign: "center" }}>
      <h2>Please request MYDGV Portal access</h2>
      <button onClick={requestAccess} disabled={loading}>
        {loading ? "Submitting..." : "Request Access"}
      </button>
      {message && <p>{message}</p>}
    </div>
  );
}

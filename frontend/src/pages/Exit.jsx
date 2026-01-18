import { useState } from "react";
import Layout from "../components/Layout";

export default function Exit() {
  const [reason, setReason] = useState("");
  const [lastWorkingDay, setLastWorkingDay] = useState("");
  const [loading, setLoading] = useState(false);

  const submitResignation = async () => {
    if (!reason || !lastWorkingDay) {
      alert("Please fill all fields");
      return;
    }

    setLoading(true);
    const token = localStorage.getItem("token");

    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/resignations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason, lastWorkingDay }),
      });

      if (res.ok) {
        alert("Resignation submitted successfully");
        setReason("");
        setLastWorkingDay("");
      } else {
        alert("Failed to submit resignation");
      }
    } catch (err) {
      alert("Something went wrong");
    }

    setLoading(false);
  };

  return (
    <Layout>
      <div
        style={{
          background: "rgba(255,255,255,0.95)",
          padding: 24,
          borderRadius: 12,
          maxWidth: 600,
        }}
      >
        <h2>Exit Organization</h2>

        <label>Last Working Day</label>
        <input
          type="date"
          value={lastWorkingDay}
          onChange={(e) => setLastWorkingDay(e.target.value)}
          style={{ width: "100%", padding: 8, marginBottom: 12 }}
        />

        <label>Resignation Reason</label>
        <textarea
          rows={5}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ width: "100%", padding: 8 }}
        />

        <button
          onClick={submitResignation}
          disabled={loading}
          style={{
            marginTop: 16,
            padding: "10px 20px",
            background: "#d32f2f",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          {loading ? "Submitting..." : "Submit Resignation"}
        </button>
      </div>
    </Layout>
  );
}

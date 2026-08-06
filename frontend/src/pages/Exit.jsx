import { useState } from "react";
import Layout from "../components/Layout";
import {
  pageCard,
  pageTitle,
  formLabel,
  formInput,
  buttonPrimary,
  colors,
} from "../theme";

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
      const res = await fetch(`${process.env.REACT_APP_API_URL}/resignation`, {
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
      <div style={{ ...pageCard, maxWidth: 600 }}>
        <h2 style={pageTitle}>Exit Organization</h2>

        <label style={formLabel}>Last Working Day</label>
        <input
          type="date"
          value={lastWorkingDay}
          onChange={(e) => setLastWorkingDay(e.target.value)}
          style={formInput}
        />

        <label style={formLabel}>Resignation Reason</label>
        <textarea
          rows={5}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ ...formInput, resize: "vertical", minHeight: 120 }}
        />

        <button
          onClick={submitResignation}
          disabled={loading}
          style={{
            ...buttonPrimary,
            background: "var(--dgv-danger)",
            marginTop: 8,
          }}
        >
          {loading ? "Submitting..." : "Submit Resignation"}
        </button>
        <p style={{ color: colors.textMuted, fontSize: 13, marginTop: 12 }}>
          Submitting a resignation notifies HR / admin for review.
        </p>
      </div>
    </Layout>
  );
}

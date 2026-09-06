import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import Layout from "../components/Layout";
import {
  pageTitle,
  formLabel,
  formInput,
  buttonPrimary,
  colors,
} from "../theme";
import { fetchMyResignations, submitResignation as submitResignationApi } from "../services/api";

function formatDate(value) {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T12:00:00`);
    if (!Number.isFinite(d.getTime())) return value;
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function statusClass(status) {
  const s = String(status || "").toUpperCase();
  if (s === "APPROVED") return "dgv-badge dgv-badge--success";
  if (s === "REJECTED") return "dgv-badge dgv-badge--danger";
  return "dgv-badge dgv-badge--info";
}

export default function Exit() {
  const navigate = useNavigate();
  const [reason, setReason] = useState("");
  const [lastWorkingDay, setLastWorkingDay] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const rows = await fetchMyResignations();
      setHistory(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.warn("Failed to load resignation history:", err);
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const submitResignation = async () => {
    if (!reason || !lastWorkingDay) {
      alert("Please fill all fields");
      return;
    }

    setLoading(true);
    try {
      await submitResignationApi({ reason, lastWorkingDay });
      alert("Resignation submitted successfully");
      setReason("");
      setLastWorkingDay("");
      await loadHistory();
    } catch (err) {
      alert(err.message || "Failed to submit resignation");
    }

    setLoading(false);
  };

  return (
    <Layout>
      <div className="dgv-exit-page">
        <div className="dgv-exit-panel">
        <button
          type="button"
          className="dgv-exit-back"
          onClick={() => navigate("/profile")}
        >
          <ArrowLeft size={16} />
          Back to Profile
        </button>
        <h2 className="dgv-exit-panel__title" style={{ ...pageTitle, marginBottom: 8 }}>
          Exit Organization
        </h2>

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

        <h3 style={{ ...pageTitle, fontSize: 18, marginTop: 28 }}>
          Resignation history
        </h3>
        {historyLoading ? (
          <p style={{ color: colors.textMuted }}>Loading resignation history…</p>
        ) : history.length === 0 ? (
          <p style={{ color: colors.textMuted }}>
            No resignation has been submitted yet.
          </p>
        ) : (
          <div className="dgv-table-wrap">
            <table className="dgv-table">
              <thead>
                <tr>
                  <th>Submitted</th>
                  <th>Last Working Day</th>
                  <th>Reason</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.resignationId || row.createdAt}>
                    <td>{formatDate(row.createdAt)}</td>
                    <td>{formatDate(row.lastWorkingDay)}</td>
                    <td>{row.reason || "—"}</td>
                    <td>
                      <span className={statusClass(row.status)}>
                        {row.status || "SUBMITTED"}
                      </span>
                      {row.reviewedAt ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: colors.textMuted,
                            marginTop: 4,
                          }}
                        >
                          Reviewed {formatDate(row.reviewedAt)}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </div>
    </Layout>
  );
}

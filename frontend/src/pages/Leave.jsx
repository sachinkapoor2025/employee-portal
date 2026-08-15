import { useEffect, useMemo, useState } from "react";
import Layout from "../components/Layout";
import Button from "../components/ui/Button";
import { fetchMyLeave, applyLeave } from "../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  formLabel,
  formInput,
  formSelect,
  alertSuccess,
} from "../theme";

function daysInclusive(fromDate, toDate) {
  if (!fromDate || !toDate) return 0;
  const a = Date.parse(`${fromDate}T00:00:00`);
  const b = Date.parse(`${toDate}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.floor((b - a) / 86400000) + 1;
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysUntil(startDate) {
  if (!startDate) return null;
  const a = Date.parse(`${todayKey()}T00:00:00`);
  const b = Date.parse(`${startDate}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function formatDateTime(value) {
  if (!value) return "—";
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
  return formatDateTime(value);
}

function displayStatus(row) {
  const s = String(row?.status || "").toUpperCase();
  if (s === "PLANNED_OFF") return "PLANNED OFF";
  if (s === "PENDING" || s === "PENDING_APPROVAL") return "PENDING APPROVAL";
  return s || "—";
}

function statusClass(row) {
  const s = String(row?.status || "").toUpperCase();
  if (s === "APPROVED" || s === "PLANNED_OFF") return "dgv-badge dgv-badge--success";
  if (s === "REJECTED" || s === "CANCELLED") return "dgv-badge dgv-badge--danger";
  return "dgv-badge dgv-badge--info";
}

function typeLabel(row) {
  if (row?.category === "PLANNED_OFF" || row?.type === "PLANNED_OFF") return "Planned Off";
  const map = { CASUAL: "Casual Leave", SICK: "Sick Leave", EARNED: "Earned Leave" };
  return map[row?.type] || row?.type || "Leave";
}

const choiceCard = (active) => ({
  flex: 1,
  minWidth: 220,
  textAlign: "left",
  padding: "18px 16px",
  borderRadius: 12,
  border: `2px solid ${active ? "var(--dgv-accent)" : "var(--dgv-border)"}`,
  background: active ? "var(--dgv-accent-soft)" : "var(--dgv-surface-solid)",
  color: "var(--dgv-text)",
  cursor: "pointer",
});

export default function Leave() {
  const [leaves, setLeaves] = useState([]);
  const [mode, setMode] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [planned, setPlanned] = useState({
    date: "",
    reason: "",
    emergencyReason: "",
  });
  const [leaveForm, setLeaveForm] = useState({
    type: "CASUAL",
    fromDate: "",
    toDate: "",
    reason: "",
    emergencyReason: "",
  });

  const load = () => fetchMyLeave().then(setLeaves).catch(console.error);

  useEffect(() => {
    load();
  }, []);

  const plannedSameDay = daysUntil(planned.date) === 0;
  const leaveDays = daysInclusive(leaveForm.fromDate, leaveForm.toDate);
  const leaveUntil = daysUntil(leaveForm.fromDate);
  const leaveNeedsEmergency = leaveDays > 1 && leaveUntil != null && leaveUntil < 3;

  const submitPlanned = async () => {
    setError("");
    setMsg("");
    if (!planned.date) {
      setError("Please choose a Planned Off date.");
      return;
    }
    if (plannedSameDay && !planned.emergencyReason.trim()) {
      setError("Same-day Planned Off requires an emergency reason.");
      return;
    }
    setSaving(true);
    try {
      await applyLeave({
        category: "PLANNED_OFF",
        type: "PLANNED_OFF",
        fromDate: planned.date,
        toDate: planned.date,
        startDate: planned.date,
        endDate: planned.date,
        reason: planned.reason,
        emergencyReason: planned.emergencyReason,
      });
      setPlanned({ date: "", reason: "", emergencyReason: "" });
      setMsg("Planned Off recorded. No approval needed.");
      load();
    } catch (err) {
      setError(err.message || "Unable to submit Planned Off.");
    } finally {
      setSaving(false);
    }
  };

  const submitLeave = async () => {
    setError("");
    setMsg("");
    if (!leaveForm.fromDate || !leaveForm.toDate) {
      setError("Start date and end date are required.");
      return;
    }
    if (leaveNeedsEmergency && !leaveForm.emergencyReason.trim()) {
      setError(
        "Leave requests for more than 1 day should normally be submitted at least 3 days in advance. Please provide an emergency reason."
      );
      return;
    }
    setSaving(true);
    try {
      await applyLeave({
        category: "LEAVE",
        type: leaveForm.type,
        fromDate: leaveForm.fromDate,
        toDate: leaveForm.toDate,
        startDate: leaveForm.fromDate,
        endDate: leaveForm.toDate,
        reason: leaveForm.reason,
        emergencyReason: leaveForm.emergencyReason,
      });
      setLeaveForm({
        type: "CASUAL",
        fromDate: "",
        toDate: "",
        reason: "",
        emergencyReason: "",
      });
      setMsg("Leave request submitted for approval.");
      load();
    } catch (err) {
      setError(err.message || "Unable to submit leave request.");
    } finally {
      setSaving(false);
    }
  };

  const rows = useMemo(() => (Array.isArray(leaves) ? leaves : []), [leaves]);

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Request Time Off</h2>
        <p style={pageSubtitle}>
          Choose Planned Off for a scheduled day off, or Apply for Leave when approval is required.
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          <button type="button" style={choiceCard(mode === "planned")} onClick={() => { setMode("planned"); setError(""); setMsg(""); }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>PLANNED OFF</div>
            <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>No approval needed</div>
          </button>
          <button type="button" style={choiceCard(mode === "leave")} onClick={() => { setMode("leave"); setError(""); setMsg(""); }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>APPLY FOR LEAVE</div>
            <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>Approval required</div>
          </button>
        </div>

        {error ? (
          <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 12 }}>
            {error}
          </div>
        ) : null}
        {msg ? <div style={alertSuccess}>{msg}</div> : null}

        {mode === "planned" ? (
          <section style={sectionBox}>
            <h3 style={{ marginTop: 0 }}>Planned Off</h3>
            <p style={{ color: colors.textMuted, fontSize: 13, marginTop: 0 }}>
              Submit at least 1 day before the date. Same-day / few hours before is allowed only with an emergency reason.
            </p>
            <label style={formLabel}>Planned Off Date</label>
            <input
              type="date"
              style={formInput}
              value={planned.date}
              min={todayKey()}
              onChange={(e) => setPlanned({ ...planned, date: e.target.value })}
            />
            <label style={formLabel}>Reason</label>
            <textarea
              style={{ ...formInput, minHeight: 70 }}
              value={planned.reason}
              onChange={(e) => setPlanned({ ...planned, reason: e.target.value })}
              placeholder="Optional"
            />
            {plannedSameDay ? (
              <>
                <label style={formLabel}>Emergency Reason</label>
                <textarea
                  style={{ ...formInput, minHeight: 70 }}
                  value={planned.emergencyReason}
                  onChange={(e) =>
                    setPlanned({ ...planned, emergencyReason: e.target.value })
                  }
                  placeholder="Required for same-day Planned Off"
                />
              </>
            ) : null}
            <Button type="button" loading={saving} disabled={saving} onClick={submitPlanned}>
              Submit Planned Off
            </Button>
          </section>
        ) : null}

        {mode === "leave" ? (
          <section style={sectionBox}>
            <h3 style={{ marginTop: 0 }}>Leave Request</h3>
            <label style={formLabel}>Leave Type</label>
            <select
              style={formSelect}
              value={leaveForm.type}
              onChange={(e) => setLeaveForm({ ...leaveForm, type: e.target.value })}
            >
              <option value="CASUAL">Casual Leave</option>
              <option value="SICK">Sick Leave</option>
              <option value="EARNED">Earned Leave</option>
            </select>
            <label style={formLabel}>Start Date</label>
            <input
              type="date"
              style={formInput}
              value={leaveForm.fromDate}
              min={todayKey()}
              onChange={(e) => setLeaveForm({ ...leaveForm, fromDate: e.target.value })}
            />
            <label style={formLabel}>End Date</label>
            <input
              type="date"
              style={formInput}
              value={leaveForm.toDate}
              min={leaveForm.fromDate || todayKey()}
              onChange={(e) => setLeaveForm({ ...leaveForm, toDate: e.target.value })}
            />
            <p style={{ margin: "0 0 12px", fontWeight: 600 }}>
              Number of Days: {leaveDays > 0 ? `${leaveDays} Day${leaveDays === 1 ? "" : "s"}` : "—"}
            </p>
            {leaveNeedsEmergency ? (
              <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 12 }}>
                Leave requests for more than 1 day should normally be submitted at least 3 days in advance.
              </div>
            ) : null}
            <label style={formLabel}>Reason</label>
            <textarea
              style={{ ...formInput, minHeight: 70 }}
              value={leaveForm.reason}
              onChange={(e) => setLeaveForm({ ...leaveForm, reason: e.target.value })}
            />
            {leaveNeedsEmergency ? (
              <>
                <label style={formLabel}>Emergency Reason</label>
                <textarea
                  style={{ ...formInput, minHeight: 70 }}
                  value={leaveForm.emergencyReason}
                  onChange={(e) =>
                    setLeaveForm({ ...leaveForm, emergencyReason: e.target.value })
                  }
                  placeholder="Required because this request is less than 3 days before the start date"
                />
              </>
            ) : null}
            <Button type="button" loading={saving} disabled={saving} onClick={submitLeave}>
              Submit Leave Request
            </Button>
          </section>
        ) : null}

        <h3 style={{ marginTop: 28 }}>My Requests</h3>
        <div className="dgv-table-wrap">
          <table className="dgv-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Start Date</th>
                <th>End Date</th>
                <th>Days</th>
                <th>Reason</th>
                <th>Submitted</th>
                <th>Status</th>
                <th>Approved / Rejected By</th>
                <th>Action Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.leaveId}>
                  <td>{typeLabel(l)}</td>
                  <td>{formatDate(l.fromDate || l.startDate)}</td>
                  <td>{formatDate(l.toDate || l.endDate)}</td>
                  <td>{l.days || daysInclusive(l.fromDate, l.toDate) || "—"}</td>
                  <td style={{ maxWidth: 180, wordBreak: "break-word" }}>
                    {l.reason || l.emergencyReason || "—"}
                  </td>
                  <td>{formatDateTime(l.submittedAt || l.createdAt)}</td>
                  <td>
                    <span className={statusClass(l)}>{displayStatus(l)}</span>
                  </td>
                  <td>
                    {l.status === "PLANNED_OFF"
                      ? "No approval required"
                      : l.approvedBy || l.rejectedBy || l.reviewedBy || "—"}
                  </td>
                  <td>
                    {formatDateTime(l.approvedAt || l.rejectedAt || l.reviewedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? (
          <p style={{ color: colors.textMuted }}>No requests yet.</p>
        ) : null}
      </div>
    </Layout>
  );
}

const sectionBox = {
  padding: 16,
  borderRadius: 12,
  border: "1px solid var(--dgv-border)",
  background: "var(--dgv-surface-solid)",
  marginBottom: 8,
};

import { useEffect, useMemo, useState } from "react";
import Layout from "../../components/Layout";
import { fetchAllLeave, reviewLeave } from "../../services/api";
import { colors, pageCard, pageTitle, pageSubtitle } from "../../theme";

function daysInclusive(fromDate, toDate) {
  if (!fromDate || !toDate) return 0;
  const a = Date.parse(`${fromDate}T00:00:00`);
  const b = Date.parse(`${toDate}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.floor((b - a) / 86400000) + 1;
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
  return String(value);
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

function isPending(status) {
  const s = String(status || "").toUpperCase();
  return s === "PENDING" || s === "PENDING_APPROVAL";
}

function isPlannedOff(row) {
  return row?.category === "PLANNED_OFF" || row?.status === "PLANNED_OFF" || row?.type === "PLANNED_OFF";
}

function displayStatus(row) {
  if (isPlannedOff(row)) return "PLANNED OFF";
  const s = String(row?.status || "").toUpperCase();
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
  if (isPlannedOff(row)) return "Planned Off";
  const map = { CASUAL: "Casual Leave", SICK: "Sick Leave", EARNED: "Earned Leave" };
  return map[row?.type] || row?.type || "Leave";
}

function remainingLabel(row, now) {
  if (!isPending(row.status) || !row.approvalDeadline) return "—";
  const ms =
    row.remainingMs != null
      ? row.remainingMs
      : new Date(row.approvalDeadline).getTime() - now.getTime();
  if (ms <= 0) return "Auto-approving…";
  const totalMins = Math.floor(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m remaining`;
}

export default function LeaveManagement() {
  const [leaves, setLeaves] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState("");
  const [actMenuId, setActMenuId] = useState("");

  const load = () => fetchAllLeave().then(setLeaves).catch(console.error);

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const review = async (leaveId, status) => {
    let rejectionReason = "";
    if (status === "REJECTED") {
      rejectionReason = window.prompt("Rejection reason (optional):") || "";
    }
    setActMenuId("");
    setBusyId(leaveId);
    try {
      await reviewLeave(leaveId, status, rejectionReason);
      await load();
    } catch (err) {
      alert(err.message || "Unable to update leave");
    } finally {
      setBusyId("");
    }
  };

  const rows = useMemo(
    () => (Array.isArray(leaves) ? leaves : []),
    [leaves]
  );
  const planned = rows.filter(isPlannedOff);
  const requests = rows.filter((r) => !isPlannedOff(r));

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: "100%" }}>
        <h2 style={pageTitle}>Leave Requests</h2>
        <p style={pageSubtitle}>
          Approve or reject leave within 5 hours. Planned Off is recorded immediately and does not need approval.
        </p>

        <h3 style={{ marginTop: 8 }}>Pending & Leave Requests</h3>
        <div className="dgv-table-wrap" style={{ overflowX: "hidden" }}>
          <table
            className="dgv-table"
            style={{ minWidth: 0, width: "100%", tableLayout: "fixed" }}
          >
            <thead>
              <tr>
                <th>Employee</th>
                <th>Leave Type</th>
                <th>Start Date</th>
                <th>End Date</th>
                <th>Days</th>
                <th>Reason</th>
                <th>Emergency Reason</th>
                <th>Submitted At</th>
                <th>Approval Deadline</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((l) => (
                <tr key={l.leaveId}>
                  <td style={{ wordBreak: "break-word" }}>{l.email}</td>
                  <td style={{ wordBreak: "break-word" }}>{typeLabel(l)}</td>
                  <td style={{ wordBreak: "break-word" }}>
                    {formatDate(l.fromDate || l.startDate)}
                  </td>
                  <td style={{ wordBreak: "break-word" }}>
                    {formatDate(l.toDate || l.endDate)}
                  </td>
                  <td>{l.days || daysInclusive(l.fromDate, l.toDate) || "—"}</td>
                  <td style={{ wordBreak: "break-word" }}>
                    {l.reason || "—"}
                  </td>
                  <td style={{ wordBreak: "break-word" }}>
                    {l.emergencyReason || "—"}
                  </td>
                  <td>{formatDateTime(l.submittedAt || l.createdAt)}</td>
                  <td>
                    {l.approvalDeadline ? formatDateTime(l.approvalDeadline) : "—"}
                    {isPending(l.status) ? (
                      <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
                        Approval window: {remainingLabel(l, now)}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span className={statusClass(l)}>{displayStatus(l)}</span>
                  </td>
                  <td>
                    {isPending(l.status) ? (
                      <div style={{ position: "relative" }}>
                        <button
                          type="button"
                          className="dgv-btn dgv-btn--outline"
                          style={{ padding: "4px 12px", fontSize: 13 }}
                          disabled={busyId === l.leaveId}
                          aria-expanded={actMenuId === l.leaveId}
                          onClick={() =>
                            setActMenuId(
                              actMenuId === l.leaveId ? "" : l.leaveId
                            )
                          }
                        >
                          Act ▾
                        </button>
                        {actMenuId === l.leaveId ? (
                          <div
                            style={{
                              position: "absolute",
                              top: "calc(100% + 6px)",
                              right: 0,
                              zIndex: 20,
                              minWidth: 120,
                              padding: 6,
                              borderRadius: 10,
                              border: `1px solid ${colors.border}`,
                              background: "var(--dgv-card)",
                              boxShadow: "var(--dgv-shadow-lg)",
                              display: "flex",
                              flexDirection: "column",
                              gap: 6,
                            }}
                          >
                            <button
                              type="button"
                              className="dgv-btn dgv-btn--success"
                              style={{ padding: "6px 10px", fontSize: 13 }}
                              disabled={busyId === l.leaveId}
                              onClick={() => review(l.leaveId, "APPROVED")}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className="dgv-btn dgv-btn--danger"
                              style={{ padding: "6px 10px", fontSize: 13 }}
                              disabled={busyId === l.leaveId}
                              onClick={() => review(l.leaveId, "REJECTED")}
                            >
                              Reject
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {requests.length === 0 ? (
          <p style={{ color: colors.textMuted }}>No leave requests.</p>
        ) : null}

        <h3 style={{ marginTop: 28 }}>Planned Off</h3>
        <p style={{ color: colors.textMuted, fontSize: 13 }}>
          Visible for tracking only. No approval required.
        </p>
        <div className="dgv-table-wrap" style={{ overflowX: "hidden" }}>
          <table
            className="dgv-table"
            style={{ minWidth: 0, width: "100%", tableLayout: "fixed" }}
          >
            <thead>
              <tr>
                <th>Employee</th>
                <th>Date</th>
                <th>Days</th>
                <th>Reason</th>
                <th>Emergency Reason</th>
                <th>Submitted At</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {planned.map((l) => (
                <tr key={l.leaveId}>
                  <td>{l.email}</td>
                  <td>
                    {formatDate(l.fromDate || l.startDate)}
                    {l.toDate && l.toDate !== l.fromDate
                      ? ` – ${formatDate(l.toDate)}`
                      : ""}
                  </td>
                  <td>{l.days || 1}</td>
                  <td>{l.reason || "—"}</td>
                  <td>{l.emergencyReason || "—"}</td>
                  <td>{formatDateTime(l.submittedAt || l.createdAt)}</td>
                  <td>
                    <span className="dgv-badge dgv-badge--success">PLANNED OFF</span>
                    <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
                      No approval required
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {planned.length === 0 ? (
          <p style={{ color: colors.textMuted }}>No Planned Off records.</p>
        ) : null}
      </div>
    </Layout>
  );
}

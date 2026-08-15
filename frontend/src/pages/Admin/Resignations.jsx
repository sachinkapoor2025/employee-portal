import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { pageCard, pageTitle, buttonPrimary, colors } from "../../theme";
import {
  fetchAllResignations,
  reviewResignation,
} from "../../services/api";

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

function isPending(status) {
  const s = String(status || "").toUpperCase();
  return s === "SUBMITTED" || s === "PENDING";
}

export default function Resignations() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchAllResignations();
      const list = Array.isArray(data) ? data : [];
      setRows(list);
      setSelectedId((current) => {
        if (current && list.some((r) => r.resignationId === current)) {
          return current;
        }
        const pending = list.find((r) => isPending(r.status));
        return pending?.resignationId || list[0]?.resignationId || "";
      });
    } catch (err) {
      console.warn("Failed to load resignations:", err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selected = rows.find((r) => r.resignationId === selectedId) || null;

  const review = async (status) => {
    if (!selected) {
      alert("Select a resignation request first.");
      return;
    }
    if (!isPending(selected.status)) {
      alert("This resignation has already been reviewed.");
      return;
    }
    setBusy(true);
    try {
      await reviewResignation(selected.resignationId, status, selected.email);
      await load();
    } catch (err) {
      alert(err.message || "Unable to update resignation");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Resignations</h2>
        <button
          style={{
            ...buttonPrimary,
            background: "var(--dgv-success)",
            marginRight: 10,
          }}
          disabled={busy}
          onClick={() => review("APPROVED")}
        >
          Approve
        </button>
        <button
          style={{
            ...buttonPrimary,
            background: "var(--dgv-danger)",
          }}
          disabled={busy}
          onClick={() => review("REJECTED")}
        >
          Reject
        </button>
        <p style={{ color: colors.textMuted, marginTop: 16 }}>
          Review pending resignation requests here.
        </p>

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading resignations…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: colors.textMuted }}>
            No resignation requests have been submitted yet.
          </p>
        ) : (
          <>
            <div className="dgv-table-wrap">
              <table className="dgv-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Last Working Day</th>
                    <th>Reason</th>
                    <th>Submitted</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const active = row.resignationId === selectedId;
                    return (
                      <tr
                        key={row.resignationId || row.createdAt}
                        onClick={() => setSelectedId(row.resignationId)}
                        style={{
                          cursor: "pointer",
                          background: active
                            ? "var(--dgv-accent-soft)"
                            : undefined,
                        }}
                      >
                        <td>
                          <div style={{ fontWeight: 600 }}>
                            {row.name || "—"}
                          </div>
                          <div
                            style={{ fontSize: 12, color: colors.textMuted }}
                          >
                            {row.email}
                          </div>
                        </td>
                        <td>{formatDate(row.lastWorkingDay)}</td>
                        <td>{row.reason || "—"}</td>
                        <td>{formatDate(row.createdAt)}</td>
                        <td>
                          <span className={statusClass(row.status)}>
                            {row.status || "SUBMITTED"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {selected ? (
              <div
                style={{
                  marginTop: 20,
                  padding: 16,
                  borderRadius: 12,
                  border: `1px solid ${colors.border}`,
                  background: "var(--dgv-surface-solid)",
                }}
              >
                <h3 style={{ marginTop: 0, fontSize: 16 }}>Resignation details</h3>
                <p style={{ margin: "6px 0" }}>
                  <strong>Employee:</strong> {selected.name || "—"} ({selected.email})
                </p>
                <p style={{ margin: "6px 0" }}>
                  <strong>Last working day:</strong>{" "}
                  {formatDate(selected.lastWorkingDay)}
                </p>
                <p style={{ margin: "6px 0" }}>
                  <strong>Reason:</strong> {selected.reason || "—"}
                </p>
                <p style={{ margin: "6px 0" }}>
                  <strong>Status:</strong> {selected.status || "SUBMITTED"}
                </p>
                <p style={{ margin: "6px 0" }}>
                  <strong>Submitted:</strong> {formatDate(selected.createdAt)}
                </p>
                {selected.reviewedAt ? (
                  <p style={{ margin: "6px 0" }}>
                    <strong>Reviewed:</strong> {formatDate(selected.reviewedAt)}
                    {selected.reviewedBy ? ` by ${selected.reviewedBy}` : ""}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Layout>
  );
}

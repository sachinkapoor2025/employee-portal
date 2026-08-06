import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { fetchAllLeave, reviewLeave } from "../../services/api";
import { colors, pageCard, pageTitle } from "../../theme";

export default function LeaveManagement() {
  const [leaves, setLeaves] = useState([]);

  const load = () => fetchAllLeave().then(setLeaves).catch(console.error);

  useEffect(() => {
    load();
  }, []);

  const review = async (leaveId, status) => {
    await reviewLeave(leaveId, status);
    load();
  };

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Leave Requests</h2>
        <div className="dgv-table-wrap">
        <table className="dgv-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Type</th>
              <th>From</th>
              <th>To</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {leaves.map((l) => (
              <tr key={l.leaveId}>
                <td>{l.email}</td>
                <td>{l.type}</td>
                <td>{l.fromDate}</td>
                <td>{l.toDate}</td>
                <td>
                  <span
                    className={`dgv-badge ${
                      l.status === "APPROVED"
                        ? "dgv-badge--success"
                        : l.status === "REJECTED"
                          ? "dgv-badge--danger"
                          : "dgv-badge--info"
                    }`}
                  >
                    {l.status}
                  </span>
                </td>
                <td>
                  {l.status === "PENDING" && (
                    <>
                      <button
                        type="button"
                        className="dgv-btn dgv-btn--success"
                        style={{ padding: "4px 10px", marginRight: 6 }}
                        onClick={() => review(l.leaveId, "APPROVED")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="dgv-btn dgv-btn--danger"
                        style={{ padding: "4px 10px" }}
                        onClick={() => review(l.leaveId, "REJECTED")}
                      >
                        Reject
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {leaves.length === 0 && <p style={{ color: colors.textMuted }}>No leave requests.</p>}
      </div>
    </Layout>
  );
}

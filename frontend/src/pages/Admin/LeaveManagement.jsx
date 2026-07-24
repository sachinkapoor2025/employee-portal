import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { fetchAllLeave, reviewLeave } from "../../services/api";
import { colors, pageCard, pageTitle, buttonPrimary } from "../../theme";

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
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: colors.primary, color: "#fff" }}>
              <th style={{ padding: 10, textAlign: "left" }}>Employee</th>
              <th style={{ padding: 10, textAlign: "left" }}>Type</th>
              <th style={{ padding: 10, textAlign: "left" }}>From</th>
              <th style={{ padding: 10, textAlign: "left" }}>To</th>
              <th style={{ padding: 10, textAlign: "left" }}>Status</th>
              <th style={{ padding: 10, textAlign: "left" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {leaves.map((l) => (
              <tr key={l.leaveId} style={{ borderBottom: `1px solid ${colors.border}` }}>
                <td style={{ padding: 10 }}>{l.email}</td>
                <td style={{ padding: 10 }}>{l.type}</td>
                <td style={{ padding: 10 }}>{l.fromDate}</td>
                <td style={{ padding: 10 }}>{l.toDate}</td>
                <td style={{ padding: 10 }}>{l.status}</td>
                <td style={{ padding: 10 }}>
                  {l.status === "PENDING" && (
                    <>
                      <button style={{ ...buttonPrimary, padding: "4px 10px", marginRight: 6, background: colors.success }} onClick={() => review(l.leaveId, "APPROVED")}>Approve</button>
                      <button style={{ ...buttonPrimary, padding: "4px 10px", background: colors.error }} onClick={() => review(l.leaveId, "REJECTED")}>Reject</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {leaves.length === 0 && <p style={{ color: colors.textMuted }}>No leave requests.</p>}
      </div>
    </Layout>
  );
}

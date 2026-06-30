import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { fetchAdminDashboard } from "../../services/api";
import { colors, pageCard, pageTitle, buttonPrimary } from "../../theme";
import { useNavigate } from "react-router-dom";

export default function AdminDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchAdminDashboard()
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Layout>
        <div style={pageCard}><p>Loading dashboard...</p></div>
      </Layout>
    );
  }

  const stats = data?.stats || {};

  const cards = [
    { label: "Active Today", value: stats.activeUsersToday || 0, color: colors.primary },
    { label: "Open Tasks", value: stats.openTasks || 0, color: "#f57c00" },
    { label: "Projects", value: stats.totalProjects || 0, color: colors.success },
    { label: "Pending Leave", value: stats.pendingLeave || 0, color: colors.error },
  ];

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Admin Dashboard</h2>
        <p style={{ color: colors.textMuted }}>Overview for {data?.date}</p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16, margin: "24px 0" }}>
          {cards.map((c) => (
            <div key={c.label} style={{ background: colors.background, borderRadius: 12, padding: 20, borderLeft: `4px solid ${c.color}` }}>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{c.value}</div>
              <div style={{ color: colors.textMuted, fontSize: 13 }}>{c.label}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
          <button style={buttonPrimary} onClick={() => navigate("/admin/activity")}>Team Activity</button>
          <button style={buttonPrimary} onClick={() => navigate("/admin/tasks")}>Manage Tasks</button>
          <button style={buttonPrimary} onClick={() => navigate("/admin/leave")}>Leave Requests</button>
          <button style={buttonPrimary} onClick={() => navigate("/admin/announcements")}>Announcements</button>
        </div>

        <h3>Recent Activity</h3>
        {(data?.recentActivity || []).length === 0 ? (
          <p style={{ color: colors.textMuted }}>No activity logged today yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: colors.primary, color: "#fff" }}>
                <th style={{ padding: 8, textAlign: "left" }}>Time</th>
                <th style={{ padding: 8, textAlign: "left" }}>Name</th>
                <th style={{ padding: 8, textAlign: "left" }}>Type</th>
                <th style={{ padding: 8, textAlign: "left" }}>Location</th>
                <th style={{ padding: 8, textAlign: "left" }}>Device</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recentActivity || []).map((ev, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <td style={{ padding: 8, fontSize: 13 }}>{new Date(ev.timestamp).toLocaleTimeString()}</td>
                  <td style={{ padding: 8 }}>
                    <div style={{ fontWeight: 600 }}>{ev.name || "—"}</div>
                    <div style={{ fontSize: 11, color: colors.textMuted }}>{ev.email}</div>
                  </td>
                  <td style={{ padding: 8 }}>{ev.type}</td>
                  <td style={{ padding: 8, fontSize: 13 }}>{ev.location || "Unknown"}</td>
                  <td style={{ padding: 8 }}>{ev.device}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {(data?.overdueTasks || []).length > 0 && (
          <>
            <h3 style={{ marginTop: 24, color: colors.error }}>Overdue Tasks</h3>
            {data.overdueTasks.map((t) => (
              <div key={t.taskId} style={{ padding: 10, background: "#ffebee", borderRadius: 8, marginBottom: 8 }}>
                {t.title} — {t.assignee} (due {t.dueDate})
              </div>
            ))}
          </>
        )}
      </div>
    </Layout>
  );
}

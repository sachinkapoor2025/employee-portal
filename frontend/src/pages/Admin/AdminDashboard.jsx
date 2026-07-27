import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import { StatCard } from "../../components/ui/Card";
import { fetchAdminDashboard } from "../../services/api";
import { colors, pageCard, pageTitle, pageSubtitle } from "../../theme";
import { useNavigate } from "react-router-dom";
import {
  Users,
  ListTodo,
  FolderKanban,
  CalendarDays,
  Activity,
} from "lucide-react";

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
        <div style={pageCard}>
          <p style={{ color: colors.textMuted }}>Loading dashboard...</p>
        </div>
      </Layout>
    );
  }

  const stats = data?.stats || {};

  const cards = [
    {
      label: "Active Today",
      value: stats.activeUsersToday || 0,
      icon: <Users size={20} />,
    },
    {
      label: "Open Tasks",
      value: stats.openTasks || 0,
      icon: <ListTodo size={20} />,
    },
    {
      label: "Projects",
      value: stats.totalProjects || 0,
      icon: <FolderKanban size={20} />,
    },
    {
      label: "Pending Leave",
      value: stats.pendingLeave || 0,
      icon: <CalendarDays size={20} />,
    },
  ];

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Admin Dashboard</h2>
        <p style={pageSubtitle}>Overview for {data?.date}</p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 16,
            margin: "8px 0 24px",
          }}
        >
          {cards.map((c) => (
            <StatCard key={c.label} label={c.label} value={c.value} icon={c.icon} />
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
          <Button onClick={() => navigate("/admin/activity")}>Team Activity</Button>
          <Button variant="secondary" onClick={() => navigate("/admin/tasks")}>
            Manage Tasks
          </Button>
          <Button variant="outline" onClick={() => navigate("/admin/leave")}>
            Leave Requests
          </Button>
          <Button variant="outline" onClick={() => navigate("/admin/announcements")}>
            Announcements
          </Button>
        </div>

        <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Activity size={18} color="var(--dgv-accent)" />
          Recent Activity
        </h3>
        {(data?.recentActivity || []).length === 0 ? (
          <p style={{ color: colors.textMuted }}>No activity logged today yet.</p>
        ) : (
          <div className="dgv-table-wrap">
            <table className="dgv-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Location</th>
                  <th>Device</th>
                </tr>
              </thead>
              <tbody>
                {(data?.recentActivity || []).map((ev, i) => (
                  <tr key={i}>
                    <td>{new Date(ev.timestamp).toLocaleTimeString()}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{ev.name || "—"}</div>
                      <div style={{ fontSize: 11, color: colors.textMuted }}>{ev.email}</div>
                    </td>
                    <td>{ev.type}</td>
                    <td>{ev.location || "Unknown"}</td>
                    <td>{ev.device}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(data?.overdueTasks || []).length > 0 && (
          <>
            <h3 style={{ marginTop: 24, color: colors.error }}>Overdue Tasks</h3>
            {data.overdueTasks.map((t) => (
              <div
                key={t.taskId}
                style={{
                  padding: 10,
                  background: "var(--dgv-danger-bg)",
                  color: colors.error,
                  borderRadius: 10,
                  marginBottom: 8,
                }}
              >
                {t.title} — {t.assignee} (due {t.dueDate})
              </div>
            ))}
          </>
        )}
      </div>
    </Layout>
  );
}

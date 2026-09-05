import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import { StatCard } from "../../components/ui/Card";
import { fetchAdminDashboard } from "../../services/api";
import { colors, pageTitle, pageSubtitle } from "../../theme";
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
        <p style={{ color: colors.textMuted }}>Loading dashboard...</p>
      </Layout>
    );
  }

  const stats = data?.stats || {};
  const overdue = data?.overdueTasks || [];

  const cards = [
    {
      label: "Open Tasks",
      value: stats.openTasks || 0,
      hint: overdue.length ? `${overdue.length} overdue` : "No overdue tasks",
      icon: <ListTodo size={18} strokeWidth={1.75} />,
    },
    {
      label: "Active Today",
      value: stats.activeUsersToday || 0,
      hint: "Attendance today",
      icon: <Users size={18} strokeWidth={1.75} />,
    },
    {
      label: "Pending Leave",
      value: stats.pendingLeave || 0,
      hint: stats.pendingLeave ? "Requires approval" : "No pending requests",
      icon: <CalendarDays size={18} strokeWidth={1.75} />,
    },
    {
      label: "Projects",
      value: stats.totalProjects || 0,
      hint: "Active workspace",
      icon: <FolderKanban size={18} strokeWidth={1.75} />,
    },
  ];

  return (
    <Layout>
      <h1 style={pageTitle}>Admin Dashboard</h1>
      <p style={pageSubtitle}>Overview for {data?.date}</p>

      <div className="dgv-kpi-grid">
        {cards.map((c) => (
          <StatCard
            key={c.label}
            label={c.label}
            value={c.value}
            hint={c.hint}
            icon={c.icon}
          />
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
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

      {overdue.length > 0 ? (
        <>
          <h2 className="dgv-section-title">
            <ListTodo size={18} strokeWidth={1.75} />
            Overdue Tasks
          </h2>
          {overdue.map((t) => (
            <div
              key={t.taskId}
              className="dgv-task-card is-red"
              style={{
                background: "var(--dgv-danger-bg)",
                color: colors.error,
              }}
            >
              {t.title} — {t.assignee} (due {t.dueDate})
            </div>
          ))}
        </>
      ) : null}

      <h2 className="dgv-section-title">
        <Activity size={18} strokeWidth={1.75} />
        Recent Activity
      </h2>
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
                    <div style={{ fontSize: 12, color: colors.textMuted }}>{ev.email}</div>
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
    </Layout>
  );
}

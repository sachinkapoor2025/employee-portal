import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Clock,
  ListTodo,
  CalendarDays,
  Megaphone,
  ArrowRight,
} from "lucide-react";
import Layout from "../components/Layout";
import Button from "../components/ui/Button";
import { StatCard } from "../components/ui/Card";
import {
  fetchAnnouncements,
  fetchMyActivityToday,
  fetchTasks,
  fetchMyLeave,
} from "../services/api";
import { colors, pageCard, pageTitle, pageSubtitle } from "../theme";

export default function Dashboard() {
  const [announcements, setAnnouncements] = useState([]);
  const [activity, setActivity] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [leave, setLeave] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      fetchAnnouncements(),
      fetchMyActivityToday(),
      fetchTasks({ mine: "true" }),
      fetchMyLeave(),
    ])
      .then(([a, act, t, l]) => {
        setAnnouncements(a.slice(0, 3));
        setActivity(act);
        setTasks(t.filter((x) => x.status !== "DONE").slice(0, 5));
        setLeave(l.filter((x) => x.status === "PENDING"));
      })
      .catch(console.error);
  }, []);

  const mins = activity?.summary?.totalMinutes || 0;

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 960 }}>
        <h2 style={pageTitle}>Welcome to DGV Portal</h2>
        <p style={pageSubtitle}>Your gateway to company resources</p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 16,
            margin: "8px 0 24px",
          }}
        >
          <StatCard
            label="Portal Time Today"
            value={`${mins} min`}
            icon={<Clock size={20} />}
          />
          <StatCard
            label="Open Tasks"
            value={tasks.length}
            icon={<ListTodo size={20} />}
          />
          <StatCard
            label="Pending Leave"
            value={leave.length}
            icon={<CalendarDays size={20} />}
          />
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
          <Button onClick={() => navigate("/attendance")}>Mark Attendance</Button>
          <Button variant="secondary" onClick={() => navigate("/work")}>
            My Tasks
          </Button>
          <Button variant="outline" onClick={() => navigate("/leave")}>
            Apply Leave
          </Button>
          <Button variant="outline" onClick={() => navigate("/software-center")}>
            Software Center
          </Button>
        </div>

        {announcements.length > 0 && (
          <>
            <h3 style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 0 }}>
              <Megaphone size={18} color="var(--dgv-accent)" />
              Announcements
            </h3>
            {announcements.map((a) => (
              <div
                key={a.announceId}
                style={{
                  background: colors.primaryLight,
                  padding: 14,
                  borderRadius: 12,
                  marginBottom: 10,
                  border: `1px solid ${colors.border}`,
                }}
              >
                <strong>{a.title}</strong>
                <p style={{ margin: "6px 0 0", fontSize: 14, color: colors.textMuted }}>
                  {a.message}
                </p>
              </div>
            ))}
          </>
        )}

        <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ListTodo size={18} color="var(--dgv-accent)" />
          My Open Tasks
        </h3>
        {tasks.length === 0 ? (
          <p style={{ color: colors.textMuted }}>No open tasks assigned.</p>
        ) : (
          tasks.map((t) => (
            <div
              key={t.taskId}
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: 12,
                marginBottom: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                background: "var(--dgv-surface-solid)",
              }}
            >
              <div>
                <strong>{t.title}</strong>
                <span
                  className="dgv-badge dgv-badge--info"
                  style={{ marginLeft: 10 }}
                >
                  {t.status}
                </span>
              </div>
              <ArrowRight size={16} color="var(--dgv-text-muted)" />
            </div>
          ))
        )}
      </div>
    </Layout>
  );
}

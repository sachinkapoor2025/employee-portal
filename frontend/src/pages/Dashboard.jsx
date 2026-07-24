import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import {
  fetchAnnouncements,
  fetchMyActivityToday,
  fetchTasks,
  fetchMyLeave,
} from "../services/api";
import { colors, pageCard, pageTitle, buttonPrimary } from "../theme";

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
      <div style={{ ...pageCard, maxWidth: 900 }}>
        <h2 style={pageTitle}>Welcome to DGV Portal</h2>
        <p style={{ color: colors.textMuted }}>Your gateway to company resources</p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, margin: "20px 0" }}>
          <StatCard label="Portal Time Today" value={`${mins} min`} />
          <StatCard label="Open Tasks" value={tasks.length} />
          <StatCard label="Pending Leave" value={leave.length} />
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
          <button style={buttonPrimary} onClick={() => navigate("/attendance")}>Mark Attendance</button>
          <button style={buttonPrimary} onClick={() => navigate("/work")}>My Tasks</button>
          <button style={buttonPrimary} onClick={() => navigate("/leave")}>Apply Leave</button>
          <button style={buttonPrimary} onClick={() => navigate("/software-center")}>Software Center</button>
        </div>

        {announcements.length > 0 && (
          <>
            <h3>Announcements</h3>
            {announcements.map((a) => (
              <div key={a.announceId} style={{ background: colors.primaryLight, padding: 14, borderRadius: 8, marginBottom: 10 }}>
                <strong>{a.title}</strong>
                <p style={{ margin: "6px 0 0", fontSize: 14 }}>{a.message}</p>
              </div>
            ))}
          </>
        )}

        <h3>My Open Tasks</h3>
        {tasks.length === 0 ? (
          <p style={{ color: colors.textMuted }}>No open tasks assigned.</p>
        ) : (
          tasks.map((t) => (
            <div key={t.taskId} style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: 12, marginBottom: 8 }}>
              <strong>{t.title}</strong>
              <span style={{ marginLeft: 10, fontSize: 12, color: colors.textMuted }}>{t.status}</span>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
}

const StatCard = ({ label, value }) => (
  <div style={{ background: colors.background, borderRadius: 10, padding: 16 }}>
    <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
    <div style={{ fontSize: 13, color: colors.textMuted }}>{label}</div>
  </div>
);

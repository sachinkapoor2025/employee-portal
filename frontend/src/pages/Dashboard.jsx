import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ListTodo,
  CalendarDays,
  Megaphone,
  ArrowRight,
  Clock,
  Bell,
} from "lucide-react";
import Layout from "../components/Layout";
import Button from "../components/ui/Button";
import { StatCard } from "../components/ui/Card";
import {
  fetchAnnouncements,
  fetchTasks,
  fetchMyLeave,
  fetchMyActivityToday,
  fetchLeaveNotifications,
  markNotificationRead,
} from "../services/api";
import { colors, pageCard, pageTitle, pageSubtitle } from "../theme";
import ZoneBadge from "../components/ZoneBadge";
import { getTaskZone } from "../utils/taskStatus";
import { displayNameFromEmail } from "../utils/meetings";
import {
  isZoneNotification,
  isRedZoneNotification,
  relativeTime,
} from "../utils/notifications";

export default function Dashboard() {
  const [announcements, setAnnouncements] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [leave, setLeave] = useState([]);
  const [portalMinutes, setPortalMinutes] = useState(0);
  const [zoneNotes, setZoneNotes] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    const load = () => {
      Promise.all([
        fetchAnnouncements(),
        fetchTasks({ mine: "true" }),
        fetchMyLeave(),
        fetchMyActivityToday().catch(() => null),
        fetchLeaveNotifications().catch(() => []),
      ])
        .then(([a, t, l, activity, notes]) => {
          setAnnouncements(Array.isArray(a) ? a.slice(0, 3) : []);
          setTasks(
            Array.isArray(t)
              ? t
                  .filter((x) => {
                    const status = x.myAssignment?.status || x.status;
                    return status !== "DONE" && status !== "CANCELLED";
                  })
                  .slice(0, 5)
              : []
          );
          setLeave(
            Array.isArray(l)
              ? l.filter(
                  (x) => x.status === "PENDING" || x.status === "PENDING_APPROVAL"
                )
              : []
          );
          const mins = Number(activity?.summary?.totalMinutes);
          setPortalMinutes(Number.isFinite(mins) ? mins : 0);
          setZoneNotes(
            (Array.isArray(notes) ? notes : [])
              .filter(isZoneNotification)
              .slice(0, 8)
          );
        })
        .catch(console.error);
    };
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, []);

  const openZoneNote = async (item) => {
    if (item?.SK && item.read !== true) {
      try {
        await markNotificationRead(item.SK);
        setZoneNotes((prev) =>
          prev.map((n) =>
            n.SK === item.SK
              ? { ...n, read: true, readAt: new Date().toISOString() }
              : n
          )
        );
      } catch {
        /* still navigate */
      }
    }
    if (item?.taskId) navigate(`/work/${encodeURIComponent(item.taskId)}`);
  };

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
            value={`${portalMinutes} min`}
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

        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 24,
          }}
        >
          <Button onClick={() => navigate("/attendance")}>
            Mark Attendance
          </Button>
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

        {zoneNotes.length > 0 ? (
          <>
            <h3
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 0,
              }}
            >
              <Bell size={18} color="var(--dgv-accent)" />
              Notifications
            </h3>
            {zoneNotes.map((n) => {
              const red = isRedZoneNotification(n);
              const unreadItem = n.read !== true;
              return (
                <button
                  type="button"
                  key={n.notifyId || n.SK}
                  onClick={() => openZoneNote(n)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: unreadItem
                      ? red
                        ? "rgba(220,38,38,0.12)"
                        : "rgba(234,88,12,0.12)"
                      : "var(--dgv-surface-solid)",
                    border: `1px solid ${
                      red ? "rgba(220,38,38,0.45)" : "rgba(234,88,12,0.4)"
                    }`,
                    borderLeft: `5px solid ${red ? "#dc2626" : "#ea580c"}`,
                    borderRadius: 12,
                    padding: 14,
                    marginBottom: 10,
                    cursor: "pointer",
                    color: colors.text,
                  }}
                >
                  <div style={{ fontWeight: 800 }}>
                    {red ? "🚨 Red Zone" : "⚠️ Orange Zone"}
                    {unreadItem ? " · New" : ""}
                  </div>
                  <div style={{ fontWeight: 700, marginTop: 4 }}>
                    {n.title || (red ? "Task moved to Red Zone" : "Task moved to Orange Zone")}
                  </div>
                  <p
                    style={{
                      margin: "6px 0 0",
                      fontSize: 14,
                      color: colors.textMuted,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {n.message}
                  </p>
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      color: colors.textMuted,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <span>{relativeTime(n.createdAt)}</span>
                    <span style={{ color: "var(--dgv-accent)", fontWeight: 700 }}>
                      Open Task →
                    </span>
                  </div>
                </button>
              );
            })}
          </>
        ) : null}

        {announcements.length > 0 && (
          <>
            <h3
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 0,
              }}
            >
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
                <p
                  style={{
                    margin: "6px 0 0",
                    fontSize: 14,
                    color: colors.textMuted,
                  }}
                >
                  {a.message}
                </p>
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 12,
                    color: colors.textMuted,
                  }}
                >
                  {a.createdByName || a.createdBy
                    ? `By ${a.createdByName || displayNameFromEmail(a.createdBy)}`
                    : null}
                </div>
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
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/work/${encodeURIComponent(t.taskId)}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`/work/${encodeURIComponent(t.taskId)}`);
                }
              }}
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
                cursor: "pointer",
              }}
            >
              <div>
                <strong>{t.title}</strong>
                <span
                  className="dgv-badge dgv-badge--info"
                  style={{ marginLeft: 10 }}
                >
                  {t.myAssignment?.status || t.status}
                </span>
                <span style={{ marginLeft: 8, display: "inline-flex", verticalAlign: "middle" }}>
                  <ZoneBadge
                    zone={t.myAssignment?.zone || getTaskZone(t)}
                    status={t.myAssignment?.status || t.status}
                  />
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

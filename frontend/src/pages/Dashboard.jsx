import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
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
  fetchTasks,
  fetchWeekOffState,
} from "../services/api";
import { colors, pageTitle, pageSubtitle } from "../theme";
import ZoneBadge from "../components/ZoneBadge";
import {
  formatTaskDateTime,
  getTaskZone,
  statusLabel,
} from "../utils/taskStatus";
import { displayNameFromEmail } from "../utils/meetings";

export default function Dashboard() {
  const [announcements, setAnnouncements] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [weekOffState, setWeekOffState] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    const load = () => {
      Promise.all([
        fetchAnnouncements(),
        fetchTasks({ mine: "true" }),
        fetchWeekOffState(),
      ])
        .then(([a, t, weekOff]) => {
          setAnnouncements(Array.isArray(a) ? a.slice(0, 3) : []);
          const seen = new Set();
          const open = [];
          for (const x of Array.isArray(t) ? t : []) {
            const id = x?.taskId;
            if (!id || seen.has(id)) continue;
            const status = String(
              x.myAssignment?.status || x.status || ""
            ).toUpperCase();
            if (status === "DONE" || status === "CANCELLED") continue;
            seen.add(id);
            open.push(x);
          }
          open.sort((left, right) => {
            const leftMs = Date.parse(
              left.myAssignment?.assignedAt ||
                left.updatedAt ||
                left.createdAt ||
                0
            );
            const rightMs = Date.parse(
              right.myAssignment?.assignedAt ||
                right.updatedAt ||
                right.createdAt ||
                0
            );
            return (Number.isFinite(rightMs) ? rightMs : 0) -
              (Number.isFinite(leftMs) ? leftMs : 0);
          });
          setTasks(open);
          setWeekOffState(
            weekOff && typeof weekOff === "object" && !Array.isArray(weekOff)
              ? weekOff
              : null
          );
        })
        .catch(console.error);
    };
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, []);

  const weekOffUsed = Number(weekOffState?.weekOffUsed) === 1;

  return (
    <Layout>
      <h1 style={pageTitle}>Welcome to DGV Portal</h1>
      <p style={pageSubtitle}>Your gateway to company resources</p>

      <div className="dgv-kpi-grid dgv-kpi-grid--2">
        <StatCard
          label="Open Tasks"
          value={tasks.length}
          hint={
            tasks.length
              ? `${tasks.length} requiring action`
              : "Nothing pending"
          }
          icon={<ListTodo size={18} strokeWidth={1.75} />}
        />
        <StatCard
          label="Week Off"
          value={weekOffState == null ? "—" : weekOffUsed ? 0 : 1}
          hint={
            weekOffState == null
              ? "This week"
              : weekOffUsed
                ? "This week · Used"
                : "This week · Available"
          }
          icon={<CalendarDays size={18} strokeWidth={1.75} />}
        />
      </div>

      <div className="dgv-dashboard-shortcuts">
        <Button onClick={() => navigate("/attendance")}>
          Mark Attendance
        </Button>
        <Button variant="secondary" onClick={() => navigate("/work")}>
          My Tasks
        </Button>
        <Button variant="outline" onClick={() => navigate("/leave")}>
          Apply Leave
        </Button>
        <Button
          className="dgv-hide-phone"
          variant="outline"
          onClick={() => navigate("/software-center")}
        >
          Software Center
        </Button>
      </div>

      <h2 className="dgv-section-title">
        <ListTodo size={18} strokeWidth={1.75} />
        My Open Tasks
      </h2>
      {tasks.length === 0 ? (
        <p style={{ color: colors.textMuted }}>No open tasks</p>
      ) : (
        tasks.map((t) => {
          const status = t.myAssignment?.status || t.status;
          const zone = t.myAssignment?.zone || getTaskZone(t);
          return (
            <div
              key={t.taskId}
              className="dgv-list-row"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/work/${encodeURIComponent(t.taskId)}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`/work/${encodeURIComponent(t.taskId)}`);
                }
              }}
            >
              <div>
                <div className="dgv-wrap-text" style={{ fontWeight: 600 }}>{t.title}</div>
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span className="dgv-badge dgv-badge--info">
                    {statusLabel(status)}
                  </span>
                  <ZoneBadge zone={zone} status={status} />
                </div>
                {t.dueDate ? (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 13,
                      color: colors.textMuted,
                    }}
                  >
                    Deadline: {formatTaskDateTime(t.dueDate)}
                  </div>
                ) : null}
              </div>
              <span
                style={{
                  color: "var(--dgv-text-secondary)",
                  fontWeight: 600,
                  fontSize: 13,
                  whiteSpace: "nowrap",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                Open Task
                <ArrowRight size={16} />
              </span>
            </div>
          );
        })
      )}

      {announcements.length > 0 ? (
        <>
          <h2 className="dgv-section-title">
            <Megaphone size={18} strokeWidth={1.75} />
            Announcements
          </h2>
          {announcements.map((a) => (
            <div
              key={a.announceId}
              className="dgv-card"
              style={{ padding: 20, marginBottom: 12 }}
            >
              <strong>{a.title}</strong>
              <p
                style={{
                  margin: "8px 0 0",
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
      ) : null}
    </Layout>
  );
}

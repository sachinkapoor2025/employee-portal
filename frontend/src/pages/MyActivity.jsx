import { useCallback, useEffect, useState } from "react";
import Layout from "../components/Layout";
import Button from "../components/ui/Button";
import { StatCard } from "../components/ui/Card";
import { fetchAttendance, fetchTaskList } from "../services/api";
import { getLoggedInDisplayName } from "../services/auth";
import { colors, pageCard, pageSubtitle, pageTitle } from "../theme";
import {
  addDaysToKey,
  currentWeekStartKey,
  EMPTY_ATTENDANCE_METRICS,
  EMPTY_TASK_METRICS,
  formatWeekRange,
  indexAttendanceByDate,
  startOfWeekKey,
  summarizeAttendanceWeek,
  summarizeTaskWeek,
  weekEndKey,
} from "../utils/myActivityReport";

const sectionCard = {
  ...pageCard,
  marginTop: 16,
};

function metricValue(metrics, key) {
  const value = metrics?.[key];
  return Number.isFinite(value) ? value : 0;
}

export default function MyActivity() {
  const [weekStart, setWeekStart] = useState(() => currentWeekStartKey());
  const [attendanceMetrics, setAttendanceMetrics] = useState(
    EMPTY_ATTENDANCE_METRICS
  );
  const [taskMetrics, setTaskMetrics] = useState(EMPTY_TASK_METRICS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const employeeName = getLoggedInDisplayName();

  const load = useCallback(async (mondayKey) => {
    setLoading(true);
    setError("");
    const start = startOfWeekKey(mondayKey);
    const end = weekEndKey(start);
    try {
      const [attendanceRows, taskList] = await Promise.all([
        fetchAttendance(start, end),
        fetchTaskList({ mine: "true" }),
      ]);
      setAttendanceMetrics(
        summarizeAttendanceWeek({
          weekStart: start,
          recordsByDate: indexAttendanceByDate(attendanceRows),
        })
      );
      setTaskMetrics(
        summarizeTaskWeek({
          weekStart: start,
          tasks: taskList?.tasks,
        })
      );
    } catch (err) {
      if (err?.status === 401 || /session expired/i.test(err?.message || "")) {
        return;
      }
      setAttendanceMetrics(EMPTY_ATTENDANCE_METRICS);
      setTaskMetrics(EMPTY_TASK_METRICS);
      setError(err.message || "Unable to load activity.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(weekStart);
  }, [weekStart, load]);

  const weekRange = formatWeekRange(weekStart);

  return (
    <Layout>
      <div style={pageCard}>
        <div className="dgv-weekly-attendance__header">
          <div>
            <h2 style={{ ...pageTitle, marginBottom: 4 }}>My Activity</h2>
            <p
              className="dgv-wrap-text"
              style={{ ...pageSubtitle, marginBottom: 0 }}
              aria-label="Selected week"
            >
              {weekRange}
            </p>
            {employeeName ? (
              <p style={{ ...pageSubtitle, margin: "8px 0 0" }}>{employeeName}</p>
            ) : null}
          </div>
          <div className="dgv-weekly-attendance__nav" aria-label="Week navigation">
            <Button
              type="button"
              variant="outline"
              onClick={() => setWeekStart((prev) => addDaysToKey(prev, -7))}
            >
              ← Previous Week
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setWeekStart(currentWeekStartKey())}
            >
              Current Week
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setWeekStart((prev) => addDaysToKey(prev, 7))}
            >
              Next Week →
            </Button>
          </div>
        </div>
        {loading ? (
          <p style={{ color: colors.textMuted, margin: "16px 0 0" }}>
            Loading activity...
          </p>
        ) : null}
        {error ? (
          <div className="dgv-alert dgv-alert--error" style={{ marginTop: 16 }} role="alert">
            {error}
          </div>
        ) : null}
      </div>

      <section style={sectionCard} aria-labelledby="my-activity-attendance">
        <h3 id="my-activity-attendance" style={{ marginTop: 0, marginBottom: 8 }}>
          Attendance
        </h3>
        <div className="dgv-kpi-grid dgv-kpi-grid--3">
          <StatCard label="Present" value={metricValue(attendanceMetrics, "present")} />
          <StatCard label="On Time" value={metricValue(attendanceMetrics, "onTime")} />
          <StatCard label="Late" value={metricValue(attendanceMetrics, "late")} />
          <StatCard label="Leave" value={metricValue(attendanceMetrics, "leave")} />
          <StatCard label="Week Off" value={metricValue(attendanceMetrics, "weekOff")} />
          <StatCard
            label="Not Marked"
            value={metricValue(attendanceMetrics, "notMarked")}
          />
        </div>
      </section>

      <section style={sectionCard} aria-labelledby="my-activity-tasks">
        <h3 id="my-activity-tasks" style={{ marginTop: 0, marginBottom: 8 }}>
          Task Performance
        </h3>
        <div className="dgv-kpi-grid">
          <StatCard
            label="Assigned"
            value={metricValue(taskMetrics, "assigned")}
            hint="Assigned work for this week"
          />
          <StatCard
            label="Completed"
            value={metricValue(taskMetrics, "completed")}
          />
          <StatCard
            label="Under Review"
            value={metricValue(taskMetrics, "underReview")}
          />
          <StatCard label="Red Zone" value={metricValue(taskMetrics, "redZone")} />
        </div>
      </section>
    </Layout>
  );
}

import { useCallback, useEffect, useState } from "react";
import Layout from "../components/Layout";
import ZoneBadge from "../components/ZoneBadge";
import { fetchMyDayActivity } from "../services/api";
import { todayKeyIST } from "../utils/meetings";
import { filterEmployeeTaskActivity } from "../utils/taskActivityFilter";
import { formatTaskDateTime } from "../utils/taskStatus";
import {
  colors,
  formInput,
  formLabel,
  pageCard,
  pageSubtitle,
  pageTitle,
} from "../theme";

const sectionCard = {
  ...pageCard,
  marginTop: 16,
};

function TaskActivityList({ activity }) {
  const rows = Array.isArray(activity) ? activity : [];
  if (!rows.length) {
    return (
      <p style={{ color: colors.textMuted, fontSize: 13, margin: "8px 0 0" }}>
        No activity recorded
      </p>
    );
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
      {rows.map((row, index) => (
        <li
          key={`${row.timestamp || "a"}-${index}`}
          style={{
            fontSize: 13,
            color: colors.textSecondary,
            padding: "6px 0",
            borderTop: "1px solid var(--dgv-border)",
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--dgv-text)" }}>
            {formatTaskDateTime(row.timestamp)}
          </span>
          {row.action ? ` · ${row.action}` : ""}
          {row.detail ? ` — ${row.detail}` : ""}
          {row.actorEmail ? ` (${row.actorEmail})` : ""}
        </li>
      ))}
    </ul>
  );
}

function TasksSection({ tasks, employeeEmail }) {
  const list = Array.isArray(tasks) ? tasks : [];
  return (
    <section style={sectionCard} aria-labelledby="my-activity-tasks">
      <h3 id="my-activity-tasks" style={{ marginTop: 0, marginBottom: 8 }}>
        Tasks
      </h3>
      {list.length === 0 ? (
        <p style={{ color: colors.textMuted, margin: 0 }}>No tasks for this day.</p>
      ) : (
        <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
          {list.map((task) => (
            <article key={task.taskId} className="dgv-task-card">
              <h4 className="dgv-task-card__title" style={{ margin: 0 }}>
                {task.title || task.taskId}
              </h4>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 10,
                  alignItems: "center",
                }}
              >
                <ZoneBadge zone={task.zone} status={task.assignmentStatus || task.taskStatus} />
                {task.overdue ? (
                  <span className="dgv-badge dgv-badge--danger">Overdue</span>
                ) : null}
              </div>
              <div className="dgv-task-card__meta">
                <span>
                  <strong>Project</strong> {task.projectId || "—"}
                </span>
                <span>
                  <strong>Task status</strong> {task.taskStatus || "—"}
                </span>
                <span>
                  <strong>Assignment</strong> {task.assignmentStatus || "—"}
                </span>
                <span>
                  <strong>Assigned</strong> {formatTaskDateTime(task.assignedAt)}
                </span>
                {task.completedAt ? (
                  <span>
                    <strong>Completed</strong> {formatTaskDateTime(task.completedAt)}
                  </span>
                ) : null}
                <span>
                  <strong>Start</strong> {formatTaskDateTime(task.startDate)}
                </span>
                <span>
                  <strong>Due</strong> {formatTaskDateTime(task.dueDate)}
                </span>
                {task.timing ? (
                  <span>
                    <strong>Timing</strong> {task.timing}
                  </span>
                ) : null}
              </div>
              <TaskActivityList
                activity={filterEmployeeTaskActivity(task.activity, employeeEmail)}
              />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export default function MyActivity() {
  const [date, setDate] = useState(() => todayKeyIST());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (day) => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchMyDayActivity(day);
      setData(result || null);
    } catch (err) {
      if (err?.status === 401 || /session expired/i.test(err?.message || "")) {
        return;
      }
      setError(err.message || "Unable to load activity.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(date);
  }, [date, load]);

  const employee = data?.employee;

  return (
    <Layout>
      <div style={pageCard}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >
          <div>
            <h2 style={{ ...pageTitle, marginBottom: 4 }}>My Activity</h2>
            <p style={{ ...pageSubtitle, marginBottom: 0 }}>
              {employee?.name || employee?.email
                ? [employee.name, employee.empId, employee.department]
                    .filter(Boolean)
                    .join(" · ")
                : "Task status, assignment, and activity for one day."}
            </p>
          </div>
          <label style={{ minWidth: 180, flex: "0 0 auto" }}>
            <span style={formLabel}>Date</span>
            <input
              type="date"
              aria-label="Date"
              style={{ ...formInput, marginBottom: 0 }}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
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

      {data ? (
        <TasksSection tasks={data.tasks} employeeEmail={employee?.email} />
      ) : !loading ? (
        <section style={sectionCard}>
          <p style={{ color: colors.textMuted, margin: 0 }}>
            No activity data for this day.
          </p>
        </section>
      ) : null}
    </Layout>
  );
}

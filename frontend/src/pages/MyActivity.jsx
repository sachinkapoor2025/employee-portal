import { useCallback, useEffect, useState } from "react";
import Layout from "../components/Layout";
import ZoneBadge from "../components/ZoneBadge";
import { attendancePunchDisplay, formatTime } from "../components/WeeklyAttendanceHistory";
import { fetchMyDayActivity } from "../services/api";
import { todayKeyIST } from "../utils/meetings";
import { formatTaskDateTime } from "../utils/taskStatus";
import {
  colors,
  formInput,
  formLabel,
  pageCard,
  pageSubtitle,
  pageTitle,
} from "../theme";

const COMPANY_TZ = "Asia/Kolkata";

const WORK_PERIOD_LABELS = {
  FULL_DAY: "Full Day",
  FIRST_HALF: "First Half",
  SECOND_HALF: "Second Half",
};

const STATUS_BADGE = {
  Working: "dgv-status-badge--working",
  Holiday: "dgv-status-badge--holiday",
  Leave: "dgv-status-badge--leave",
  WeeklyOff: "dgv-status-badge--weeklyoff",
};

const sectionCard = {
  ...pageCard,
  marginTop: 16,
};

const metaGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
};

const metaLabel = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--dgv-text-muted)",
  marginBottom: 4,
};

const metaValue = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--dgv-text)",
  wordBreak: "break-word",
};

function formatHm(hhmm) {
  if (!hhmm) return "—";
  const d = new Date(`1970-01-01T${hhmm}:00+05:30`);
  if (!Number.isFinite(d.getTime())) return hhmm;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: COMPANY_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function workPeriodLabel(attendance) {
  if (attendance?.workPeriod && WORK_PERIOD_LABELS[attendance.workPeriod]) {
    return WORK_PERIOD_LABELS[attendance.workPeriod];
  }
  return attendance?.workPeriod || "—";
}

function attendanceStatusLabel(attendance) {
  if (!attendance?.marked) return null;
  const status = String(attendance.status || "").trim();
  if (!status) return "Marked";
  if (status === "WeeklyOff") return "Weekly Off";
  return status;
}

function hasShift(shift) {
  return Boolean(shift?.name || shift?.shiftId || shift?.startTime || shift?.endTime);
}

function Meta({ label, children }) {
  return (
    <div>
      <div style={metaLabel}>{label}</div>
      <div style={metaValue}>{children}</div>
    </div>
  );
}

function ShiftSection({ shift }) {
  if (!hasShift(shift)) {
    return (
      <section style={sectionCard} aria-labelledby="my-activity-shift">
        <h3 id="my-activity-shift" style={{ marginTop: 0, marginBottom: 8 }}>
          Shift
        </h3>
        <p style={{ color: colors.textMuted, margin: 0 }}>No shift assigned</p>
      </section>
    );
  }
  return (
    <section style={sectionCard} aria-labelledby="my-activity-shift">
      <h3 id="my-activity-shift" style={{ marginTop: 0, marginBottom: 16 }}>
        Shift
      </h3>
      <div style={metaGrid}>
        <Meta label="Shift">{shift.name || shift.shiftId || "—"}</Meta>
        <Meta label="Start">{formatHm(shift.startTime)}</Meta>
        <Meta label="End">{formatHm(shift.endTime)}</Meta>
        {shift.crossesMidnight ? <Meta label="Overnight">Yes</Meta> : null}
      </div>
    </section>
  );
}

function AttendanceSection({ attendance }) {
  if (!attendance?.marked) {
    return (
      <section style={sectionCard} aria-labelledby="my-activity-attendance">
        <h3 id="my-activity-attendance" style={{ marginTop: 0, marginBottom: 8 }}>
          Attendance
        </h3>
        <p style={{ color: colors.textMuted, margin: 0 }}>
          No attendance recorded for this day.
        </p>
      </section>
    );
  }

  const statusLabel = attendanceStatusLabel(attendance);
  const punches = attendancePunchDisplay(attendance);
  const badgeClass = STATUS_BADGE[attendance.status] || "";
  const timing =
    attendance.timingStatus
      ? `${attendance.timingStatus}${
          attendance.timingStatus === "LATE" && attendance.lateMinutes != null
            ? ` · ${attendance.lateMinutes} min late`
            : ""
        }`
      : "—";

  return (
    <section style={sectionCard} aria-labelledby="my-activity-attendance">
      <h3 id="my-activity-attendance" style={{ marginTop: 0, marginBottom: 16 }}>
        Attendance
      </h3>
      <div style={metaGrid}>
        <Meta label="Status">
          <span className={`dgv-status-badge ${badgeClass}`.trim()}>
            {statusLabel}
          </span>
        </Meta>
        <Meta label="Work period">{workPeriodLabel(attendance)}</Meta>
        <Meta label="Expected start">
          {formatTime(attendance.expectedStartTime)}
        </Meta>
        <Meta label="Expected end">
          {formatTime(attendance.expectedEndTime)}
        </Meta>
        <Meta label="Actual check-in">
          {punches.inLabel}
        </Meta>
        <Meta label="Actual check-out">
          {punches.outLabel}
        </Meta>
        <Meta label="Timing">{timing}</Meta>
        <Meta label="Worked beyond shift">
          {attendance.workedBeyondShift ? "Yes" : "No"}
        </Meta>
      </div>
      {attendance.workedBeyondShift && attendance.workedBeyondReason ? (
        <p style={{ margin: "12px 0 0", fontSize: 13, color: colors.textMuted }}>
          Worked-beyond reason: {attendance.workedBeyondReason}
        </p>
      ) : null}
    </section>
  );
}

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

function TasksSection({ tasks }) {
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
              <TaskActivityList activity={task.activity} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function PresenceSection({ presence }) {
  const events = Array.isArray(presence?.events) ? presence.events : [];
  return (
    <section style={sectionCard} aria-labelledby="my-activity-presence">
      <h3 id="my-activity-presence" style={{ marginTop: 0, marginBottom: 8 }}>
        Portal presence
      </h3>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: "0 0 16px" }}>
        Portal presence, not working hours
      </p>
      <div style={metaGrid}>
        <Meta label="Last seen">
          {presence?.lastSeen ? formatTaskDateTime(presence.lastSeen) : "—"}
        </Meta>
        <Meta label="Event count">{Number(presence?.eventCount || 0)}</Meta>
      </div>
      {events.length === 0 ? (
        <p style={{ color: colors.textMuted, margin: "12px 0 0" }}>
          No portal presence events for this day.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
          {events.map((event, index) => (
            <li
              key={`${event.timestamp || "e"}-${index}`}
              style={{
                fontSize: 13,
                color: colors.textSecondary,
                padding: "6px 0",
                borderTop: "1px solid var(--dgv-border)",
              }}
            >
              <span style={{ fontWeight: 600, color: "var(--dgv-text)" }}>
                {formatTaskDateTime(event.timestamp)}
              </span>
              {event.type ? ` · ${event.type}` : ""}
              {event.page ? ` · ${event.page}` : ""}
              {event.device ? ` · ${event.device}` : ""}
            </li>
          ))}
        </ul>
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
                : "Attendance, tasks, and portal presence for one day."}
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
        <>
          <ShiftSection shift={data.shift} />
          <AttendanceSection attendance={data.attendance} />
          <TasksSection tasks={data.tasks} />
          <PresenceSection presence={data.presence} />
        </>
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

import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import { StatCard } from "../../components/ui/Card";
import {
  fetchUserProfile,
  fetchUsers,
  fetchAttendance,
  fetchTasks,
  fetchAllLeave,
  fetchEmployeeShift,
  fetchWeekOffState,
} from "../../services/api";
import { roleLabel } from "../../constants/roles";
import { colors, pageCard, pageTitle, pageSubtitle } from "../../theme";
import ZoneBadge from "../../components/ZoneBadge";
import { getWeeklyDisplayStatus } from "../../components/WeeklyAttendanceHistory";
import {
  COMPLIANCE,
  attendanceCompliance,
  formatInstant,
  lateByLabel,
} from "../../utils/attendanceCompliance";
import {
  formatTaskDateTime,
  getAssignmentZone,
  statusLabel,
} from "../../utils/taskStatus";
import {
  addDaysToKey,
  companyTodayKey,
  currentWeekStartKey,
  EMPTY_ATTENDANCE_METRICS,
  formatWeekRange,
  indexAttendanceByDate,
  startOfWeekKey,
  summarizeAttendanceWeek,
} from "../../utils/myActivityReport";
import { weekOffDisplay } from "../../utils/weekOffState";
import {
  buildEmployeeActivityTrend,
  EMPTY_WORK_METRICS,
  EMPTY_WORKLOAD_METRICS,
  summarizeEmployeeWorkloadWeek,
  summarizeEmployeeWorkWeek,
  trendPercentHint,
  trendRangeForSelectedWeek,
} from "../../utils/adminEmployeeActivity";

const TABS = [
  "Overview",
  "Attendance",
  "Tasks",
  "Documents",
  "Leave",
  "Training",
  "Performance",
  "Activity",
];

function ymd(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  return { start: ymd(start), end: ymd(end) };
}

function leaveOnDate(dateKey, leaves) {
  for (const leave of leaves || []) {
    const from = leave.fromDate || leave.startDate;
    const to = leave.toDate || leave.endDate || from;
    if (!from || !to) continue;
    const planned =
      leave.status === "PLANNED_OFF" || leave.category === "PLANNED_OFF";
    const approved = String(leave.status || "").toUpperCase() === "APPROVED";
    if (!planned && !approved) continue;
    if (dateKey >= from && dateKey <= to) {
      return planned ? "Planned Off" : "Leave";
    }
  }
  return null;
}

/**
 * Admin employee tracking — uses existing attendance, task, leave, and activity APIs.
 */
export default function EmployeeTracking() {
  const { email: rawEmail } = useParams();
  const [params, setParams] = useSearchParams();
  const email = decodeURIComponent(rawEmail || "").toLowerCase();
  const requestedTab = params.get("tab");
  const from = params.get("from");
  const [tab, setTab] = useState(
    TABS.includes(requestedTab) ? requestedTab : "Overview"
  );
  const selectTab = useCallback(
    (nextTab) => {
      if (!TABS.includes(nextTab)) return;
      setTab(nextTab);
      const next = new URLSearchParams(params);
      next.set("tab", nextTab);
      if (from) next.set("from", from);
      else next.delete("from");
      setParams(next, { replace: true });
    },
    [from, params, setParams]
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState(null);
  const [access, setAccess] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [leaveRows, setLeaveRows] = useState(null);
  const [assignedShift, setAssignedShift] = useState(null);
  const [shiftConflicts, setShiftConflicts] = useState(null);

  useEffect(() => {
    setTab(TABS.includes(requestedTab) ? requestedTab : "Overview");
  }, [email, requestedTab]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const [p, users, shiftResult] = await Promise.all([
          fetchUserProfile(email),
          fetchUsers(),
          fetchEmployeeShift(email).catch(() => ({ shift: null })),
        ]);
        if (cancelled) return;
        setProfile(p || {});
        setAccess(
          (Array.isArray(users) ? users : []).find(
            (u) => u.email?.toLowerCase() === email
          ) || null
        );
        setAssignedShift(shiftResult?.shift || null);
      } catch (err) {
        if (!cancelled) setError(err.message || "Failed to load employee");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email]);

  useEffect(() => {
    if (!email) return;
    if (!["Overview", "Attendance"].includes(tab)) return;
    let cancelled = false;
    const { start, end } = dateRange(14);
    Promise.all([
      fetchAttendance(start, end, email).catch(() => []),
      fetchAllLeave().catch(() => []),
    ]).then(([rows, leaves]) => {
      if (cancelled) return;
      const mine = (Array.isArray(leaves) ? leaves : []).filter(
        (l) => String(l.email || "").toLowerCase() === email
      );
      setLeaveRows(mine);
      setAttendance(Array.isArray(rows) ? rows : []);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, email]);

  useEffect(() => {
    if (!email) return;
    if (!["Overview", "Tasks"].includes(tab)) return;
    let cancelled = false;
    fetchTasks({ assignee: email, includePendingShiftConflicts: true })
      .then((list) => {
        if (cancelled) return;
        const rows = Array.isArray(list) ? list : [];
        const mine = rows.filter((t) => assignmentForEmployee(t, email));
        const assignedIds = new Set(mine.map((t) => t.taskId).filter(Boolean));
        const conflicts = rows.filter(
          (t) =>
            isTrackingShiftConflict(t, email) &&
            !assignedIds.has(t.taskId) &&
            !assignmentForEmployee(t, email)
        );
        setTasks(mine);
        setShiftConflicts(conflicts);
      })
      .catch(() => {
        if (!cancelled) {
          setTasks([]);
          setShiftConflicts([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tab, email]);

  useEffect(() => {
    if (!email) return;
    if (!["Overview", "Leave"].includes(tab)) return;
    if (leaveRows) return;
    let cancelled = false;
    fetchAllLeave()
      .then((leaves) => {
        if (cancelled) return;
        setLeaveRows(
          (Array.isArray(leaves) ? leaves : []).filter(
            (l) => String(l.email || "").toLowerCase() === email
          )
        );
      })
      .catch(() => {
        if (!cancelled) setLeaveRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, email, leaveRows]);

  return (
    <Layout>
      <div style={pageCard}>
        <p style={{ marginTop: 0 }}>
          <Link
            to={from === "activity" ? "/admin/activity" : "/admin/employees"}
            style={{ color: "var(--dgv-accent)" }}
          >
            {from === "activity" ? "← Back to Team Activity" : "← Back to Employees"}
          </Link>
        </p>

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading employee…</p>
        ) : error ? (
          <div className="dgv-alert dgv-alert--error">{error}</div>
        ) : (
          <>
            <h2 style={pageTitle}>{profile?.name || email}</h2>
            <p style={pageSubtitle}>
              {[profile?.empId, email, profile?.department, profile?.designation]
                .filter(Boolean)
                .join(" · ") || "Employee tracking"}
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: 10,
                marginBottom: 20,
              }}
            >
              <Meta label="Employee ID" value={profile?.empId} />
              <Meta label="Email" value={email} />
              <Meta label="Department" value={profile?.department} />
              <Meta label="Designation" value={profile?.designation} />
              <Meta label="Account Status" value={access?.status} />
              <Meta label="Role" value={roleLabel(access?.role)} />
            </div>

            <CurrentShiftSummary shift={assignedShift} />

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 20,
              }}
              role="tablist"
              aria-label="Employee tracking sections"
            >
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={`dgv-btn ${
                    tab === t ? "dgv-btn--primary" : "dgv-btn--outline"
                  }`}
                  style={{ padding: "8px 12px", fontSize: 13 }}
                  onClick={() => selectTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>

            <div
              role="tabpanel"
              style={{
                padding: 16,
                borderRadius: 12,
                border: `1px solid ${colors.border}`,
                background: "var(--dgv-surface-solid)",
              }}
            >
              {tab === "Overview" ? (
                <OverviewPanel
                  email={email}
                  attendance={attendance}
                  tasks={tasks}
                  leaveRows={leaveRows}
                  assignedShift={assignedShift}
                  skill={profile?.skill}
                  designation={profile?.designation}
                  onOpenTab={selectTab}
                />
              ) : tab === "Attendance" ? (
                <AttendancePanel
                  rows={attendance}
                  leaves={leaveRows}
                  assignedShift={assignedShift}
                />
              ) : tab === "Tasks" ? (
                <TasksPanel
                  rows={tasks}
                  conflicts={shiftConflicts}
                  email={email}
                  assignedShift={assignedShift}
                />
              ) : tab === "Documents" ? (
                <EmployeeDocumentsPanel email={email} />
              ) : tab === "Leave" ? (
                <LeavePanel rows={leaveRows} />
              ) : tab === "Training" ? (
                <TrainingPanel skill={profile?.skill} />
              ) : tab === "Performance" ? (
                <PerformancePanel
                  skill={profile?.skill}
                  designation={profile?.designation}
                />
              ) : (
                <ActivityPanel email={email} profile={profile} />
              )}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

function nextDateKey(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return ymd(new Date(y, m - 1, d + 1));
}

function overviewAttendanceMetrics(rows, leaves, assignedShift) {
  const byDate = {};
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    if (r.date) byDate[r.date] = r;
  });
  const { start, end } = dateRange(14);
  const todayKey = companyTodayKey();
  const metrics = {
    present: 0,
    onTime: 0,
    late: 0,
    leave: 0,
    weekOff: 0,
    todayStatus: "—",
  };
  let cursor = start;
  while (cursor <= end) {
    const rec = byDate[cursor] || null;
    const overlay = rec?.status ? null : leaveOnDate(cursor, leaves);
    const leaveLabel =
      overlay === "Planned Off"
        ? "Planned Off"
        : overlay === "On Leave" || overlay === "Leave"
          ? "On Leave"
          : overlay;
    let bucket = getWeeklyDisplayStatus(rec);
    if (!rec && overlay === "Leave") bucket = "Leave";
    if (!rec && overlay === "Planned Off") bucket = "Planned Off";
    const compliance = attendanceCompliance({
      dateKey: cursor,
      todayKey,
      record: rec,
      leaveLabel,
      shift: assignedShift,
      useAssignedShiftName: false,
    });
    if (cursor === todayKey) metrics.todayStatus = compliance.status;
    if (bucket === "Present") {
      metrics.present += 1;
      if (compliance.status === COMPLIANCE.ON_TIME) metrics.onTime += 1;
      if (compliance.status === COMPLIANCE.LATE) metrics.late += 1;
    } else if (bucket === "Leave") {
      metrics.leave += 1;
    } else if (bucket === "Planned Off" || bucket === "Weekly Off") {
      metrics.weekOff += 1;
    }
    cursor = nextDateKey(cursor);
  }
  return metrics;
}

function overviewTaskMetrics(tasks, email) {
  const metrics = {
    assigned: 0,
    inProgress: 0,
    completed: 0,
    underReview: 0,
    redZone: 0,
  };
  (Array.isArray(tasks) ? tasks : []).forEach((task) => {
    const mine = assignmentForEmployee(task, email);
    if (!mine || mine.removed) return;
    const status = String(mine.status || "").toUpperCase();
    if (status === "CANCELLED") return;
    metrics.assigned += 1;
    if (status === "IN_PROGRESS") metrics.inProgress += 1;
    if (status === "DONE") metrics.completed += 1;
    if (status === "REVIEW") metrics.underReview += 1;
    if (String(getAssignmentZone(mine, task.dueDate) || "").toUpperCase() === "RED") {
      metrics.redZone += 1;
    }
  });
  return metrics;
}

function overviewLeaveMetrics(rows, todayKey) {
  const metrics = { pending: 0, approved: 0, upcoming: 0 };
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const status = String(row.status || "").toUpperCase();
    const from = row.fromDate || row.startDate || "";
    if (status === "PENDING" || status === "PENDING_APPROVAL") metrics.pending += 1;
    if (status === "APPROVED") metrics.approved += 1;
    if (
      status !== "REJECTED" &&
      status !== "CANCELLED" &&
      from &&
      from >= todayKey
    ) {
      metrics.upcoming += 1;
    }
  });
  return metrics;
}

const overviewSectionStyle = {
  padding: "14px 16px",
  borderRadius: 12,
  border: `1px solid ${colors.border}`,
  background: "var(--dgv-surface-solid)",
  minWidth: 0,
  height: "fit-content",
};

const overviewMetricRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
  padding: "6px 8px",
  borderRadius: 8,
  background: colors.background,
};

function OverviewSection({ id, title, hint, viewLabel, onView, loading, children }) {
  return (
    <section aria-labelledby={id} style={overviewSectionStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "flex-start",
          marginBottom: hint ? 4 : 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h3 id={id} style={{ margin: 0, fontSize: 16 }}>
            {title}
          </h3>
          {hint ? (
            <p
              style={{
                ...pageSubtitle,
                margin: "4px 0 0",
                fontSize: 13,
              }}
            >
              {hint}
            </p>
          ) : null}
        </div>
        <Button type="button" variant="outline" onClick={onView}>
          {viewLabel}
        </Button>
      </div>
      {loading ? (
        <p style={{ color: colors.textMuted, margin: "8px 0 0" }}>Loading…</p>
      ) : (
        children
      )}
    </section>
  );
}

function OverviewMetrics({ items }) {
  return (
    <div
      style={{
        display: "grid",
        gap: 4,
        marginTop: 4,
      }}
    >
      {items.map(({ label, value }) => (
        <div key={label} role="group" aria-label={label} style={overviewMetricRowStyle}>
          <span
            style={{
              fontSize: 13,
              color: colors.textMuted,
              fontWeight: 600,
            }}
          >
            {label}
          </span>
          <strong
            style={{
              fontSize: 16,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              color: colors.text,
            }}
          >
            {value}
          </strong>
        </div>
      ))}
    </div>
  );
}

function OverviewField({ label, children }) {
  return (
    <div style={{ marginTop: 8 }}>
      <p
        style={{
          margin: "0 0 2px",
          fontSize: 13,
          fontWeight: 600,
          color: colors.textMuted,
        }}
      >
        {label}
      </p>
      <p style={{ margin: 0, fontSize: 14, color: colors.text }}>{children}</p>
    </div>
  );
}

function OverviewPanel({
  email,
  attendance,
  tasks,
  leaveRows,
  assignedShift,
  skill,
  designation,
  onOpenTab,
}) {
  const todayKey = companyTodayKey();
  const attendanceMetrics = overviewAttendanceMetrics(
    attendance,
    leaveRows,
    assignedShift
  );
  const taskMetrics = overviewTaskMetrics(tasks, email);
  const leaveMetrics = overviewLeaveMetrics(leaveRows, todayKey);
  const weekStart = currentWeekStartKey();
  const getAssignment = (task) => assignmentForEmployee(task, email);
  const activityWorkload = summarizeEmployeeWorkloadWeek({
    tasks: tasks || [],
    weekStart,
    getAssignment,
  });
  const activityWork = summarizeEmployeeWorkWeek({
    tasks: tasks || [],
    weekStart,
    getAssignment,
  });
  const activityAttendance = summarizeAttendanceWeek({
    weekStart,
    recordsByDate: indexAttendanceByDate(attendance || []),
    todayKey,
  });

  return (
    <>
      <style>{`
        .employee-overview-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 16px;
          align-items: start;
        }
        .employee-overview-activity {
          grid-column: 1 / -1;
        }
        .employee-overview-activity-metrics {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 8px 24px;
        }
        @media (min-width: 720px) {
          .employee-overview-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .employee-overview-activity-metrics {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (min-width: 1100px) {
          .employee-overview-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }
      `}</style>
      <h3 style={{ marginTop: 0, marginBottom: 16 }}>Overview</h3>
      <div className="employee-overview-grid">
        <OverviewSection
          id="overview-attendance"
          title="Attendance"
          hint={`Last 14 days · Today: ${attendanceMetrics.todayStatus}`}
          viewLabel="View Attendance →"
          onView={() => onOpenTab("Attendance")}
          loading={!attendance}
        >
          <OverviewMetrics
            items={[
              { label: "Present", value: attendanceMetrics.present },
              { label: "On Time", value: attendanceMetrics.onTime },
              { label: "Late", value: attendanceMetrics.late },
              { label: "Leave", value: attendanceMetrics.leave },
              { label: "Week Off", value: attendanceMetrics.weekOff },
            ]}
          />
        </OverviewSection>

        <OverviewSection
          id="overview-tasks"
          title="Tasks"
          viewLabel="View Tasks →"
          onView={() => onOpenTab("Tasks")}
          loading={!tasks}
        >
          <OverviewMetrics
            items={[
              { label: "Assigned", value: taskMetrics.assigned },
              { label: "In Progress", value: taskMetrics.inProgress },
              { label: "Completed", value: taskMetrics.completed },
              { label: "Under Review", value: taskMetrics.underReview },
              { label: "Red Zone", value: taskMetrics.redZone },
            ]}
          />
        </OverviewSection>

        <OverviewSection
          id="overview-leave"
          title="Leave"
          viewLabel="View Leave →"
          onView={() => onOpenTab("Leave")}
          loading={!leaveRows}
        >
          <OverviewMetrics
            items={[
              { label: "Pending", value: leaveMetrics.pending },
              { label: "Approved", value: leaveMetrics.approved },
              { label: "Upcoming", value: leaveMetrics.upcoming },
            ]}
          />
        </OverviewSection>

        <OverviewSection
          id="overview-documents"
          title="Documents"
          viewLabel="View Documents →"
          onView={() => onOpenTab("Documents")}
        >
          <OverviewField label="Personal documents">
            Available in Documents → Personal.
          </OverviewField>
          <OverviewField label="Required Documents">
            Pinned storage only. No verify/reject workflow.
          </OverviewField>
        </OverviewSection>

        <OverviewSection
          id="overview-training"
          title="Training"
          viewLabel="View Training →"
          onView={() => onOpenTab("Training")}
        >
          <OverviewField label="Assigned Skill">
            {skill || "—"}
          </OverviewField>
        </OverviewSection>

        <OverviewSection
          id="overview-performance"
          title="Performance"
          viewLabel="View Performance →"
          onView={() => onOpenTab("Performance")}
        >
          <OverviewMetrics
            items={[
              { label: "Designation", value: designation || "—" },
              { label: "Skill", value: skill || "—" },
            ]}
          />
        </OverviewSection>

        <div className="employee-overview-activity">
          <OverviewSection
            id="overview-activity"
            title="Activity"
            hint={`Current Week · ${formatWeekRange(weekStart)}`}
            viewLabel="View Activity →"
            onView={() => onOpenTab("Activity")}
            loading={!tasks || !attendance}
          >
            <div className="employee-overview-activity-metrics">
              <OverviewMetrics
                items={[
                  { label: "Assigned", value: activityWorkload.assigned },
                  { label: "Completed", value: activityWork.completed },
                  { label: "Under Review", value: activityWork.underReview },
                  { label: "Red Zone", value: activityWork.redZone },
                ]}
              />
              <OverviewMetrics
                items={[
                  { label: "Present", value: activityAttendance.present },
                  { label: "On Time", value: activityAttendance.onTime },
                  { label: "Late", value: activityAttendance.late },
                ]}
              />
            </div>
          </OverviewSection>
        </div>
      </div>
    </>
  );
}

function AttendancePanel({ rows, leaves, assignedShift }) {
  if (!rows) {
    return (
      <>
        <h3 style={{ marginTop: 0 }}>Attendance</h3>
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          Loading attendance…
        </p>
      </>
    );
  }
  const byDate = {};
  rows.forEach((r) => {
    if (r.date) byDate[r.date] = r;
  });
  const { start, end } = dateRange(14);
  const todayKey = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
  const days = [];
  let cursor = start;
  while (cursor <= end) {
    const rec = byDate[cursor] || null;
    const overlay = rec?.status ? null : leaveOnDate(cursor, leaves);
    const leaveLabel =
      overlay === "Planned Off"
        ? "Planned Off"
        : overlay === "On Leave" || overlay === "Leave"
          ? "On Leave"
          : overlay;
    const compliance = attendanceCompliance({
      dateKey: cursor,
      todayKey,
      record: rec,
      leaveLabel,
      shift: assignedShift,
      useAssignedShiftName: false,
    });
    days.push({ date: cursor, rec, display: compliance.status, compliance });
    const [y, m, d] = cursor.split("-").map(Number);
    const next = new Date(y, m - 1, d + 1);
    cursor = ymd(next);
  }
  days.reverse();
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Attendance</h3>
      <div className="dgv-table-wrap">
        <table className="dgv-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shift</th>
              <th>Status</th>
              <th>Marked At</th>
              <th>Expected By</th>
              <th>Late By</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date}>
                <td>{d.date}</td>
                <td>{d.compliance.shiftLabel || "—"}</td>
                <td>{d.display}</td>
                <td>
                  {d.compliance.markedAtMs
                    ? formatInstant(d.compliance.markedAtMs)
                    : "—"}
                </td>
                <td>
                  {d.compliance.expectedByMs
                    ? formatInstant(d.compliance.expectedByMs)
                    : "—"}
                </td>
                <td>
                  {d.display === COMPLIANCE.LATE
                    ? lateByLabel(d.compliance.lateMinutes) || "—"
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function normalizeTrackingEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/** Non-removed assignment row for the tracked employee. Never uses assignee[0]. */
export function assignmentForEmployee(task, email) {
  const target = normalizeTrackingEmail(email);
  if (!target || !task) return null;
  const rows = Array.isArray(task.assignments) ? task.assignments : [];
  return (
    rows.find(
      (row) =>
        row && !row.removed && normalizeTrackingEmail(row.email) === target
    ) || null
  );
}

function pendingIncludesEmployee(task, email) {
  const target = normalizeTrackingEmail(email);
  if (!target || !task) return false;
  return (task.pendingAssignees || []).some(
    (value) => normalizeTrackingEmail(value) === target
  );
}

function shiftFitForEmployee(task, email) {
  const target = normalizeTrackingEmail(email);
  const map = task?.lastShiftFitByEmail || {};
  if (map[target]) return String(map[target]).toUpperCase();
  const hit = Object.entries(map).find(
    ([key]) => normalizeTrackingEmail(key) === target
  );
  return hit ? String(hit[1]).toUpperCase() : "";
}

export function isTrackingShiftConflict(task, email) {
  if (!task || task.archived) return false;
  if (!pendingIncludesEmployee(task, email)) return false;
  const fit = shiftFitForEmployee(task, email);
  return fit === "SHIFT_CONFLICT" || fit === "NO_SHIFT";
}

function conflictTypeLabel(fit) {
  if (fit === "NO_SHIFT") return "No Shift Assigned";
  if (fit === "SHIFT_CONFLICT") return "Shift Conflict";
  return fit || "—";
}

function assignmentOverdue(assignment) {
  if (assignment?.overdue === true) return true;
  const zone = String(assignment?.zone || "").toUpperCase();
  return zone === "ORANGE" || zone === "RED";
}

function UnresolvedShiftConflictsSection({ rows, email, assignedShift }) {
  const list = Array.isArray(rows) ? rows : [];
  if (!rows) return null;
  if (list.length === 0) return null;
  return (
    <section
      aria-labelledby="tracking-shift-conflicts"
      style={{ marginBottom: 24 }}
    >
      <h3 id="tracking-shift-conflicts" style={{ marginTop: 0, marginBottom: 8 }}>
        Unresolved shift conflicts
      </h3>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: "0 0 12px" }}>
        These scheduled tasks are not assigned. Open a task to edit or reassign.
      </p>
      <div style={{ display: "grid", gap: 12 }}>
        {list.map((task) => {
          const fit = shiftFitForEmployee(task, email);
          const title = task.title || task.taskId || "Task";
          const headingId = `shift-conflict-${task.taskId || title}`;
          return (
            <article
              key={task.taskId || title}
              aria-labelledby={headingId}
              style={{
                padding: 12,
                borderRadius: 12,
                border: `1px solid ${colors.border}`,
                background: "var(--dgv-surface-solid)",
              }}
            >
              <h4 id={headingId} style={{ margin: "0 0 8px", fontSize: 16 }}>
                {task.taskId ? (
                  <Link
                    to={`/admin/tasks/${encodeURIComponent(task.taskId)}`}
                    style={{ color: "var(--dgv-accent)", fontWeight: 700 }}
                  >
                    {title}
                  </Link>
                ) : (
                  title
                )}
              </h4>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                  gap: 10,
                }}
              >
                <Meta label="Project" value={task.projectId} />
                <Meta label="Employee" value={email} />
                <Meta label="Conflict type" value={conflictTypeLabel(fit)} />
                <Meta label="Start" value={formatTaskDateTime(task.startDate)} />
                <Meta
                  label="Due"
                  value={formatTaskDateTime(task.dueDate || task.endDate)}
                />
              </div>
              {fit === "NO_SHIFT" ? (
                <p style={{ color: colors.textMuted, fontSize: 13, margin: "10px 0 0" }}>
                  This employee has no applicable assigned shift for this task.
                </p>
              ) : assignedShift?.name || assignedShift?.startTime ? (
                <p style={{ color: colors.textMuted, fontSize: 13, margin: "10px 0 0" }}>
                  Current assigned shift: {assignedShift.name || assignedShift.shiftId}
                  {assignedShift.startTime || assignedShift.endTime
                    ? ` · ${formatHm(assignedShift.startTime)} — ${formatHm(
                        assignedShift.endTime
                      )}${assignedShift.crossesMidnight ? " (overnight)" : ""}`
                    : ""}
                </p>
              ) : null}
              {task.taskId ? (
                <p style={{ margin: "10px 0 0" }}>
                  <Link
                    to={`/admin/tasks/${encodeURIComponent(task.taskId)}`}
                    style={{ color: "var(--dgv-accent)", fontWeight: 600, fontSize: 13 }}
                  >
                    Edit / Reassign
                  </Link>
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function TasksPanel({ rows, conflicts, email, assignedShift }) {
  if (!rows) {
    return (
      <>
        <h3 style={{ marginTop: 0 }}>Tasks</h3>
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>Loading tasks…</p>
      </>
    );
  }
  return (
    <>
      <UnresolvedShiftConflictsSection
        rows={conflicts || []}
        email={email}
        assignedShift={assignedShift}
      />
      <h3 style={{ marginTop: 0 }}>Tasks</h3>
      {rows.length === 0 ? (
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          {conflicts?.length
            ? "No normally assigned tasks."
            : "No tasks assigned to this employee."}
        </p>
      ) : (
        <div className="dgv-table-wrap">
          <table className="dgv-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Project</th>
                <th>Task status</th>
                <th>Assignment</th>
                <th>Schedule</th>
                <th>Zone</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const mine = assignmentForEmployee(t, email);
                const zone = getAssignmentZone(mine, t.dueDate);
                const timing = mine?.timing || "";
                const overdue = assignmentOverdue(mine);
                const title = t.title || t.taskId || "—";
                return (
                  <tr key={t.taskId || t.title}>
                    <td>
                      {t.taskId ? (
                        <Link
                          to={`/admin/tasks/${encodeURIComponent(t.taskId)}`}
                          style={{ color: "var(--dgv-accent)", fontWeight: 700 }}
                        >
                          {title}
                        </Link>
                      ) : (
                        title
                      )}
                    </td>
                    <td>{t.projectId || "—"}</td>
                    <td>{statusLabel(t.status || t.taskStatus)}</td>
                    <td>
                      <div>{statusLabel(mine?.status)}</div>
                      <div style={{ fontSize: 12, color: colors.textMuted }}>
                        Assigned {formatTaskDateTime(mine?.assignedAt)}
                      </div>
                      {mine?.completedAt ? (
                        <div style={{ fontSize: 12, color: colors.textMuted }}>
                          Completed {formatTaskDateTime(mine.completedAt)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div style={{ fontSize: 12 }}>
                        Start {formatTaskDateTime(t.startDate)}
                      </div>
                      <div style={{ fontSize: 12 }}>
                        Due {formatTaskDateTime(t.dueDate)}
                      </div>
                    </td>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        <ZoneBadge zone={zone} status={mine?.status} />
                        {overdue ? (
                          <span className="dgv-badge dgv-badge--danger">Overdue</span>
                        ) : null}
                      </div>
                      {timing ? (
                        <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
                          {timing}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function LeavePanel({ rows }) {
  if (!rows) {
    return (
      <>
        <h3 style={{ marginTop: 0 }}>Leave</h3>
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>Loading leave…</p>
      </>
    );
  }
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Leave</h3>
      {rows.length === 0 ? (
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          No leave or planned-off records for this employee.
        </p>
      ) : (
        <div className="dgv-table-wrap">
          <table className="dgv-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>From</th>
                <th>To</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.leaveId || `${l.fromDate}-${l.type}`}>
                  <td>
                    {l.category === "PLANNED_OFF" || l.type === "PLANNED_OFF"
                      ? "Planned Off"
                      : l.type || "Leave"}
                  </td>
                  <td>{l.fromDate || l.startDate || "—"}</td>
                  <td>{l.toDate || l.endDate || "—"}</td>
                  <td>{l.status || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function TrainingPanel({ skill }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Training</h3>
      <p style={{ color: colors.textMuted, marginBottom: 0 }}>
        {skill
          ? `Assigned skill: ${skill}. Training materials for this skill are listed on the Training page.`
          : "No skill is set on this employee’s profile, so no training assignment is available."}
      </p>
    </>
  );
}

function PerformancePanel({ skill, designation }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Performance</h3>
      <p style={{ color: colors.textMuted, marginBottom: 0 }}>
        {[designation && `Designation: ${designation}`, skill && `Skill: ${skill}`]
          .filter(Boolean)
          .join(" · ") || "No performance details are stored for this employee yet."}
      </p>
    </>
  );
}

function metricNumber(metrics, key) {
  const value = metrics?.[key];
  return Number.isFinite(value) ? value : 0;
}

function trendComparison(trend, key, current) {
  if (!trend?.ready) return "—";
  return trendPercentHint(current, trend.averages?.[key]) || "—";
}

function ActivityPanel({ email, profile }) {
  const [weekStart, setWeekStart] = useState(() => currentWeekStartKey());
  const [attendanceMetrics, setAttendanceMetrics] = useState(
    EMPTY_ATTENDANCE_METRICS
  );
  const [workloadMetrics, setWorkloadMetrics] = useState(EMPTY_WORKLOAD_METRICS);
  const [workMetrics, setWorkMetrics] = useState(EMPTY_WORK_METRICS);
  const [trend, setTrend] = useState({ ready: false, averages: null });
  const [weekOffState, setWeekOffState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (mondayKey) => {
      setLoading(true);
      setError("");
      const selected = startOfWeekKey(mondayKey);
      const range = trendRangeForSelectedWeek(selected);
      const getAssignment = (task) => assignmentForEmployee(task, email);
      try {
        const [attendanceRows, taskList, weekOff] = await Promise.all([
          fetchAttendance(range.rangeStart, range.rangeEnd, email),
          fetchTasks({ assignee: email }),
          fetchWeekOffState({ weekStart: selected, email }),
        ]);
        const tasks = Array.isArray(taskList) ? taskList : [];
        const recordsByDate = indexAttendanceByDate(attendanceRows);
        const attendance = summarizeAttendanceWeek({
          weekStart: selected,
          recordsByDate,
        });
        const workload = summarizeEmployeeWorkloadWeek({
          tasks,
          weekStart: selected,
          getAssignment,
        });
        const work = summarizeEmployeeWorkWeek({
          tasks,
          weekStart: selected,
          getAssignment,
        });
        setAttendanceMetrics(attendance);
        setWorkloadMetrics(workload);
        setWorkMetrics(work);
        setWeekOffState(weekOff && typeof weekOff === "object" ? weekOff : null);
        setTrend(
          buildEmployeeActivityTrend({
            selectedWeekStart: selected,
            recordsByDate,
            tasks,
            getAssignment,
          })
        );
      } catch (err) {
        if (err?.status === 401 || /session expired/i.test(err?.message || "")) {
          return;
        }
        setAttendanceMetrics(EMPTY_ATTENDANCE_METRICS);
        setWorkloadMetrics(EMPTY_WORKLOAD_METRICS);
        setWorkMetrics(EMPTY_WORK_METRICS);
        setWeekOffState(null);
        setTrend({ ready: false, averages: null });
        setError(err.message || "Unable to load activity.");
      } finally {
        setLoading(false);
      }
    },
    [email]
  );

  useEffect(() => {
    load(weekStart);
  }, [weekStart, load]);

  const weekRange = formatWeekRange(weekStart);
  const employeeLine = [profile?.name, profile?.empId, profile?.department]
    .filter(Boolean)
    .join(" · ");
  const present = metricNumber(attendanceMetrics, "present");
  const onTime = metricNumber(attendanceMetrics, "onTime");
  const late = metricNumber(attendanceMetrics, "late");
  const assigned = metricNumber(workloadMetrics, "assigned");
  const high = metricNumber(workloadMetrics, "high");
  const critical = metricNumber(workloadMetrics, "critical");
  const highCritical = metricNumber(workloadMetrics, "highCritical");
  const completed = metricNumber(workMetrics, "completed");
  const timeOff = weekOffDisplay(weekOffState);

  return (
    <>
      <div className="dgv-weekly-attendance__header">
        <div>
          <h3 id="employee-activity-title" style={{ marginTop: 0, marginBottom: 4 }}>
            Employee Activity
          </h3>
          <p
            style={{ ...pageSubtitle, marginBottom: 0 }}
            aria-label="Selected week"
          >
            {weekRange}
          </p>
          {employeeLine ? (
            <p style={{ ...pageSubtitle, margin: "8px 0 0" }}>{employeeLine}</p>
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

      <section aria-labelledby="employee-activity-attendance" style={{ marginTop: 20 }}>
        <h3 id="employee-activity-attendance" style={{ marginTop: 0, marginBottom: 8 }}>
          Attendance
        </h3>
        <div className="dgv-kpi-grid dgv-kpi-grid--3">
          <StatCard
            label="Present"
            value={present}
            hint={trendPercentHint(present, trend.averages?.present)}
          />
          <StatCard
            label="On Time"
            value={onTime}
            hint={trendPercentHint(onTime, trend.averages?.onTime)}
          />
          <StatCard
            label="Late"
            value={late}
            hint={trendPercentHint(late, trend.averages?.late)}
          />
          <StatCard label="Leave" value={metricNumber(attendanceMetrics, "leave")} />
          <StatCard
            label="Week Off"
            value={metricNumber(attendanceMetrics, "weekOff")}
          />
          <StatCard
            label="Not Marked"
            value={metricNumber(attendanceMetrics, "notMarked")}
          />
        </div>
      </section>

      <section aria-labelledby="employee-activity-time-off" style={{ marginTop: 20 }}>
        <h3 id="employee-activity-time-off" style={{ marginTop: 0, marginBottom: 8 }}>
          TIME OFF
        </h3>
        <div className="dgv-kpi-grid dgv-kpi-grid--3">
          <StatCard label="Week Off Entitlement" value={timeOff.entitlement} />
          <StatCard label="Week Off Used" value={timeOff.weekOffUsedLabel} />
          <StatCard label="Leave Used" value={timeOff.leaveUsed} />
          <StatCard label="Balance" value={timeOff.balance} />
        </div>
      </section>

      <section aria-labelledby="employee-activity-workload">
        <h3 id="employee-activity-workload" style={{ marginTop: 0, marginBottom: 8 }}>
          Workload
        </h3>
        <div className="dgv-kpi-grid dgv-kpi-grid--3">
          <StatCard
            label="Assigned"
            value={assigned}
            hint={
              trendPercentHint(assigned, trend.averages?.assigned) ||
              "Assigned work for this week"
            }
          />
          <StatCard
            label="High"
            value={high}
            hint={trendPercentHint(high, trend.averages?.high)}
          />
          <StatCard
            label="Critical"
            value={critical}
            hint={trendPercentHint(critical, trend.averages?.critical)}
          />
          <StatCard label="Medium" value={metricNumber(workloadMetrics, "medium")} />
          <StatCard label="Low" value={metricNumber(workloadMetrics, "low")} />
          <StatCard
            label="High + Critical"
            value={highCritical}
            hint={trendPercentHint(highCritical, trend.averages?.highCritical)}
          />
        </div>
      </section>

      <section aria-labelledby="employee-activity-work">
        <h3 id="employee-activity-work" style={{ marginTop: 0, marginBottom: 8 }}>
          Work
        </h3>
        <div className="dgv-kpi-grid">
          <StatCard
            label="Completed"
            value={completed}
            hint={trendPercentHint(completed, trend.averages?.completed)}
          />
          <StatCard
            label="Under Review"
            value={metricNumber(workMetrics, "underReview")}
          />
          <StatCard
            label="Red Zone"
            value={metricNumber(workMetrics, "redZone")}
          />
          <StatCard
            label="High Priority Red"
            value={metricNumber(workMetrics, "highPriorityRed")}
          />
        </div>
      </section>

      <section aria-labelledby="employee-activity-trend">
        <h3 id="employee-activity-trend" style={{ marginTop: 0, marginBottom: 8 }}>
          Trend
        </h3>
        <p style={{ ...pageSubtitle, marginBottom: 12 }}>
          Current week vs previous 4 completed weeks
        </p>
        <div className="dgv-table-wrap">
          <table className="dgv-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>This week</th>
                <th>vs 4-week average</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Present", present, "present"],
                ["On Time", onTime, "onTime"],
                ["Late", late, "late"],
                ["Assigned", assigned, "assigned"],
                ["High", high, "high"],
                ["Critical", critical, "critical"],
                ["High + Critical", highCritical, "highCritical"],
                ["Completed", completed, "completed"],
              ].map(([label, value, key]) => (
                <tr key={key}>
                  <td>{label}</td>
                  <td>{value}</td>
                  <td>{trendComparison(trend, key, value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function formatHm(hhmm) {
  if (!hhmm) return "—";
  const d = new Date(`1970-01-01T${hhmm}:00+05:30`);
  if (!Number.isFinite(d.getTime())) return hhmm;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function hasAssignedShift(shift) {
  return Boolean(shift?.name || shift?.shiftId || shift?.startTime || shift?.endTime);
}

function CurrentShiftSummary({ shift }) {
  return (
    <section
      aria-labelledby="tracking-current-shift"
      style={{
        marginBottom: 20,
        padding: 16,
        borderRadius: 12,
        border: `1px solid ${colors.border}`,
        background: "var(--dgv-surface-solid)",
      }}
    >
      <h3 id="tracking-current-shift" style={{ marginTop: 0, marginBottom: 12 }}>
        Current assigned shift
      </h3>
      {!hasAssignedShift(shift) ? (
        <p style={{ color: colors.textMuted, margin: 0 }}>No shift assigned</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 10,
          }}
        >
          <Meta label="Shift" value={shift.name || shift.shiftId} />
          <Meta label="Start" value={formatHm(shift.startTime)} />
          <Meta
            label="End"
            value={
              shift.crossesMidnight
                ? `${formatHm(shift.endTime)} (next day)`
                : formatHm(shift.endTime)
            }
          />
          {shift.graceMinutes != null && shift.graceMinutes !== "" ? (
            <Meta label="Grace" value={`${Number(shift.graceMinutes) || 0} min`} />
          ) : null}
          {shift.crossesMidnight ? (
            <Meta label="Overnight" value="Yes" />
          ) : null}
        </div>
      )}
    </section>
  );
}

function Meta({ label, value }) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 12,
        border: "1px solid var(--dgv-border)",
        background: "var(--dgv-surface-solid)",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--dgv-text-muted)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontWeight: 700,
          fontSize: 13,
          lineHeight: 1.35,
          overflowWrap: "anywhere",
          wordBreak: "break-word",
          maxWidth: "100%",
        }}
        title={value || undefined}
      >
        {value || "—"}
      </div>
    </div>
  );
}

function EmployeeDocumentsPanel({ email }) {
  const folderPath = `/admin/documents?tab=personal&email=${encodeURIComponent(
    email || ""
  )}`;
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Documents</h3>
      <p style={{ color: colors.textMuted }}>
        This employee&apos;s files live in Documents → Personal. Required
        Documents is pinned storage only — there is no verify or reject status.
      </p>
      <Link to={folderPath} className="dgv-btn dgv-btn--primary">
        Open personal folder
      </Link>
    </>
  );
}

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import Layout from "../../components/Layout";
import {
  fetchUserProfile,
  fetchUsers,
  fetchAttendance,
  fetchTasks,
  fetchAllLeave,
  fetchAdminActivity,
  fetchEmployeeShift,
  fetchTaskActivity,
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
  friendlyActivityText,
  getAssignmentZone,
  statusLabel,
} from "../../utils/taskStatus";

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

function formatWhen(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return String(iso);
  return new Date(t).toLocaleString();
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

async function loadEmployeeActivity(email) {
  const primary = await fetchAdminActivity(undefined, email);
  let events = Array.isArray(primary?.events) ? primary.events : [];
  events = events.filter(
    (e) => !e.email || String(e.email).toLowerCase() === email
  );
  if (primary?.email && String(primary.email).toLowerCase() === email) {
    return { events, summary: primary.summary || null };
  }
  const extraDates = [];
  const today = new Date();
  for (let i = 1; i < 7; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    extraDates.push(ymd(d));
  }
  const more = await Promise.all(
    extraDates.map((d) => fetchAdminActivity(d).catch(() => ({ events: [] })))
  );
  const extra = more.flatMap((r) =>
    (r?.events || []).filter((e) => String(e.email || "").toLowerCase() === email)
  );
  const merged = [...events, ...extra].sort((a, b) =>
    String(b.timestamp || "").localeCompare(String(a.timestamp || ""))
  );
  return { events: merged, summary: null };
}

/**
 * Admin employee tracking — uses existing attendance, task, leave, and activity APIs.
 */
export default function EmployeeTracking() {
  const { email: rawEmail } = useParams();
  const [params] = useSearchParams();
  const email = decodeURIComponent(rawEmail || "").toLowerCase();
  const requestedTab = params.get("tab");
  const from = params.get("from");
  const [tab, setTab] = useState(
    TABS.includes(requestedTab) ? requestedTab : "Overview"
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState(null);
  const [access, setAccess] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [leaveRows, setLeaveRows] = useState(null);
  const [activity, setActivity] = useState(null);
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
    if (!["Overview", "Tasks", "Activity"].includes(tab)) return;
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

  useEffect(() => {
    if (tab !== "Activity" && tab !== "Overview") return;
    if (!email) return;
    let cancelled = false;
    loadEmployeeActivity(email)
      .then((res) => {
        if (!cancelled) setActivity(res);
      })
      .catch(() => {
        if (!cancelled) setActivity({ events: [], summary: null });
      });
    return () => {
      cancelled = true;
    };
  }, [tab, email]);

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
                  onClick={() => setTab(t)}
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
                  attendance={attendance}
                  tasks={tasks}
                  leaveRows={leaveRows}
                  activity={activity}
                  skill={profile?.skill}
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
                <ActivityPanel data={activity} tasks={tasks} email={email} />
              )}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

function OverviewPanel({ attendance, tasks, leaveRows, activity, skill }) {
  const present = (attendance || []).filter((r) => {
    const s = getWeeklyDisplayStatus(r);
    return s === "Present";
  }).length;
  const openTasks = (tasks || []).filter((t) => {
    const s = String(t.status || "").toUpperCase();
    return s !== "DONE" && s !== "CANCELLED";
  }).length;
  const events = activity?.events?.length ?? null;
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Overview</h3>
      <p style={{ color: colors.textMuted }}>
        Last 14 days present: {attendance ? present : "…"} · Open tasks:{" "}
        {tasks ? openTasks : "…"} · Leave records:{" "}
        {leaveRows ? leaveRows.length : "…"} · Activity events:{" "}
        {events == null ? "…" : events}
        {skill ? ` · Skill: ${skill}` : ""}
      </p>
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

function presenceLastSeen(data) {
  const events = data?.events || [];
  let latest = data?.lastSeen || data?.summary?.lastSeen || "";
  for (const ev of events) {
    if (ev?.timestamp && (!latest || String(ev.timestamp) > String(latest))) {
      latest = ev.timestamp;
    }
  }
  return latest;
}

function presenceEventCount(data) {
  const events = data?.events || [];
  if (events.length) return events.length;
  const counted = Number(data?.summary?.eventCount);
  return Number.isFinite(counted) ? counted : 0;
}

function PortalPresenceSection({ data }) {
  if (!data) {
    return (
      <section aria-labelledby="tracking-portal-presence">
        <h3 id="tracking-portal-presence" style={{ marginTop: 0 }}>
          Portal presence
        </h3>
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          Loading portal presence…
        </p>
      </section>
    );
  }
  const events = data.events || [];
  const lastSeen = presenceLastSeen(data);
  const eventCount = presenceEventCount(data);
  return (
    <section aria-labelledby="tracking-portal-presence" style={{ marginBottom: 28 }}>
      <h3 id="tracking-portal-presence" style={{ marginTop: 0, marginBottom: 8 }}>
        Portal presence
      </h3>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: "0 0 16px" }}>
        Portal presence is not working hours.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <Meta label="Last seen" value={lastSeen ? formatWhen(lastSeen) : "—"} />
        <Meta label="Event count" value={String(eventCount)} />
      </div>
      {events.length === 0 ? (
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          No portal presence events recorded for this employee yet.
        </p>
      ) : (
        <div className="dgv-table-wrap">
          <table className="dgv-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Page</th>
                <th>Device</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.SK || `${ev.timestamp}-${ev.type}`}>
                  <td>{formatWhen(ev.timestamp)}</td>
                  <td>{ev.type || "—"}</td>
                  <td>{ev.page || "—"}</td>
                  <td>{ev.device || "—"}</td>
                  <td>{ev.location || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function normalizeActivityList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.activity)) return payload.activity;
  return [];
}

function activityForEmployee(events, email) {
  const target = normalizeTrackingEmail(email);
  return (events || []).filter((ev) => {
    const assigned = normalizeTrackingEmail(ev?.assignmentEmail);
    if (assigned) return assigned === target;
    return true;
  });
}

function TaskActivitySection({ tasks, email }) {
  const [byTask, setByTask] = useState(null);

  useEffect(() => {
    if (!tasks) {
      setByTask(null);
      return undefined;
    }
    let cancelled = false;
    Promise.all(
      tasks.map((task) => {
        if (!task?.taskId) {
          return Promise.resolve({ task, events: [] });
        }
        return fetchTaskActivity(task.taskId)
          .then((rows) => ({
            task,
            events: activityForEmployee(normalizeActivityList(rows), email).sort(
              (a, b) =>
                String(b.timestamp || "").localeCompare(String(a.timestamp || ""))
            ),
          }))
          .catch(() => ({ task, events: [] }));
      })
    ).then((list) => {
      if (!cancelled) setByTask(list);
    });
    return () => {
      cancelled = true;
    };
  }, [tasks, email]);

  return (
    <section aria-labelledby="tracking-task-activity">
      <h3 id="tracking-task-activity" style={{ marginTop: 0, marginBottom: 8 }}>
        Task activity
      </h3>
      {!tasks || !byTask ? (
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          Loading task activity…
        </p>
      ) : byTask.length === 0 ? (
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          No tasks assigned to this employee.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {byTask.map(({ task, events }) => {
            const title = task.title || task.taskId || "Task";
            const headingId = `task-activity-${task.taskId || title}`;
            return (
              <article
                key={task.taskId || title}
                aria-labelledby={headingId}
                style={{
                  paddingTop: 4,
                  borderTop: "1px solid var(--dgv-border)",
                }}
              >
                <h4 id={headingId} style={{ margin: "12px 0 8px", fontSize: 16 }}>
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
                {events.length === 0 ? (
                  <p style={{ color: colors.textMuted, fontSize: 13, margin: 0 }}>
                    No activity recorded
                  </p>
                ) : (
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {events.map((ev, index) => (
                      <li
                        key={ev.activityId || ev.SK || `${ev.timestamp}-${index}`}
                        style={{
                          fontSize: 13,
                          color: colors.textSecondary,
                          padding: "6px 0",
                          borderTop: index ? "1px solid var(--dgv-border)" : "none",
                        }}
                      >
                        <span style={{ fontWeight: 600, color: "var(--dgv-text)" }}>
                          {formatTaskDateTime(ev.timestamp)}
                        </span>
                        {` · ${friendlyActivityText(ev, [])}`}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ActivityPanel({ data, tasks, email }) {
  return (
    <>
      <PortalPresenceSection data={data} />
      <TaskActivitySection tasks={tasks} email={email} />
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

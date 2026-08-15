import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import Layout from "../../components/Layout";
import {
  fetchUserProfile,
  fetchUsers,
  fetchEmployeeDocuments,
  reviewDocument,
  fetchAttendance,
  fetchTasks,
  fetchAllLeave,
  fetchAdminActivity,
} from "../../services/api";
import { roleLabel } from "../../constants/roles";
import { colors, pageCard, pageTitle, pageSubtitle } from "../../theme";
import { resolveDocumentViewUrl } from "../../utils/documentView";
import { getWeeklyDisplayStatus } from "../../components/WeeklyAttendanceHistory";

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

function formatTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(t));
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
  const [docData, setDocData] = useState(null);
  const [docBusy, setDocBusy] = useState("");
  const [attendance, setAttendance] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [leaveRows, setLeaveRows] = useState(null);
  const [activity, setActivity] = useState(null);

  useEffect(() => {
    setTab(TABS.includes(requestedTab) ? requestedTab : "Overview");
  }, [email, requestedTab]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const [p, users] = await Promise.all([
          fetchUserProfile(email),
          fetchUsers(),
        ]);
        if (cancelled) return;
        setProfile(p || {});
        setAccess(
          (Array.isArray(users) ? users : []).find(
            (u) => u.email?.toLowerCase() === email
          ) || null
        );
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
    if (tab !== "Documents" || !email) return;
    let cancelled = false;
    fetchEmployeeDocuments(email)
      .then((res) => {
        if (!cancelled) setDocData(res || null);
      })
      .catch(() => {
        if (!cancelled) setDocData({ documents: [], types: [], summary: null });
      });
    return () => {
      cancelled = true;
    };
  }, [tab, email]);

  useEffect(() => {
    if (!email) return;
    if (!["Overview", "Attendance", "Activity"].includes(tab)) return;
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
    fetchTasks({})
      .then((list) => {
        if (cancelled) return;
        const mine = (Array.isArray(list) ? list : []).filter(
          (t) => String(t.assignee || "").toLowerCase() === email
        );
        setTasks(mine);
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
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
                <AttendancePanel rows={attendance} leaves={leaveRows} />
              ) : tab === "Tasks" ? (
                <TasksPanel rows={tasks} />
              ) : tab === "Documents" ? (
                <EmployeeDocumentsPanel
                  data={docData}
                  busyId={docBusy}
                  onRefresh={() =>
                    fetchEmployeeDocuments(email).then(setDocData)
                  }
                  setBusyId={setDocBusy}
                />
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
                <ActivityPanel data={activity} />
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

function AttendancePanel({ rows, leaves }) {
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
  const days = [];
  let cursor = start;
  while (cursor <= end) {
    const rec = byDate[cursor] || null;
    const overlay = leaveOnDate(cursor, leaves);
    const display = overlay || getWeeklyDisplayStatus(rec);
    days.push({ date: cursor, rec, display });
    const [y, m, d] = cursor.split("-").map(Number);
    const next = new Date(y, m - 1, d + 1);
    cursor = ymd(next);
  }
  days.reverse();
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Attendance</h3>
      {days.every((d) => d.display === "Not Marked") ? (
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          No attendance records for this employee in the last 14 days.
        </p>
      ) : (
        <div className="dgv-table-wrap">
          <table className="dgv-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th>Check-in</th>
                <th>Check-out</th>
                <th>Working time</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>{d.display}</td>
                  <td>{formatTime(d.rec?.checkInTime)}</td>
                  <td>{formatTime(d.rec?.checkOutTime)}</td>
                  <td>{d.rec?.workingTime || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function TasksPanel({ rows }) {
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
      <h3 style={{ marginTop: 0 }}>Tasks</h3>
      {rows.length === 0 ? (
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          No tasks assigned to this employee.
        </p>
      ) : (
        <div className="dgv-table-wrap">
          <table className="dgv-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.taskId || t.title}>
                  <td>{t.title || "—"}</td>
                  <td>{t.status || "—"}</td>
                  <td>{t.dueDate || "—"}</td>
                </tr>
              ))}
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

function ActivityPanel({ data }) {
  if (!data) {
    return (
      <>
        <h3 style={{ marginTop: 0 }}>Activity</h3>
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          Loading activity…
        </p>
      </>
    );
  }
  const events = data.events || [];
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Activity</h3>
      {data.summary ? (
        <p style={{ color: colors.textMuted }}>
          Events: {data.summary.eventCount || events.length}
          {data.summary.totalMinutes
            ? ` · Session minutes: ${data.summary.totalMinutes}`
            : ""}
        </p>
      ) : null}
      {events.length === 0 ? (
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          No portal activity recorded for this employee yet.
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
    </>
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

function EmployeeDocumentsPanel({ data, busyId, onRefresh, setBusyId }) {
  const types = data?.types || [];
  const documents = data?.documents || [];
  const summary = data?.summary;
  const typeLabel = (code) => types.find((t) => t.code === code)?.label || code;

  const viewDoc = async (doc) => {
    try {
      console.log("View document:", {
        documentId: doc.documentId,
        fileName: doc.fileName,
        storageKey: doc.storageKey || doc.s3Key,
      });
      const url = await resolveDocumentViewUrl(doc);
      if (!url) {
        alert("Unable to open document");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error(err?.message || "S3_SIGNED_URL_FAILED");
      alert(err.message || "Unable to open document");
    }
  };

  const verify = async (documentId) => {
    setBusyId(documentId);
    try {
      await reviewDocument(documentId, "VERIFIED");
      await onRefresh();
    } catch (err) {
      alert(err.message || "Unable to verify");
    } finally {
      setBusyId("");
    }
  };

  const reject = async (documentId) => {
    const rejectionReason = window.prompt("Rejection Reason:") || "";
    if (!rejectionReason.trim()) {
      alert("Rejection reason is required.");
      return;
    }
    setBusyId(documentId);
    try {
      await reviewDocument(documentId, "REJECTED", rejectionReason.trim());
      await onRefresh();
    } catch (err) {
      alert(err.message || "Unable to reject");
    } finally {
      setBusyId("");
    }
  };

  if (!data) {
    return <p style={{ color: colors.textMuted, marginBottom: 0 }}>Loading documents…</p>;
  }

  return (
    <>
      <h3 style={{ marginTop: 0 }}>Documents</h3>
      {summary ? (
        <p style={{ color: colors.textMuted }}>
          Uploaded {summary.uploaded} · Verified {summary.verified} · Pending{" "}
          {summary.pendingReview} · Rejected {summary.rejected} · Missing{" "}
          {summary.missing}
        </p>
      ) : null}
      {documents.length === 0 ? (
        <p style={{ color: colors.textMuted, marginBottom: 0 }}>
          No documents uploaded yet.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {documents.map((d) => (
            <div
              key={d.documentId}
              style={{
                padding: 12,
                borderRadius: 10,
                border: "1px solid var(--dgv-border)",
              }}
            >
              <div style={{ fontWeight: 700 }}>
                {typeLabel(d.documentType)}{" "}
                <span
                  className={
                    d.status === "VERIFIED"
                      ? "dgv-badge dgv-badge--success"
                      : d.status === "REJECTED"
                        ? "dgv-badge dgv-badge--danger"
                        : "dgv-badge dgv-badge--info"
                  }
                >
                  {d.status === "UNDER_REVIEW" ? "UNDER REVIEW" : d.status}
                </span>
              </div>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>
                {d.fileName}
                {d.rejectionReason ? ` · ${d.rejectionReason}` : ""}
              </div>
              <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="dgv-btn dgv-btn--outline"
                  style={{ padding: "4px 10px", fontSize: 13 }}
                  onClick={() => viewDoc(d)}
                >
                  View
                </button>
                {d.status === "UNDER_REVIEW" || d.status === "UPLOADED" ? (
                  <>
                    <button
                      type="button"
                      className="dgv-btn dgv-btn--success"
                      style={{ padding: "4px 10px", fontSize: 13 }}
                      disabled={busyId === d.documentId}
                      onClick={() => verify(d.documentId)}
                    >
                      Verify
                    </button>
                    <button
                      type="button"
                      className="dgv-btn dgv-btn--danger"
                      style={{ padding: "4px 10px", fontSize: 13 }}
                      disabled={busyId === d.documentId}
                      onClick={() => reject(d.documentId)}
                    >
                      Reject
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

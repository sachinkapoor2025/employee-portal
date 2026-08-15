import { useCallback, useEffect, useMemo, useState } from "react";
import Layout from "../../components/Layout";
import {
  fetchAttendanceActivity,
  fetchAttendance,
  fetchUsers,
  fetchTasks,
  fetchAllLeave,
  fetchUserProfile,
} from "../../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  formInput,
  formSelect,
  formLabel,
} from "../../theme";
import Button from "../../components/ui/Button";
import { formatTaskDuration, personLabel } from "../../utils/taskStatus";
import { todayKeyIST, displayNameFromEmail } from "../../utils/meetings";
import { getWeeklyDisplayStatus } from "../../components/WeeklyAttendanceHistory";

const HISTORY_START = "2020-01-01";

function matchesEmployee(row, q) {
  if (!q) return true;
  const name = String(row.employeeName || row.name || "").toLowerCase();
  const email = String(row.email || "").toLowerCase();
  const id = String(row.employeeId || row.empId || "").toLowerCase();
  const local = email.split("@")[0];
  return (
    name.includes(q) ||
    email.includes(q) ||
    id.includes(q) ||
    local.includes(q)
  );
}

function leaveOnDate(dateKey, leaves, email) {
  const target = String(email || "").toLowerCase();
  for (const leave of leaves || []) {
    if (String(leave.email || "").toLowerCase() !== target) continue;
    const from = leave.fromDate || leave.startDate;
    const to = leave.toDate || leave.endDate || from;
    if (!from || !to) continue;
    const planned =
      leave.status === "PLANNED_OFF" ||
      leave.category === "PLANNED_OFF" ||
      leave.type === "PLANNED_OFF";
    const approved = String(leave.status || "").toUpperCase() === "APPROVED";
    if (!planned && !approved) continue;
    if (dateKey >= from && dateKey <= to) {
      return planned ? "Planned Off" : "On Leave";
    }
  }
  return null;
}

function resolveDayStatus(record, leaveLabel) {
  if (leaveLabel === "Planned Off") return "Planned Off";
  if (leaveLabel === "On Leave") return "On Leave";
  const weekly = getWeeklyDisplayStatus(record);
  if (weekly === "Leave") return "On Leave";
  if (weekly === "Planned Off") return "Planned Off";
  if (weekly === "Present") return "Present";
  if (weekly === "Weekly Off") return "Weekly Off";
  return "Absent";
}

async function loadAttendanceForEmails(emails, start, end, userByEmail) {
  const collected = [];
  await Promise.all(
    emails.map(async (email) => {
      try {
        const rows = await fetchAttendance(start, end, email);
        const user = userByEmail[email];
        for (const row of Array.isArray(rows) ? rows : []) {
          collected.push(withActivityStatus({ ...row, email }, user));
        }
      } catch {
        /* skip employee */
      }
    })
  );
  return collected;
}

async function enrichUsers(list) {
  return Promise.all(
    (list || []).map(async (u) => {
      const email = String(u.email || "").trim().toLowerCase();
      if (!email) return u;
      if (u.name && (u.empId || u.employeeId)) {
        return {
          ...u,
          email,
          name: u.name,
          empId: u.empId || u.employeeId || "",
        };
      }
      try {
        const profile = await fetchUserProfile(email);
        return {
          ...u,
          email,
          name: profile?.name || u.name || displayNameFromEmail(email),
          empId: profile?.empId || u.empId || u.employeeId || "",
        };
      } catch {
        return {
          ...u,
          email,
          name: u.name || displayNameFromEmail(email),
          empId: u.empId || u.employeeId || "",
        };
      }
    })
  );
}

function buildDayRows(users, records, leaves, day) {
  const byEmail = {};
  (records || []).forEach((row) => {
    const email = String(row.email || "").toLowerCase();
    if (!email) return;
    const prev = byEmail[email];
    if (!prev || row.checkInTime) byEmail[email] = row;
  });
  return (users || [])
    .filter((u) => u.email)
    .map((u) => {
      const rec = byEmail[u.email] || null;
      const leaveLabel = leaveOnDate(day, leaves, u.email);
      const merged = withActivityStatus(
        rec || { email: u.email, date: day },
        u
      );
      return {
        ...merged,
        date: rec?.date || day,
        dayStatus: resolveDayStatus(rec, leaveLabel),
      };
    })
    .sort((a, b) =>
      (a.employeeName || a.email).localeCompare(b.employeeName || b.email)
    );
}

function withActivityStatus(row, user) {
  let activityStatus = row.activityStatus || row.sessionStatus;
  if (!activityStatus) {
    if (row.checkInTime && !row.checkOutTime) activityStatus = "Active";
    else if (row.checkOutTime) activityStatus = "Checked Out";
    else if (row.status === "Working") activityStatus = "Present";
    else activityStatus = row.status || null;
  }
  return {
    ...row,
    email: row.email || user?.email || "",
    employeeName: row.employeeName || user?.name || row.name || "",
    employeeId: row.employeeId || user?.empId || "",
    activityStatus,
  };
}

const TASK_STATUS_LABEL = {
  BACKLOG: "Backlog",
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  REVIEW: "Pending",
  DONE: "Completed",
  CANCELLED: "Cancelled",
};

const TASK_STATUS_BADGE = {
  Backlog: "dgv-badge dgv-badge--neutral",
  "To Do": "dgv-badge dgv-badge--info",
  Pending: "dgv-badge dgv-badge--info",
  "In Progress": "dgv-badge dgv-badge--success",
  Completed: "dgv-badge dgv-badge--success",
  Cancelled: "dgv-badge dgv-badge--neutral",
};

function taskStatusLabel(status) {
  const s = String(status || "").toUpperCase();
  return TASK_STATUS_LABEL[s] || s || "—";
}

const STATUS_BADGE = {
  Present: "dgv-badge dgv-badge--success",
  Active: "dgv-badge dgv-badge--success",
  "Checked Out": "dgv-badge dgv-badge--neutral",
  "On Leave": "dgv-badge dgv-badge--danger",
  Leave: "dgv-badge dgv-badge--danger",
  "Planned Off": "dgv-badge dgv-badge--info",
  Absent: "dgv-badge dgv-badge--neutral",
  "Weekly Off": "dgv-badge dgv-badge--neutral",
};

function formatTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(t));
}

function statusLabel(row, historyMode) {
  if (historyMode) {
    return (
      row.dayStatus ||
      row.activityStatus ||
      getWeeklyDisplayStatus(row) ||
      "—"
    );
  }
  return row.dayStatus || "Absent";
}

export default function AttendanceActivity() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [date, setDate] = useState(() => todayKeyIST());
  const [status, setStatus] = useState("");
  const [viewAll, setViewAll] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [taskRows, setTaskRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const [historyItems, setHistoryItems] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let users = [];
      let leaves = [];
      try {
        const list = await fetchUsers();
        users = await enrichUsers(Array.isArray(list) ? list : []);
      } catch {
        users = [];
      }
      try {
        const allLeave = await fetchAllLeave();
        leaves = Array.isArray(allLeave) ? allLeave : [];
      } catch {
        leaves = [];
      }

      const userByEmail = Object.fromEntries(
        users.map((u) => [String(u.email || "").toLowerCase(), u])
      );
      const day = date || todayKeyIST();
      const emails = users
        .map((u) => String(u.email || "").toLowerCase())
        .filter(Boolean);

      let records = [];
      try {
        const data = await fetchAttendanceActivity({
          date: day,
          page: 1,
          pageSize: 100,
        });
        records = Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data)
            ? data
            : [];
      } catch {
        records = [];
      }
      records = records.map((row) =>
        withActivityStatus(
          row,
          userByEmail[String(row.email || "").toLowerCase()]
        )
      );

      if (emails.length) {
        const extra = await loadAttendanceForEmails(
          emails,
          day,
          day,
          userByEmail
        );
        const byEmail = Object.fromEntries(
          records.map((row) => [String(row.email || "").toLowerCase(), row])
        );
        extra.forEach((row) => {
          const email = String(row.email || "").toLowerCase();
          if (!email) return;
          const prev = byEmail[email];
          if (!prev || (!prev.checkInTime && row.checkInTime) || !prev.status) {
            byEmail[email] = row;
          }
        });
        records = Object.values(byEmail);
      }

      const rows = buildDayRows(users, records, leaves, day);
      setItems(rows);

      try {
        const taskList = await fetchTasks({});
        const rawTasks = (Array.isArray(taskList) ? taskList : []).filter(
          (t) => !t.archived
        );
        const mapped = rawTasks.map((t) => {
          const email = String(t.assignee || "").toLowerCase();
          const person = personLabel(users, t.assignee);
          return {
            ...t,
            email,
            employeeName: person.name || email || "Unassigned",
            durationLabel: formatTaskDuration(t) || "—",
            statusLabel: taskStatusLabel(t.status),
          };
        });
        setTaskRows(mapped);
      } catch {
        setTaskRows([]);
      }
    } catch (err) {
      console.warn("Attendance activity load failed:", err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setViewAll(false);
    setDetail(null);
    setHistoryItems([]);
  }, [date]);

  const openDetails = async (row) => {
    const email = String(row.email || "").toLowerCase();
    if (!email) return;
    setDetail({
      email,
      name: row.employeeName || displayNameFromEmail(email),
      empId: row.employeeId || "",
    });
    setHistoryLoading(true);
    setViewAll(false);
    try {
      const userByEmail = {
        [email]: {
          email,
          name: row.employeeName,
          empId: row.employeeId,
        },
      };
      const rows = await loadAttendanceForEmails(
        [email],
        HISTORY_START,
        todayKeyIST(),
        userByEmail
      );
      setHistoryItems(
        rows.sort((a, b) =>
          String(b.date || b.checkInTime || "").localeCompare(
            String(a.date || a.checkInTime || "")
          )
        )
      );
    } catch (err) {
      console.warn("Employee attendance history failed:", err);
      setHistoryItems([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const q = search.trim().toLowerCase();
  const historyMode = Boolean(detail);
  const sourceRows = historyMode ? historyItems : items;
  const filteredRows = useMemo(() => {
    return sourceRows.filter((row) => {
      if (historyMode) {
        if (status) {
          const label = statusLabel(row, true);
          if (label !== status) return false;
        }
        return true;
      }
      if (q && !matchesEmployee(row, q)) return false;
      if (status && row.dayStatus !== status) return false;
      return true;
    });
  }, [sourceRows, q, status, historyMode]);

  const visibleRows =
    historyMode && !viewAll ? filteredRows.slice(0, 5) : filteredRows;

  const visibleTasks = q
    ? taskRows.filter(
        (t) =>
          String(t.employeeName || "").toLowerCase().includes(q) ||
          t.email.includes(q)
      )
    : taskRows;

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 1100 }}>
        <h2 style={pageTitle}>Attendance Activity</h2>
        <p style={pageSubtitle}>
          Live check-in / check-out records from the Employee Portal.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            marginBottom: 20,
            alignItems: "end",
          }}
        >
          <div>
            <label style={formLabel}>Search employee</label>
            <input
              style={{ ...formInput, marginBottom: 0 }}
              placeholder="Name, ID, or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search by employee name"
            />
          </div>
          <div>
            <label style={formLabel}>Date</label>
            <input
              type="date"
              style={{ ...formInput, marginBottom: 0 }}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Filter by date"
            />
          </div>
          <div>
            <label style={formLabel}>Status</label>
            <select
              style={{ ...formSelect, marginBottom: 0 }}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="Present">Present</option>
              <option value="Absent">Absent</option>
              <option value="On Leave">On Leave</option>
              <option value="Planned Off">Planned Off</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button type="button" variant="outline" onClick={() => load()}>
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowTasks((v) => !v)}
            >
              {showTasks ? "Hide Tasks" : "Tasks"}
            </Button>
          </div>
        </div>

        <p style={{ color: colors.textMuted, fontSize: 13, marginTop: 0 }}>
          {historyMode
            ? `Attendance history for ${detail.name}.`
            : "All employees for the selected date. Open View Details to see one person’s full history."}
        </p>

        {historyMode ? (
          <div style={{ marginBottom: 12 }}>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDetail(null);
                setHistoryItems([]);
                setViewAll(false);
              }}
            >
              ← Back to employees
            </Button>
          </div>
        ) : null}

        {showTasks ? (
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ ...pageTitle, fontSize: 18, marginBottom: 8 }}>
              Assigned Tasks
            </h3>
            {visibleTasks.length === 0 ? (
              <p style={{ color: colors.textMuted, marginTop: 0 }}>
                No tasks found for this search.
              </p>
            ) : (
              <div className="dgv-table-wrap">
                <table className="dgv-table">
                  <thead>
                    <tr>
                      <th>Employee Name</th>
                      <th>Task Name</th>
                      <th>Task Status</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTasks.map((row) => (
                      <tr key={row.taskId || `${row.email}-${row.title}`}>
                        <td>
                          <div style={{ fontWeight: 600 }}>
                            {row.employeeName || "—"}
                          </div>
                          {row.email ? (
                            <div
                              style={{
                                fontSize: 12,
                                color: colors.textMuted,
                              }}
                            >
                              {row.email}
                            </div>
                          ) : null}
                        </td>
                        <td>{row.title || "—"}</td>
                        <td>
                          <span
                            className={
                              TASK_STATUS_BADGE[row.statusLabel] ||
                              "dgv-badge dgv-badge--neutral"
                            }
                          >
                            {row.statusLabel}
                          </span>
                        </td>
                        <td>{row.durationLabel || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}

        {loading || (historyMode && historyLoading) ? (
          <p style={{ color: colors.textMuted }}>Loading attendance activity…</p>
        ) : filteredRows.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "40px 20px",
              background: "var(--dgv-surface-solid)",
              borderRadius: 12,
              border: `1px dashed ${colors.border}`,
            }}
          >
            <p style={{ margin: 0, fontWeight: 600 }}>No attendance activity found</p>
            <p style={{ color: colors.textMuted, fontSize: 14, marginBottom: 0 }}>
              {historyMode
                ? "No attendance records for this employee yet."
                : "No employees match the current filters."}
            </p>
          </div>
        ) : (
          <>
            <div className="dgv-table-wrap">
              <table className="dgv-table">
                <thead>
                  <tr>
                    <th>Employee Name</th>
                    <th>Employee ID</th>
                    <th>Date</th>
                    <th>Check-In</th>
                    <th>Check-Out</th>
                    <th>Working Time</th>
                    <th>Status</th>
                    {!historyMode ? <th>Action</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const label = statusLabel(row, historyMode);
                    return (
                      <tr key={row.attendanceId || `${row.email}-${row.date}`}>
                        <td>
                          <div style={{ fontWeight: 600 }}>
                            {row.employeeName || "—"}
                          </div>
                          <div style={{ fontSize: 12, color: colors.textMuted }}>
                            {row.email}
                          </div>
                        </td>
                        <td>{row.employeeId || "—"}</td>
                        <td>{row.date || "—"}</td>
                        <td>{formatTime(row.checkInTime)}</td>
                        <td>{formatTime(row.checkOutTime)}</td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>
                          {row.workingTime ||
                            (row.activityStatus === "Active"
                              ? "In progress"
                              : "—")}
                        </td>
                        <td>
                          <span
                            className={
                              STATUS_BADGE[label] || "dgv-badge dgv-badge--neutral"
                            }
                          >
                            {label}
                          </span>
                        </td>
                        {!historyMode ? (
                          <td>
                            <Button
                              type="button"
                              variant="secondary"
                              style={{ padding: "6px 12px", fontSize: 12 }}
                              onClick={() => openDetails(row)}
                            >
                              View Details
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                marginTop: 16,
                flexWrap: "wrap",
              }}
            >
              <span style={{ color: colors.textMuted, fontSize: 13 }}>
                {historyMode
                  ? viewAll
                    ? `Showing all ${filteredRows.length} records`
                    : `Showing latest ${Math.min(5, filteredRows.length)} of ${filteredRows.length} records`
                  : `Showing ${filteredRows.length} employees for ${date || todayKeyIST()}`}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                {historyMode && filteredRows.length > 5 ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setViewAll((v) => !v)}
                  >
                    {viewAll ? "Show latest 5" : "View All"}
                  </Button>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

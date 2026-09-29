import { useEffect, useMemo, useState } from "react";
import Layout from "../../components/Layout";
import { fetchAllLeave, fetchAttendanceActivity, reviewLeave } from "../../services/api";
import { colors, pageCard, pageTitle, pageSubtitle, formInput, formSelect, formLabel } from "../../theme";
import { companyTodayKey } from "../../utils/attendanceCompliance";
import {
  filterHistoryLeaveRows,
  filterHistoryWeekOffRows,
  historyDefaultFromKey,
  mergeHistoryWeekOffRows,
  mergeTodayWeekOffRows,
  splitLeaveViews,
  todayTimeOffSummaryCounts,
  WEEK_OFF_SOURCE_LEAVE,
} from "../../utils/leaveAdminViews";
import { StatCard } from "../../components/ui/Card";

function daysInclusive(fromDate, toDate) {
  if (!fromDate || !toDate) return 0;
  const a = Date.parse(`${fromDate}T00:00:00`);
  const b = Date.parse(`${toDate}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.floor((b - a) / 86400000) + 1;
}

function formatDate(value) {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T12:00:00`);
    if (!Number.isFinite(d.getTime())) return value;
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }
  return String(value);
}

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function isPending(status) {
  const s = String(status || "").toUpperCase();
  return s === "PENDING" || s === "PENDING_APPROVAL";
}

function isPlannedOff(row) {
  return row?.category === "PLANNED_OFF" || row?.status === "PLANNED_OFF" || row?.type === "PLANNED_OFF";
}

function displayStatus(row) {
  const s = String(row?.status || "").toUpperCase();
  if (s === "CANCELLED") return "CANCELLED";
  if (isPlannedOff(row)) return "WEEK OFF";
  if (s === "PENDING" || s === "PENDING_APPROVAL") return "PENDING APPROVAL";
  return s || "—";
}

function statusClass(row) {
  const s = String(row?.status || "").toUpperCase();
  if (s === "APPROVED" || s === "PLANNED_OFF") return "dgv-badge dgv-badge--success";
  if (s === "REJECTED" || s === "CANCELLED") return "dgv-badge dgv-badge--danger";
  return "dgv-badge dgv-badge--info";
}

function typeLabel(row) {
  if (isPlannedOff(row)) return "Week Off";
  const map = { CASUAL: "Casual Leave", SICK: "Sick Leave", EARNED: "Earned Leave" };
  return map[row?.type] || row?.type || "Leave";
}

function remainingLabel(row, now) {
  if (!isPending(row.status) || !row.approvalDeadline) return "—";
  const nowMs = typeof now === "number" ? now : new Date(now).getTime();
  const ms =
    row.remainingMs != null
      ? row.remainingMs
      : new Date(row.approvalDeadline).getTime() - nowMs;
  if (ms <= 0) return "Auto-approving…";
  const totalMins = Math.floor(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m remaining`;
}

function employeeLabel(row) {
  return String(row?.employeeName || "").trim() || row?.email || "—";
}

const todayEyebrow = {
  margin: "20px 0 12px",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 0.5,
  color: colors.textMuted,
};

const sectionHeading = {
  marginTop: 28,
  marginBottom: 4,
};

const sectionHint = {
  color: colors.textMuted,
  fontSize: 13,
  margin: "0 0 12px",
};

const filterControl = {
  ...formInput,
  marginBottom: 0,
  minWidth: 150,
};

const filterSelect = {
  ...formSelect,
  marginBottom: 0,
  minWidth: 140,
};

const filterLabel = {
  ...formLabel,
  marginBottom: 4,
};

function defaultHistoryFilters(todayKey) {
  return {
    search: "",
    type: "ALL",
    fromDate: historyDefaultFromKey(todayKey),
    toDate: todayKey,
    status: "ALL",
  };
}

async function fetchCompanyAttendancePages(params = {}) {
  const pageSize = 100;
  const first = await fetchAttendanceActivity({
    ...params,
    page: 1,
    pageSize,
  });
  if (Array.isArray(first)) return first;
  const items = Array.isArray(first?.items) ? [...first.items] : [];
  const totalPages = Number(first?.totalPages) || 1;
  for (let page = 2; page <= totalPages; page += 1) {
    const next = await fetchAttendanceActivity({
      ...params,
      page,
      pageSize,
    });
    items.push(...(Array.isArray(next?.items) ? next.items : []));
  }
  return items;
}

export default function LeaveManagement() {
  const [leaves, setLeaves] = useState([]);
  const [attendanceRows, setAttendanceRows] = useState([]);
  const [historyAttendance, setHistoryAttendance] = useState([]);
  const [historyAttendanceLoaded, setHistoryAttendanceLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState("");
  const [actMenuId, setActMenuId] = useState("");
  const [view, setView] = useState("today");
  const [historyFilters, setHistoryFilters] = useState(() =>
    defaultHistoryFilters(companyTodayKey())
  );

  const loadTodayAttendance = (dateKey) =>
    fetchCompanyAttendancePages({ date: dateKey })
      .then((rows) => setAttendanceRows(Array.isArray(rows) ? rows : []))
      .catch(() => setAttendanceRows([]));

  const loadHistoryAttendance = (force = false) => {
    if (historyAttendanceLoaded && !force) return;
    setHistoryAttendanceLoaded(true);
    fetchCompanyAttendancePages({})
      .then((rows) => setHistoryAttendance(Array.isArray(rows) ? rows : []))
      .catch(() => setHistoryAttendance([]));
  };

  const load = () => {
    const dateKey = companyTodayKey(new Date());
    fetchAllLeave().then(setLeaves).catch(console.error);
    loadTodayAttendance(dateKey);
    if (historyAttendanceLoaded) loadHistoryAttendance(true);
  };

  useEffect(() => {
    load();
    // Mount-only: load is recreated each render and must not re-fetch in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const review = async (leaveId, status) => {
    let rejectionReason = "";
    if (status === "REJECTED") {
      rejectionReason = window.prompt("Rejection reason (optional):") || "";
    }
    setActMenuId("");
    setBusyId(leaveId);
    try {
      await reviewLeave(leaveId, status, rejectionReason);
      await load();
    } catch (err) {
      alert(err.message || "Unable to update leave");
    } finally {
      setBusyId("");
    }
  };

  const rows = useMemo(
    () => (Array.isArray(leaves) ? leaves : []),
    [leaves]
  );
  const todayKey = companyTodayKey(new Date(now));
  const { today: todayRows } = useMemo(
    () => splitLeaveViews(rows, todayKey),
    [rows, todayKey]
  );
  const showingHistory = view === "history";
  const todayLeaveWeekOffs = todayRows.filter(isPlannedOff);
  const requests = todayRows.filter((r) => !isPlannedOff(r));
  const planned = mergeTodayWeekOffRows(todayLeaveWeekOffs, attendanceRows, todayKey);
  const summary = todayTimeOffSummaryCounts({
    weekOffRows: planned,
    todayLeaveRows: todayRows,
  });
  const historyWeekOffRows = useMemo(() => {
    const merged = mergeHistoryWeekOffRows(
      rows,
      historyAttendance,
      historyFilters.fromDate,
      historyFilters.toDate
    );
    return filterHistoryWeekOffRows(merged, { search: historyFilters.search });
  }, [rows, historyAttendance, historyFilters.fromDate, historyFilters.toDate, historyFilters.search]);
  const historyLeaveRows = useMemo(
    () =>
      filterHistoryLeaveRows(rows, {
        search: historyFilters.search,
        fromKey: historyFilters.fromDate,
        toKey: historyFilters.toDate,
        status: historyFilters.status,
      }),
    [
      rows,
      historyFilters.search,
      historyFilters.fromDate,
      historyFilters.toDate,
      historyFilters.status,
    ]
  );
  const showHistoryWeekOff = historyFilters.type !== "LEAVE";
  const showHistoryLeave = historyFilters.type !== "WEEK_OFF";

  const openHistory = () => {
    setActMenuId("");
    setHistoryFilters(defaultHistoryFilters(todayKey));
    setView("history");
    loadHistoryAttendance();
  };

  const openToday = () => {
    setActMenuId("");
    setView("today");
  };

  const clearHistoryFilters = () => {
    setHistoryFilters(defaultHistoryFilters(todayKey));
  };

  const leaveRequestsTable =
    requests.length > 0 ? (
        <div className="dgv-table-wrap" style={{ overflowX: "hidden" }}>
          <table
            className="dgv-table"
            style={{ minWidth: 0, width: "100%", tableLayout: "fixed" }}
          >
            <thead>
              <tr>
                <th>Employee</th>
                <th>Leave Type</th>
                <th>Start Date</th>
                <th>End Date</th>
                <th>Days</th>
                <th>Reason</th>
                <th>Emergency Reason</th>
                <th>Submitted At</th>
                <th>Approval Deadline</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((l) => (
                <tr key={l.leaveId}>
                  <td style={{ wordBreak: "break-word" }}>{l.email}</td>
                  <td style={{ wordBreak: "break-word" }}>{typeLabel(l)}</td>
                  <td style={{ wordBreak: "break-word" }}>
                    {formatDate(l.fromDate || l.startDate)}
                  </td>
                  <td style={{ wordBreak: "break-word" }}>
                    {formatDate(l.toDate || l.endDate)}
                  </td>
                  <td>{l.days || daysInclusive(l.fromDate, l.toDate) || "—"}</td>
                  <td style={{ wordBreak: "break-word" }}>
                    {l.reason || "—"}
                  </td>
                  <td style={{ wordBreak: "break-word" }}>
                    {l.emergencyReason || "—"}
                  </td>
                  <td>{formatDateTime(l.submittedAt || l.createdAt)}</td>
                  <td>
                    {l.approvalDeadline ? formatDateTime(l.approvalDeadline) : "—"}
                    {isPending(l.status) ? (
                      <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
                        Approval window: {remainingLabel(l, now)}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span className={statusClass(l)}>{displayStatus(l)}</span>
                  </td>
                  <td>
                    {isPending(l.status) ? (
                      <div style={{ position: "relative" }}>
                        <button
                          type="button"
                          className="dgv-btn dgv-btn--outline"
                          style={{ padding: "4px 12px", fontSize: 13 }}
                          disabled={busyId === l.leaveId}
                          aria-expanded={actMenuId === l.leaveId}
                          onClick={() =>
                            setActMenuId(
                              actMenuId === l.leaveId ? "" : l.leaveId
                            )
                          }
                        >
                          Act ▾
                        </button>
                        {actMenuId === l.leaveId ? (
                          <div
                            style={{
                              position: "absolute",
                              top: "calc(100% + 6px)",
                              right: 0,
                              zIndex: 20,
                              minWidth: 120,
                              padding: 6,
                              borderRadius: 10,
                              border: `1px solid ${colors.border}`,
                              background: "var(--dgv-card)",
                              boxShadow: "var(--dgv-shadow-lg)",
                              display: "flex",
                              flexDirection: "column",
                              gap: 6,
                            }}
                          >
                            <button
                              type="button"
                              className="dgv-btn dgv-btn--success"
                              style={{ padding: "6px 10px", fontSize: 13 }}
                              disabled={busyId === l.leaveId}
                              onClick={() => review(l.leaveId, "APPROVED")}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className="dgv-btn dgv-btn--danger"
                              style={{ padding: "6px 10px", fontSize: 13 }}
                              disabled={busyId === l.leaveId}
                              onClick={() => review(l.leaveId, "REJECTED")}
                            >
                              Reject
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
    ) : null;

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: "100%" }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={pageTitle}>
              {showingHistory ? "Leave & Time Off History" : "Leave & Time Off"}
            </h2>
            <p style={pageSubtitle}>
              {showingHistory
                ? "Search and filter previous leave requests and week offs."
                : "Manage today's leave requests and employee week offs."}
            </p>
          </div>
          <button
            type="button"
            className="dgv-btn dgv-btn--outline"
            onClick={() => {
              if (showingHistory) openToday();
              else openHistory();
            }}
          >
            {showingHistory ? "← Back to Today" : "History"}
          </button>
        </div>

        {showingHistory ? (
          <>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "flex-end",
                marginTop: 4,
              }}
            >
              <label style={{ flex: "1 1 180px", minWidth: 180 }}>
                <span style={filterLabel}>Employee Search</span>
                <input
                  style={filterControl}
                  placeholder="Search employee..."
                  aria-label="Search employee..."
                  value={historyFilters.search}
                  onChange={(e) =>
                    setHistoryFilters((prev) => ({ ...prev, search: e.target.value }))
                  }
                />
              </label>
              <label style={{ flex: "0 1 140px" }}>
                <span style={filterLabel}>Type</span>
                <select
                  style={filterSelect}
                  aria-label="Type"
                  value={historyFilters.type}
                  onChange={(e) =>
                    setHistoryFilters((prev) => ({ ...prev, type: e.target.value }))
                  }
                >
                  <option value="ALL">All</option>
                  <option value="LEAVE">Leave</option>
                  <option value="WEEK_OFF">Week Off</option>
                </select>
              </label>
              <label style={{ flex: "0 1 150px" }}>
                <span style={filterLabel}>From Date</span>
                <input
                  type="date"
                  style={filterControl}
                  aria-label="From Date"
                  value={historyFilters.fromDate}
                  onChange={(e) =>
                    setHistoryFilters((prev) => ({ ...prev, fromDate: e.target.value }))
                  }
                />
              </label>
              <label style={{ flex: "0 1 150px" }}>
                <span style={filterLabel}>To Date</span>
                <input
                  type="date"
                  style={filterControl}
                  aria-label="To Date"
                  value={historyFilters.toDate}
                  onChange={(e) =>
                    setHistoryFilters((prev) => ({ ...prev, toDate: e.target.value }))
                  }
                />
              </label>
              <label style={{ flex: "0 1 150px" }}>
                <span style={filterLabel}>Status</span>
                <select
                  style={filterSelect}
                  aria-label="Status"
                  value={historyFilters.status}
                  onChange={(e) =>
                    setHistoryFilters((prev) => ({ ...prev, status: e.target.value }))
                  }
                >
                  <option value="ALL">All Statuses</option>
                  <option value="PENDING">Pending</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Rejected</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </label>
              <button
                type="button"
                className="dgv-btn dgv-btn--outline"
                onClick={clearHistoryFilters}
              >
                Clear Filters
              </button>
            </div>

            {showHistoryWeekOff ? (
              <section aria-labelledby="week-off-history-heading">
                <h3 id="week-off-history-heading" style={sectionHeading}>
                  WEEK OFF HISTORY
                </h3>
                <p style={sectionHint}>Previous employee week offs.</p>
                {historyWeekOffRows.length === 0 ? (
                  <p style={{ color: colors.textMuted, margin: 0 }}>
                    No Week Off records found for the selected filters.
                  </p>
                ) : (
                  <div className="dgv-table-wrap" style={{ overflowX: "hidden" }}>
                    <table
                      className="dgv-table"
                      style={{ minWidth: 0, width: "100%", tableLayout: "fixed" }}
                    >
                      <thead>
                        <tr>
                          <th>Employee</th>
                          <th>Date</th>
                          <th>Source</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {historyWeekOffRows.map((l) => (
                          <tr key={l.leaveId || `${l.email}-${l.fromDate}`}>
                            <td style={{ wordBreak: "break-word" }}>
                              {employeeLabel(l)}
                            </td>
                            <td>{formatDate(l.fromDate || l.startDate)}</td>
                            <td>{l.source || WEEK_OFF_SOURCE_LEAVE}</td>
                            <td>
                              {String(l.status || "").toUpperCase() === "CANCELLED" ? (
                                <span className="dgv-badge dgv-badge--danger">CANCELLED</span>
                              ) : (
                                <span className="dgv-badge dgv-badge--success">
                                  Week Off
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : null}

            {showHistoryLeave ? (
              <section aria-labelledby="leave-history-heading">
                <h3 id="leave-history-heading" style={sectionHeading}>
                  LEAVE HISTORY
                </h3>
                <p style={sectionHint}>Previous leave requests.</p>
                {historyLeaveRows.length === 0 ? (
                  <p style={{ color: colors.textMuted, margin: 0 }}>
                    No Leave records found for the selected filters.
                  </p>
                ) : (
                  <div className="dgv-table-wrap" style={{ overflowX: "hidden" }}>
                    <table
                      className="dgv-table"
                      style={{ minWidth: 0, width: "100%", tableLayout: "fixed" }}
                    >
                      <thead>
                        <tr>
                          <th>Employee</th>
                          <th>Leave Type</th>
                          <th>Start Date</th>
                          <th>End Date</th>
                          <th>Days</th>
                          <th>Reason</th>
                          <th>Status</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {historyLeaveRows.map((l) => (
                          <tr key={l.leaveId}>
                            <td style={{ wordBreak: "break-word" }}>{l.email}</td>
                            <td style={{ wordBreak: "break-word" }}>{typeLabel(l)}</td>
                            <td style={{ wordBreak: "break-word" }}>
                              {formatDate(l.fromDate || l.startDate)}
                            </td>
                            <td style={{ wordBreak: "break-word" }}>
                              {formatDate(l.toDate || l.endDate)}
                            </td>
                            <td>{l.days || daysInclusive(l.fromDate, l.toDate) || "—"}</td>
                            <td style={{ wordBreak: "break-word" }}>
                              {l.reason || "—"}
                            </td>
                            <td>
                              <span className={statusClass(l)}>{displayStatus(l)}</span>
                            </td>
                            <td>
                              {isPending(l.status) ? (
                                <div style={{ position: "relative" }}>
                                  <button
                                    type="button"
                                    className="dgv-btn dgv-btn--outline"
                                    style={{ padding: "4px 12px", fontSize: 13 }}
                                    disabled={busyId === l.leaveId}
                                    aria-expanded={actMenuId === l.leaveId}
                                    onClick={() =>
                                      setActMenuId(
                                        actMenuId === l.leaveId ? "" : l.leaveId
                                      )
                                    }
                                  >
                                    Act ▾
                                  </button>
                                  {actMenuId === l.leaveId ? (
                                    <div
                                      style={{
                                        position: "absolute",
                                        top: "calc(100% + 6px)",
                                        right: 0,
                                        zIndex: 20,
                                        minWidth: 120,
                                        padding: 6,
                                        borderRadius: 10,
                                        border: `1px solid ${colors.border}`,
                                        background: "var(--dgv-card)",
                                        boxShadow: "var(--dgv-shadow-lg)",
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 6,
                                      }}
                                    >
                                      <button
                                        type="button"
                                        className="dgv-btn dgv-btn--success"
                                        style={{ padding: "6px 10px", fontSize: 13 }}
                                        disabled={busyId === l.leaveId}
                                        onClick={() => review(l.leaveId, "APPROVED")}
                                      >
                                        Approve
                                      </button>
                                      <button
                                        type="button"
                                        className="dgv-btn dgv-btn--danger"
                                        style={{ padding: "6px 10px", fontSize: 13 }}
                                        disabled={busyId === l.leaveId}
                                        onClick={() => review(l.leaveId, "REJECTED")}
                                      >
                                        Reject
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : null}
          </>
        ) : (
          <>
            <p style={todayEyebrow}>TODAY · {formatDate(todayKey)}</p>
            <div className="dgv-kpi-grid dgv-kpi-grid--3">
              <StatCard label="Week Off" value={String(summary.weekOff)} />
              <StatCard label="On Leave" value={String(summary.onLeave)} />
              <StatCard label="Pending" value={String(summary.pending)} />
            </div>

            <section aria-labelledby="week-off-today-heading">
              <h3 id="week-off-today-heading" style={sectionHeading}>
                Week Off Today
              </h3>
              <p style={sectionHint}>
                Employees who are taking their weekly day off today.
              </p>
              {planned.length === 0 ? (
                <p style={{ color: colors.textMuted, margin: 0 }}>
                  No employees are taking a Week Off today.
                </p>
              ) : (
                <div className="dgv-table-wrap" style={{ overflowX: "hidden" }}>
                  <table
                    className="dgv-table"
                    style={{ minWidth: 0, width: "100%", tableLayout: "fixed" }}
                  >
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Date</th>
                        <th>Source</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {planned.map((l) => (
                        <tr key={l.leaveId}>
                          <td style={{ wordBreak: "break-word" }}>
                            {employeeLabel(l)}
                          </td>
                          <td>{formatDate(l.fromDate || l.startDate)}</td>
                          <td>{l.source || WEEK_OFF_SOURCE_LEAVE}</td>
                          <td>
                            {String(l.status || "").toUpperCase() === "CANCELLED" ? (
                              <span className="dgv-badge dgv-badge--danger">CANCELLED</span>
                            ) : (
                              <span className="dgv-badge dgv-badge--success">
                                Week Off
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section aria-labelledby="leave-requests-today-heading">
              <h3 id="leave-requests-today-heading" style={sectionHeading}>
                Leave Requests Today
              </h3>
              <p style={sectionHint}>
                Leave requests covering today's IST date.
              </p>
              {leaveRequestsTable}
              {requests.length === 0 ? (
                <p style={{ color: colors.textMuted, margin: 0 }}>
                  No leave requests covering today.
                </p>
              ) : null}
            </section>
          </>
        )}
      </div>
    </Layout>
  );
}

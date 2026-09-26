import { useState, useEffect, useCallback } from "react";
import Layout from "../components/Layout";
import WeeklyAttendanceHistory from "../components/WeeklyAttendanceHistory";
import WorkingTimeWidget from "../components/WorkingTimeWidget";
import Button from "../components/ui/Button";
import { pageCard, pageTitle, colors } from "../theme";
import {
  fetchAttendance as fetchAttendanceApi,
  fetchEmployeeShift,
  saveAttendance,
} from "../services/api";
import { getLoggedInEmail } from "../services/auth";
import {
  COMPLIANCE,
  attendanceCompliance,
  formatInstant,
  lateByLabel,
} from "../utils/attendanceCompliance";

const COMPANY_TZ = "Asia/Kolkata";

const STATUS_CLASS = {
  Working: "dgv-status-badge--working",
  Holiday: "dgv-status-badge--holiday",
  Leave: "dgv-status-badge--leave",
  WeeklyOff: "dgv-status-badge--weeklyoff",
};

const TAKER_STATUSES = ["Working", "Leave", "Holiday", "WeeklyOff"];
const WORK_PERIOD_OPTIONS = [
  { value: "FULL_DAY", label: "Full Day" },
  { value: "FIRST_HALF", label: "First Half" },
  { value: "SECOND_HALF", label: "Second Half" },
];
const WORK_PERIOD_LABELS = {
  FULL_DAY: "Full Day",
  FIRST_HALF: "First Half",
  SECOND_HALF: "Second Half",
};

function assignmentAllowsHalfDay(shift) {
  return shift?.halfDayEnabled === true;
}

function visibleWorkPeriodOptions(shift) {
  if (assignmentAllowsHalfDay(shift)) return WORK_PERIOD_OPTIONS;
  return WORK_PERIOD_OPTIONS.filter((item) => item.value === "FULL_DAY");
}
const NO_SHIFT_MESSAGE =
  "Working attendance cannot be submitted until an administrator assigns your shift.";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function companyTodayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: COMPANY_TZ });
}

function addDaysToKey(key, days) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayIndex(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function startOfWeekKey(key) {
  const day = weekdayIndex(key);
  const diff = day === 0 ? -6 : 1 - day;
  return addDaysToKey(key, diff);
}

function formatDisplayDate(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function formatDayName(key) {
  return DAY_NAMES[weekdayIndex(key)];
}

function formatClock(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: COMPANY_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(t));
}

function formatHm(hhmm) {
  if (!hhmm) return "—";
  const d = new Date(`1970-01-01T${hhmm}:00+05:30`);
  return Number.isFinite(d.getTime()) ? formatClock(d.toISOString()) : hhmm;
}

function workPeriodLabel(record) {
  if (record?.workPeriod && WORK_PERIOD_LABELS[record.workPeriod]) {
    return WORK_PERIOD_LABELS[record.workPeriod];
  }
  return record?.dayType || null;
}

function submittedRowFromSave(todayKey, payload, apiItem) {
  const fromApi = apiItem
    ? recordFromApi({ ...apiItem, date: apiItem.date || todayKey })
    : null;
  const working = payload.status === "Working";
  return {
    status: fromApi?.status || payload.status,
    hours: fromApi?.hours ?? null,
    dayType: working ? fromApi?.dayType || null : null,
    shift: working ? fromApi?.shiftName || fromApi?.shift || null : null,
    shiftId: fromApi?.shiftId || null,
    shiftName: fromApi?.shiftName || null,
    expectedStartTime: fromApi?.expectedStartTime || null,
    expectedEndTime: fromApi?.expectedEndTime || null,
    actualCheckInTime: fromApi?.actualCheckInTime || null,
    actualCheckOutTime: fromApi?.actualCheckOutTime || null,
    workedBeyondShift: fromApi?.workedBeyondShift ?? null,
    workedBeyondReason: fromApi?.workedBeyondReason || null,
    graceMinutes: fromApi?.graceMinutes ?? null,
    crossesMidnight: fromApi?.crossesMidnight ?? null,
    workPeriod: working ? payload.workPeriod || fromApi?.workPeriod || null : null,
    timingStatus: fromApi?.timingStatus || null,
    lateMinutes: fromApi?.lateMinutes ?? null,
    attendanceSubmittedAt: fromApi?.attendanceSubmittedAt || null,
    reason:
      fromApi?.reason ||
      payload.reason ||
      (payload.status === "Leave" || payload.status === "Holiday"
        ? payload.status
        : null),
    submittedAt: fromApi?.submittedAt || new Date().toISOString(),
    checkInTime: fromApi?.checkInTime || null,
    checkOutTime: fromApi?.checkOutTime || null,
    workingTime: fromApi?.workingTime || null,
    workingSeconds: fromApi?.workingSeconds ?? null,
    sessionStatus:
      fromApi?.sessionStatus || (working ? "Present" : payload.status),
  };
}

function resultLabel(record) {
  if (!record?.status) return "Attendance Not Marked";
  if (record.status === "Leave") return "Absent — Leave";
  if (record.status === "Holiday") return "Absent — Holiday";
  if (record.status === "WeeklyOff") return "Weekly Off";
  if (record.status === "Working") {
    const period = workPeriodLabel(record);
    return period ? `Working / ${period}` : "Working";
  }
  return record.status;
}

function recordFromApi(item) {
  const key = item.date;
  if (!key) return null;
  return {
    status: item.status || null,
    hours: item.hours ?? null,
    dayType: item.dayType || null,
    shift: item.shiftName || item.shift || null,
    shiftId: item.shiftId || null,
    shiftName: item.shiftName || null,
    expectedStartTime: item.expectedStartTime || null,
    expectedEndTime: item.expectedEndTime || null,
    graceMinutes: item.graceMinutes ?? null,
    crossesMidnight: item.crossesMidnight ?? null,
    workPeriod: item.workPeriod || null,
    timingStatus: item.timingStatus || null,
    lateMinutes: item.lateMinutes ?? null,
    attendanceSubmittedAt: item.attendanceSubmittedAt || null,
    actualCheckInTime: item.actualCheckInTime || null,
    actualCheckOutTime: item.actualCheckOutTime || null,
    workedBeyondShift: item.workedBeyondShift ?? null,
    workedBeyondReason: item.workedBeyondReason || null,
    reason: item.reason || null,
    submittedAt: item.submittedAt || null,
    checkInTime: item.checkInTime || null,
    checkOutTime: item.checkOutTime || null,
    workingTime: item.workingTime || null,
    workingSeconds: item.workingSeconds ?? null,
    sessionStatus: item.sessionStatus || null,
  };
}

function AssignedShiftReadOnly({ shift, loadError, dateKey }) {
  if (loadError) {
    return (
      <div className="dgv-attendance-taker__field">
        <div className="dgv-attendance-taker__label">Assigned Shift</div>
        <div className="dgv-attendance-taker__value">{loadError}</div>
      </div>
    );
  }
  if (!shift?.name) {
    return (
      <div className="dgv-attendance-taker__field">
        <div className="dgv-attendance-taker__label">Assigned Shift</div>
        <div className="dgv-attendance-taker__value">Not assigned</div>
      </div>
    );
  }
  const grace = Number(shift.graceMinutes) || 0;
  const expected = attendanceCompliance({
    dateKey,
    todayKey: dateKey,
    shift,
  });
  return (
    <>
      <div className="dgv-attendance-taker__field">
        <div className="dgv-attendance-taker__label">Assigned Shift</div>
        <div className="dgv-attendance-taker__value">{shift.name}</div>
      </div>
      <div className="dgv-attendance-taker__field">
        <div className="dgv-attendance-taker__label">Shift Timing</div>
        <div className="dgv-attendance-taker__value">
          {formatHm(shift.startTime)} — {formatHm(shift.endTime)}
          {shift.crossesMidnight ? " (overnight)" : ""}
        </div>
      </div>
      {grace > 0 ? (
        <div className="dgv-attendance-taker__field">
          <div className="dgv-attendance-taker__label">Grace Period</div>
          <div className="dgv-attendance-taker__value">{grace} min</div>
        </div>
      ) : null}
      {expected.expectedByMs ? (
        <div className="dgv-attendance-taker__field">
          <div className="dgv-attendance-taker__label">Expected By</div>
          <div className="dgv-attendance-taker__value">
            {formatInstant(expected.expectedByMs)}
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function Attendance() {
  const todayKey = companyTodayKey();
  const [historyWeekStart, setHistoryWeekStart] = useState(() =>
    startOfWeekKey(companyTodayKey())
  );
  const [attendanceData, setAttendanceData] = useState({});
  const [loadingWeek, setLoadingWeek] = useState(true);
  const [weekError, setWeekError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [assignedShift, setAssignedShift] = useState(null);
  const [shiftLoadError, setShiftLoadError] = useState("");
  const [shiftReady, setShiftReady] = useState(false);
  const [formError, setFormError] = useState("");

  const [status, setStatus] = useState("");
  const [workPeriod, setWorkPeriod] = useState("");

  const todayRecord = attendanceData[todayKey] || {};
  const submitted = !!todayRecord.submittedAt;

  const loadRange = useCallback(async (start, end) => {
    const data = await fetchAttendanceApi(start, end);
    const obj = {};
    if (Array.isArray(data)) {
      data.forEach((item) => {
        const row = recordFromApi(item);
        if (row && item.date) obj[item.date] = row;
      });
    }
    return obj;
  }, []);

  const loadAssignedShift = useCallback(async () => {
    setShiftReady(false);
    try {
      const email = getLoggedInEmail();
      if (!email) {
        setAssignedShift(null);
        setShiftLoadError("");
        return;
      }
      const res = await fetchEmployeeShift(email);
      const next = res?.shift || null;
      setAssignedShift(next);
      setShiftLoadError("");
      if (!assignmentAllowsHalfDay(next)) {
        setWorkPeriod((prev) =>
          prev === "FIRST_HALF" || prev === "SECOND_HALF" ? "FULL_DAY" : prev
        );
      }
    } catch (err) {
      console.error("Fetch assigned shift error:", err);
      setAssignedShift(null);
      setShiftLoadError(err?.message || "Unable to load assigned shift.");
    } finally {
      setShiftReady(true);
    }
  }, []);

  const loadAttendance = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoadingWeek(true);
      setWeekError("");
    }
    try {
      const start = historyWeekStart;
      const end = addDaysToKey(historyWeekStart, 6);
      const today = companyTodayKey();
      const weekData = await loadRange(start, end);
      let merged = { ...weekData };
      if (today < start || today > end) {
        const todayData = await loadRange(today, today);
        merged = { ...merged, ...todayData };
      }
      setAttendanceData((prev) => {
        const next = { ...merged };
        const locked = prev[today];
        if (locked?.submittedAt && !next[today]?.submittedAt) {
          next[today] = { ...next[today], ...locked };
        } else if (locked?.submittedAt && next[today]) {
          next[today] = {
            ...locked,
            ...next[today],
            submittedAt: next[today].submittedAt || locked.submittedAt,
            checkInTime: next[today].checkInTime || locked.checkInTime,
            checkOutTime: next[today].checkOutTime || locked.checkOutTime,
            timingStatus: next[today].timingStatus || locked.timingStatus,
            lateMinutes:
              next[today].lateMinutes ?? locked.lateMinutes ?? null,
            workPeriod: next[today].workPeriod || locked.workPeriod,
            shiftName: next[today].shiftName || locked.shiftName,
            expectedStartTime:
              next[today].expectedStartTime || locked.expectedStartTime,
            expectedEndTime:
              next[today].expectedEndTime || locked.expectedEndTime,
          };
        }
        return next;
      });
    } catch (err) {
      console.error("Fetch attendance error:", err);
      if (!silent) {
        setWeekError("Unable to load weekly attendance. Please try again.");
      }
    } finally {
      if (!silent) setLoadingWeek(false);
    }
  }, [historyWeekStart, loadRange]);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance]);

  useEffect(() => {
    loadAssignedShift();
  }, [loadAssignedShift]);

  useEffect(() => {
    if (assignmentAllowsHalfDay(assignedShift)) return;
    setWorkPeriod((prev) =>
      prev === "FIRST_HALF" || prev === "SECOND_HALF" ? "FULL_DAY" : prev
    );
  }, [assignedShift]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        loadAttendance({ silent: true });
        loadAssignedShift();
      }
    };
    const onFocus = () => {
      loadAttendance({ silent: true });
      loadAssignedShift();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadAttendance, loadAssignedShift]);

  const selectStatus = (item) => {
    setStatus(item);
    setFormError("");
    if (item !== "Working") {
      setWorkPeriod("");
      return;
    }
    if (shiftReady && !assignedShift) {
      setFormError(NO_SHIFT_MESSAGE);
    }
    setWorkPeriod((prev) =>
      assignmentAllowsHalfDay(assignedShift) &&
      (prev === "FIRST_HALF" || prev === "SECOND_HALF")
        ? prev
        : "FULL_DAY"
    );
  };

  const submitAttendance = async () => {
    if (submitted || submitting) {
      if (submitted) alert("Today's attendance is already submitted.");
      return;
    }
    if (!status) {
      alert("Please select today's attendance status.");
      return;
    }
    if (status === "Working") {
      if (!assignedShift) {
        setFormError(NO_SHIFT_MESSAGE);
        return;
      }
      if (!workPeriod) {
        alert("Please select Full Day, First Half, or Second Half.");
        return;
      }
    }

    const payload = {
      date: todayKey,
      status,
    };
    if (status === "Working") {
      payload.workPeriod = workPeriod;
    } else if (status === "Leave") {
      payload.reason = "Leave";
    } else if (status === "Holiday") {
      payload.reason = "Holiday";
    }

    setSubmitting(true);
    setFormError("");
    try {
      const res = await saveAttendance([payload]);
      const savedRow = submittedRowFromSave(todayKey, payload, res?.attendance);
      setAttendanceData((prev) => ({ ...prev, [todayKey]: savedRow }));
      setStatus("");
      setWorkPeriod("");
      await loadAttendance({ silent: true });
    } catch (err) {
      console.error("Submit error:", err);
      const already = /already been submitted|already submitted/i.test(
        String(err.message || "")
      );
      const noShift = /no shift is assigned/i.test(String(err.message || ""));
      if (already) {
        if (err.attendance) {
          const lockedRow = recordFromApi({
            ...err.attendance,
            date: err.attendance.date || todayKey,
          });
          if (lockedRow?.submittedAt) {
            setAttendanceData((prev) => ({ ...prev, [todayKey]: lockedRow }));
          }
        }
        await loadAttendance({ silent: true });
      }
      if (noShift) {
        setFormError(NO_SHIFT_MESSAGE);
      } else {
        alert(err.message || "Failed to submit attendance");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const goToPreviousWeek = () =>
    setHistoryWeekStart((prev) => addDaysToKey(prev, -7));
  const goToNextWeek = () =>
    setHistoryWeekStart((prev) => addDaysToKey(prev, 7));
  const goToCurrentWeek = () =>
    setHistoryWeekStart(startOfWeekKey(companyTodayKey()));

  const working = status === "Working";
  const workingBlocked = working && shiftReady && !assignedShift;
  const lockedShiftName =
    todayRecord.shiftName || todayRecord.shift || assignedShift?.name;
  const lockedTiming = `${formatClock(
    todayRecord.expectedStartTime || todayRecord.checkInTime
  )} — ${formatClock(todayRecord.expectedEndTime || todayRecord.checkOutTime)}`;

  return (
    <Layout>
      <div style={pageCard}>
        <h1 style={pageTitle}>Attendance</h1>
        <p style={{ color: colors.textMuted, marginTop: 0, marginBottom: 16 }}>
          Submit today&apos;s attendance, then review history in My Attendance.
        </p>

        <section className="dgv-attendance-taker" aria-labelledby="today-attendance-title">
          <div className="dgv-attendance-taker__head">
            <h2 id="today-attendance-title" className="dgv-attendance-taker__title">
              Today&apos;s Attendance
            </h2>
            <span
              className={
                submitted
                  ? "dgv-badge dgv-badge--success"
                  : "dgv-badge dgv-badge--info"
              }
            >
              {submitted ? "Attendance Submitted — Locked" : "Attendance Not Marked"}
            </span>
          </div>

          {submitted ? (
            <div className="dgv-attendance-taker__locked">
              <div>
                <div className="dgv-attendance-taker__label">Date</div>
                <div className="dgv-attendance-taker__value">
                  {formatDisplayDate(todayKey)}
                </div>
              </div>
              <div>
                <div className="dgv-attendance-taker__label">Day</div>
                <div className="dgv-attendance-taker__value">
                  {formatDayName(todayKey)}
                </div>
              </div>
              <div>
                <div className="dgv-attendance-taker__label">Status</div>
                <div className="dgv-attendance-taker__value">
                  ✓ {resultLabel(todayRecord)}
                </div>
              </div>
              {todayRecord.status === "Working" ? (
                <>
                  <div>
                    <div className="dgv-attendance-taker__label">Working Type</div>
                    <div className="dgv-attendance-taker__value">
                      ✓ {workPeriodLabel(todayRecord) || "—"}
                    </div>
                  </div>
                  <div>
                    <div className="dgv-attendance-taker__label">Shift</div>
                    <div className="dgv-attendance-taker__value">
                      ✓ {lockedShiftName || "—"}
                    </div>
                  </div>
                  <div>
                    <div className="dgv-attendance-taker__label">Shift Timing</div>
                    <div className="dgv-attendance-taker__value">{lockedTiming}</div>
                  </div>
                  {(() => {
                    const compliance = attendanceCompliance({
                      dateKey: todayKey,
                      todayKey,
                      record: todayRecord,
                      shift: assignedShift,
                    });
                    return (
                      <>
                        <div>
                          <div className="dgv-attendance-taker__label">
                            Expected By
                          </div>
                          <div className="dgv-attendance-taker__value">
                            {compliance.expectedByMs
                              ? formatInstant(compliance.expectedByMs)
                              : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="dgv-attendance-taker__label">
                            Marked At
                          </div>
                          <div className="dgv-attendance-taker__value">
                            {compliance.markedAtMs
                              ? formatInstant(compliance.markedAtMs)
                              : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="dgv-attendance-taker__label">Timing</div>
                          <div className="dgv-attendance-taker__value">
                            {compliance.status}
                            {compliance.status === COMPLIANCE.LATE &&
                            compliance.lateMinutes != null
                              ? ` · ${lateByLabel(compliance.lateMinutes)} late`
                              : ""}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </>
              ) : null}
              <p className="dgv-attendance-taker__hint" style={{ gridColumn: "1 / -1" }}>
                ✓ Attendance Submitted · Attendance Locked
              </p>
            </div>
          ) : (
            <>
              <div className="dgv-attendance-taker__meta">
                <div>
                  <div className="dgv-attendance-taker__label">Date</div>
                  <div className="dgv-attendance-taker__value">
                    {formatDisplayDate(todayKey)}
                  </div>
                </div>
                <div>
                  <div className="dgv-attendance-taker__label">Day</div>
                  <div className="dgv-attendance-taker__value">
                    {formatDayName(todayKey)}
                  </div>
                </div>
                <div className="dgv-attendance-taker__field">
                  <span className="dgv-attendance-taker__label">Status</span>
                  <div className="dgv-attendance-taker__statuses">
                    {TAKER_STATUSES.map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => selectStatus(item)}
                        className={`dgv-status-badge ${STATUS_CLASS[item]} ${
                          status === item ? "is-active" : ""
                        }`}
                        aria-pressed={status === item}
                      >
                        {item === "WeeklyOff" ? "Weekly Off" : item}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="dgv-attendance-taker__grid">
                <AssignedShiftReadOnly
                  shift={assignedShift}
                  loadError={shiftLoadError}
                  dateKey={todayKey}
                />
              </div>

              {status === "Leave" ? (
                <p className="dgv-attendance-taker__hint">
                  Result: Absent — Leave
                </p>
              ) : null}
              {status === "Holiday" ? (
                <p className="dgv-attendance-taker__hint">
                  Result: Absent — Holiday
                </p>
              ) : null}
              {status === "WeeklyOff" ? (
                <p className="dgv-attendance-taker__hint">Result: Weekly Off</p>
              ) : null}

              {working ? (
                <>
                  <div className="dgv-attendance-taker__grid">
                    <div className="dgv-attendance-taker__field">
                      <span className="dgv-attendance-taker__label">
                        Working Type
                      </span>
                      <div className="dgv-attendance-taker__statuses">
                        {visibleWorkPeriodOptions(assignedShift).map((item) => (
                          <button
                            key={item.value}
                            type="button"
                            onClick={() => {
                              setWorkPeriod(item.value);
                              setFormError("");
                            }}
                            className={`dgv-status-badge dgv-status-badge--working ${
                              workPeriod === item.value ? "is-active" : ""
                            }`}
                            aria-pressed={workPeriod === item.value}
                            disabled={workingBlocked}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {workingBlocked || formError ? (
                    <p className="dgv-attendance-taker__hint" role="alert">
                      {formError || NO_SHIFT_MESSAGE}
                    </p>
                  ) : (
                    <p className="dgv-attendance-taker__hint">
                      Shift timing comes from your Admin-assigned shift.
                    </p>
                  )}
                </>
              ) : formError ? (
                <p className="dgv-attendance-taker__hint" role="alert">
                  {formError}
                </p>
              ) : null}

              <div className="dgv-attendance-taker__actions">
                <Button
                  type="button"
                  onClick={submitAttendance}
                  disabled={submitting || submitted || workingBlocked}
                >
                  {submitting ? "Submitting..." : "Submit Attendance"}
                </Button>
              </div>
            </>
          )}
        </section>

        {submitted && todayRecord.status === "Working" ? (
          <div style={{ marginTop: 20 }}>
            <WorkingTimeWidget />
          </div>
        ) : null}

        <div style={{ marginTop: 36 }}>
          <WeeklyAttendanceHistory
            weekStart={historyWeekStart}
            attendanceData={attendanceData}
            loading={loadingWeek}
            error={weekError}
            todayKey={todayKey}
            assignedShift={assignedShift}
            onPreviousWeek={goToPreviousWeek}
            onCurrentWeek={goToCurrentWeek}
            onNextWeek={goToNextWeek}
          />
        </div>
      </div>
    </Layout>
  );
}

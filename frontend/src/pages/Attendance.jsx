import { useState, useEffect, useCallback } from "react";
import Layout from "../components/Layout";
import WeeklyAttendanceHistory from "../components/WeeklyAttendanceHistory";
import Button from "../components/ui/Button";
import { pageCard, pageTitle, colors } from "../theme";
import {
  fetchAttendance as fetchAttendanceApi,
  saveAttendance,
} from "../services/api";

const COMPANY_TZ = "Asia/Kolkata";

const STATUS_CLASS = {
  Working: "dgv-status-badge--working",
  Holiday: "dgv-status-badge--holiday",
  Leave: "dgv-status-badge--leave",
  WeeklyOff: "dgv-status-badge--weeklyoff",
};

const TAKER_STATUSES = ["Working", "Leave", "Holiday", "WeeklyOff"];
const SHIFTS = ["Morning Shift", "Afternoon Shift", "Evening Shift"];
const SHIFT_TIMES = {
  "Full Day": {
    "Morning Shift": { in: "11:00", out: "20:00", label: "11:00 AM — 08:00 PM" },
    "Afternoon Shift": { in: "14:00", out: "23:00", label: "02:00 PM — 11:00 PM" },
    "Evening Shift": { in: "17:00", out: "23:00", label: "05:00 PM — 11:00 PM" },
  },
  "Half Day": {
    "Morning Shift": { in: "11:00", out: "15:30", label: "11:00 AM — 03:30 PM" },
    "Afternoon Shift": { in: "14:00", out: "18:30", label: "02:00 PM — 06:30 PM" },
    "Evening Shift": { in: "17:00", out: "20:30", label: "05:00 PM — 08:30 PM" },
  },
};

function getShiftTiming(dayType, shift) {
  return SHIFT_TIMES[dayType]?.[shift] || null;
}

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

function combineDateAndTime(dateKey, hhmm) {
  if (!dateKey || !hhmm) return null;
  const d = new Date(`${dateKey}T${hhmm}:00+05:30`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function submittedRowFromSave(todayKey, payload, apiItem) {
  const fromApi = apiItem ? recordFromApi({ ...apiItem, date: apiItem.date || todayKey }) : null;
  const working = payload.status === "Working";
  const timing = working ? getShiftTiming(payload.dayType, payload.shift) : null;
  return {
    status: fromApi?.status || payload.status,
    hours: fromApi?.hours ?? null,
    dayType: working ? payload.dayType || fromApi?.dayType || null : null,
    shift: working ? payload.shift || fromApi?.shift || null : null,
    reason:
      fromApi?.reason ||
      payload.reason ||
      (payload.status === "Leave" || payload.status === "Holiday"
        ? payload.status
        : null),
    submittedAt: fromApi?.submittedAt || new Date().toISOString(),
    checkInTime:
      fromApi?.checkInTime ||
      (timing ? combineDateAndTime(todayKey, timing.in) : null),
    checkOutTime:
      fromApi?.checkOutTime ||
      (timing ? combineDateAndTime(todayKey, timing.out) : null),
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
    return record.dayType ? `Working / ${record.dayType}` : "Working";
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
    shift: item.shift || null,
    reason: item.reason || null,
    submittedAt: item.submittedAt || null,
    checkInTime: item.checkInTime || null,
    checkOutTime: item.checkOutTime || null,
    workingTime: item.workingTime || null,
    workingSeconds: item.workingSeconds ?? null,
    sessionStatus: item.sessionStatus || null,
  };
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

  const [status, setStatus] = useState("");
  const [dayType, setDayType] = useState("");
  const [shift, setShift] = useState("");

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
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        loadAttendance({ silent: true });
      }
    };
    const onFocus = () => loadAttendance({ silent: true });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadAttendance]);

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
      if (!dayType) {
        alert("Please select Full Day or Half Day.");
        return;
      }
      if (!shift) {
        alert("Please select a shift.");
        return;
      }
      if (!getShiftTiming(dayType, shift)) {
        alert("Please select a valid shift.");
        return;
      }
    }

    const payload = {
      date: todayKey,
      status,
    };
    if (status === "Working") {
      payload.dayType = dayType;
      payload.shift = shift;
    } else if (status === "Leave") {
      payload.reason = "Leave";
    } else if (status === "Holiday") {
      payload.reason = "Holiday";
    }

    setSubmitting(true);
    try {
      const res = await saveAttendance([payload]);
      const savedRow = submittedRowFromSave(todayKey, payload, res?.attendance);
      setAttendanceData((prev) => ({ ...prev, [todayKey]: savedRow }));
      setStatus("");
      setDayType("");
      setShift("");
      await loadAttendance({ silent: true });
    } catch (err) {
      console.error("Submit error:", err);
      const already = /already been submitted|already submitted/i.test(
        String(err.message || "")
      );
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
      alert(err.message || "Failed to submit attendance");
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
  const shiftTiming = working ? getShiftTiming(dayType, shift) : null;

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
                      ✓ {todayRecord.dayType || "—"}
                    </div>
                  </div>
                  <div>
                    <div className="dgv-attendance-taker__label">Shift</div>
                    <div className="dgv-attendance-taker__value">
                      ✓ {todayRecord.shift || "—"}
                    </div>
                  </div>
                  <div>
                    <div className="dgv-attendance-taker__label">Shift Timing</div>
                    <div className="dgv-attendance-taker__value">
                      {getShiftTiming(todayRecord.dayType, todayRecord.shift)?.label ||
                        `${formatClock(todayRecord.checkInTime)} — ${formatClock(todayRecord.checkOutTime)}`}
                    </div>
                  </div>
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
                        onClick={() => {
                          setStatus(item);
                          if (item !== "Working") {
                            setDayType("");
                            setShift("");
                          }
                        }}
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
                        {["Full Day", "Half Day"].map((item) => (
                          <button
                            key={item}
                            type="button"
                            onClick={() => setDayType(item)}
                            className={`dgv-status-badge dgv-status-badge--working ${
                              dayType === item ? "is-active" : ""
                            }`}
                            aria-pressed={dayType === item}
                          >
                            {item}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="dgv-attendance-taker__field">
                      <label className="dgv-attendance-taker__label" htmlFor="att-shift">
                        Shift
                      </label>
                      <select
                        id="att-shift"
                        className="dgv-select"
                        value={shift}
                        onChange={(e) => setShift(e.target.value)}
                      >
                        <option value="">Select shift</option>
                        {SHIFTS.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </div>
                    {shiftTiming ? (
                      <div className="dgv-attendance-taker__field">
                        <div className="dgv-attendance-taker__label">
                          Shift Timing
                        </div>
                        <div className="dgv-attendance-taker__value">
                          {shiftTiming.label}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <p className="dgv-attendance-taker__hint">
                    Shift timing is automatically assigned based on your selected shift.
                  </p>
                </>
              ) : null}

              <div className="dgv-attendance-taker__actions">
                <Button
                  type="button"
                  onClick={submitAttendance}
                  disabled={submitting || submitted}
                >
                  {submitting ? "Submitting..." : "Submit Attendance"}
                </Button>
              </div>
            </>
          )}
        </section>

        <div style={{ marginTop: 36 }}>
          <WeeklyAttendanceHistory
            weekStart={historyWeekStart}
            attendanceData={attendanceData}
            loading={loadingWeek}
            error={weekError}
            todayKey={todayKey}
            onPreviousWeek={goToPreviousWeek}
            onCurrentWeek={goToCurrentWeek}
            onNextWeek={goToNextWeek}
          />
        </div>
      </div>
    </Layout>
  );
}

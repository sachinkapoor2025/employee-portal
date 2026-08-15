import { useState, useEffect, useCallback } from "react";
import Layout from "../components/Layout";
import WeeklyAttendanceHistory from "../components/WeeklyAttendanceHistory";
import { pageCard, pageTitle, colors } from "../theme";
import {
  fetchAttendance as fetchAttendanceApi,
  saveAttendance,
} from "../services/api";

/* ======================
   BUTTON COLORS
====================== */

const BLUE_BTN = "#2563eb";

const STATUS_CLASS = {
  Working: "dgv-status-badge--working",
  Holiday: "dgv-status-badge--holiday",
  Leave: "dgv-status-badge--leave",
  WeeklyOff: "dgv-status-badge--weeklyoff",
  PlannedOff: "dgv-status-badge--holiday",
};

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const start = new Date(d.setDate(diff));
  start.setHours(0, 0, 0, 0);
  return start;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getWeekDates(start) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function Attendance() {
  const [currentWeekStart, setCurrentWeekStart] = useState(() =>
    getStartOfWeek(new Date())
  );
  const [attendanceData, setAttendanceData] = useState({});
  const [lockedDates, setLockedDates] = useState({});
  const [loadingWeek, setLoadingWeek] = useState(true);
  const [weekError, setWeekError] = useState("");

  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  function isWithinEditableRange(date) {
    const today = startOfDay(new Date());
    const target = startOfDay(date);

    const oneWeekAgo = new Date(today);
    oneWeekAgo.setDate(today.getDate() - 7);

    const threeDaysAhead = new Date(today);
    threeDaysAhead.setDate(today.getDate() + 3);

    return target >= oneWeekAgo && target <= threeDaysAhead;
  }

  /* ======================
     FETCH ATTENDANCE (own records only — API scopes by auth token)
  ====================== */

  const loadWeekAttendance = useCallback(async (start, end) => {
    setLoadingWeek(true);
    setWeekError("");
    try {
      const data = await fetchAttendanceApi(start, end);

      if (!Array.isArray(data)) {
        setAttendanceData({});
        setLockedDates({});
        return;
      }

      const obj = {};
      const locked = {};

      data.forEach((item) => {
        const key = item.date;
        if (!key) return;
        obj[key] = {
          status: item.status || null,
          hours: item.hours ?? null,
          checkInTime: item.checkInTime || null,
          checkOutTime: item.checkOutTime || null,
          workingTime: item.workingTime || null,
          workingSeconds: item.workingSeconds ?? null,
          sessionStatus: item.sessionStatus || null,
        };
        // Submitted / stored records are locked for re-edit in the marking UI
        locked[key] = true;
      });

      setAttendanceData(obj);
      setLockedDates(locked);
    } catch (err) {
      console.error("Fetch attendance error:", err);
      setWeekError("Unable to load weekly attendance. Please try again.");
      setAttendanceData({});
      setLockedDates({});
    } finally {
      setLoadingWeek(false);
    }
  }, []);

  /* ======================
     SUBMIT ATTENDANCE
  ====================== */

  const submitAttendance = async () => {
    const attendance = getWeekDates(currentWeekStart)
      .map((date) => {
        const dateStr = formatDate(date);
        const data = attendanceData[dateStr];

        if (!data?.status) return null;
        if (!isWithinEditableRange(date)) return null;
        if (lockedDates[dateStr]) return null;

        return {
          date: dateStr,
          status: data.status,
          hours: data.hours || 0,
        };
      })
      .filter(Boolean);

    if (attendance.length === 0) {
      alert("No valid attendance to submit");
      return;
    }

    try {
      await saveAttendance(attendance);
      alert("Attendance submitted successfully");

      const dates = getWeekDates(currentWeekStart);
      await loadWeekAttendance(formatDate(dates[0]), formatDate(dates[6]));
    } catch (err) {
      console.error("Submit error:", err);
      alert(err.message || "Failed to submit attendance");
    }
  };

  const updateAttendance = (dateStr, updates) => {
    setAttendanceData((prev) => ({
      ...prev,
      [dateStr]: { ...prev[dateStr], ...updates },
    }));
  };

  const goToPreviousWeek = () =>
    setCurrentWeekStart((prev) => new Date(prev.getTime() - 7 * 86400000));

  const goToNextWeek = () =>
    setCurrentWeekStart((prev) => new Date(prev.getTime() + 7 * 86400000));

  const goToCurrentWeek = () => setCurrentWeekStart(getStartOfWeek(new Date()));

  useEffect(() => {
    const dates = getWeekDates(currentWeekStart);
    loadWeekAttendance(formatDate(dates[0]), formatDate(dates[6]));
  }, [currentWeekStart, loadWeekAttendance]);

  // Refresh when returning to the tab (e.g. after dashboard check-in)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const dates = getWeekDates(currentWeekStart);
      loadWeekAttendance(formatDate(dates[0]), formatDate(dates[6]));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [currentWeekStart, loadWeekAttendance]);

  const dates = getWeekDates(currentWeekStart);

  /* ======================
     UI
  ====================== */

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Attendance</h2>
        <p style={{ color: colors.textMuted, marginTop: 0, marginBottom: 16 }}>
          Mark your weekly status below, then review check-in history in My
          Attendance.
        </p>

        {/* WEEK NAVIGATION (marking) */}
        <button
          type="button"
          onClick={goToPreviousWeek}
          style={{
            background: BLUE_BTN,
            color: "#fff",
            border: "none",
            padding: "8px 14px",
            borderRadius: 8,
            cursor: "pointer",
            fontWeight: 500,
            transition: "transform 0.3s ease, opacity 0.3s ease",
          }}
        >
          Previous Week
        </button>

        <button
          type="button"
          onClick={goToCurrentWeek}
          style={{
            marginLeft: 10,
            background: "transparent",
            color: colors.text,
            border: `1px solid ${colors.border}`,
            padding: "8px 14px",
            borderRadius: 8,
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          Current Week
        </button>

        <button
          type="button"
          onClick={goToNextWeek}
          style={{
            marginLeft: 10,
            background: BLUE_BTN,
            color: "#fff",
            border: "none",
            padding: "8px 14px",
            borderRadius: 8,
            cursor: "pointer",
            fontWeight: 500,
            transition: "transform 0.3s ease, opacity 0.3s ease",
          }}
        >
          Next Week
        </button>

        {/* MARKING TABLE — existing functionality */}
        <div className="dgv-table-wrap" style={{ marginTop: 20 }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              color: colors.text,
            }}
          >
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 10 }}>Date</th>
                <th style={{ textAlign: "left", padding: 10 }}>Day</th>
                <th style={{ textAlign: "left", padding: 10 }}>Status</th>
              </tr>
            </thead>

            <tbody>
              {dates.map((date) => {
                const dateStr = formatDate(date);
                const data = attendanceData[dateStr] || {};
                const editable =
                  isWithinEditableRange(date) && !lockedDates[dateStr];
                const isToday = formatDate(startOfDay(new Date())) === dateStr;

                return (
                  <tr
                    key={dateStr}
                    style={
                      isToday
                        ? { background: "var(--dgv-accent-soft)" }
                        : undefined
                    }
                  >
                    <td style={{ padding: 10 }}>
                      {dateStr}
                      {isToday ? (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            fontWeight: 700,
                            color: "var(--dgv-accent)",
                          }}
                        >
                          Today
                        </span>
                      ) : null}
                    </td>
                    <td style={{ padding: 10 }}>{dayNames[date.getDay()]}</td>

                    <td style={{ padding: 10 }}>
                      {(data.status === "PlannedOff"
                        ? ["Working", "Holiday", "Leave", "WeeklyOff", "PlannedOff"]
                        : ["Working", "Holiday", "Leave", "WeeklyOff"]
                      ).map((status) => {
                          const isActive = data.status === status;

                          return (
                            <button
                              key={status}
                              type="button"
                              disabled={!editable || status === "PlannedOff"}
                              onClick={() =>
                                editable &&
                                status !== "PlannedOff" &&
                                updateAttendance(dateStr, { status })
                              }
                              className={`dgv-status-badge ${STATUS_CLASS[status]} ${
                                isActive ? "is-active" : ""
                              }`}
                              aria-pressed={isActive}
                            >
                              {status === "PlannedOff" ? "Planned Off" : status}
                            </button>
                          );
                        }
                      )}

                      {data.status === "Working" && (
                        <input
                          type="number"
                          disabled={!editable}
                          value={data.hours ?? ""}
                          onChange={(e) =>
                            editable &&
                            updateAttendance(dateStr, {
                              hours: Number(e.target.value),
                            })
                          }
                          style={{
                            width: 60,
                            marginLeft: 8,
                            padding: 4,
                            borderRadius: 6,
                            border: `1px solid ${colors.border}`,
                            background: "var(--dgv-surface-solid)",
                            color: "var(--dgv-text)",
                          }}
                          aria-label={`Hours for ${dateStr}`}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <button
          type="button"
          onClick={submitAttendance}
          style={{
            marginTop: 20,
            background: BLUE_BTN,
            color: "#fff",
            border: "none",
            padding: "10px 18px",
            borderRadius: 10,
            cursor: "pointer",
            fontSize: 15,
            fontWeight: 600,
            transition: "transform 0.3s ease, opacity 0.3s ease",
          }}
        >
          Submit Attendance
        </button>

        {/* WEEKLY HISTORY — read-only tracker */}
        <div style={{ marginTop: 36 }}>
          <WeeklyAttendanceHistory
            weekStart={currentWeekStart}
            attendanceData={attendanceData}
            loading={loadingWeek}
            error={weekError}
            onPreviousWeek={goToPreviousWeek}
            onCurrentWeek={goToCurrentWeek}
            onNextWeek={goToNextWeek}
          />
        </div>
      </div>
    </Layout>
  );
}

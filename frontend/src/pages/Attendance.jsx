import { useState, useEffect, useCallback } from "react";
import Layout from "../components/Layout";
import { pageCard, pageTitle, colors } from "../theme";

/* ======================
   BUTTON COLORS
====================== */

const API_URL =
  process.env.REACT_APP_API_URL ||
  "https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod";

const BLUE_BTN = "#2563eb";

const STATUS_CLASS = {
  Working: "dgv-status-badge--working",
  Holiday: "dgv-status-badge--holiday",
  Leave: "dgv-status-badge--leave",
  WeeklyOff: "dgv-status-badge--weeklyoff",
};

export default function Attendance() {
  const [currentWeekStart, setCurrentWeekStart] = useState(() =>
    getStartOfWeek(new Date())
  );
  const [attendanceData, setAttendanceData] = useState({});
  const [lockedDates, setLockedDates] = useState({});

  const token = localStorage.getItem("token");

  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  /* ======================
     DATE HELPERS
  ====================== */

  function getStartOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
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
     FETCH ATTENDANCE
  ====================== */

  const fetchAttendance = useCallback(async (start, end) => {
    try {
      const res = await fetch(
        `${API_URL}/attendance?startDate=${start}&endDate=${end}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const data = await res.json();

      if (!Array.isArray(data)) {
        setAttendanceData({});
        setLockedDates({});
        return;
      }

      const obj = {};
      const locked = {};

      data.forEach((item) => {
        obj[item.date] = {
          status: item.status,
          hours: item.hours || 0,
        };
        locked[item.date] = true;
      });

      setAttendanceData(obj);
      setLockedDates(locked);
    } catch (err) {
      console.error("Fetch attendance error:", err);
    }
  }, [token]);

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
      const res = await fetch(`${API_URL}/attendance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(attendance),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Submit failed (${res.status})`);
      }

      alert("Attendance submitted successfully");

      const dates = getWeekDates(currentWeekStart);
      fetchAttendance(formatDate(dates[0]), formatDate(dates[6]));
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

  useEffect(() => {
    const dates = getWeekDates(currentWeekStart);
    fetchAttendance(formatDate(dates[0]), formatDate(dates[6]));
  }, [currentWeekStart, fetchAttendance]);

  const dates = getWeekDates(currentWeekStart);

  /* ======================
     UI
  ====================== */

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Attendance</h2>

        {/* WEEK NAVIGATION */}
        <button
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

        {/* TABLE */}
        <div className="dgv-table-wrap" style={{ marginTop: 20 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", color: colors.text }}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Day</th>
              <th>Status</th>
            </tr>
          </thead>

          <tbody>
            {dates.map((date) => {
              const dateStr = formatDate(date);
              const data = attendanceData[dateStr] || {};
              const editable =
                isWithinEditableRange(date) && !lockedDates[dateStr];

              return (
                <tr key={dateStr}>
                  <td>{dateStr}</td>
                  <td>{dayNames[date.getDay()]}</td>

                  <td>
                    {["Working", "Holiday", "Leave", "WeeklyOff"].map(
                      (status) => {
                        const isActive = data.status === status;

                        return (
                          <button
                            key={status}
                            type="button"
                            disabled={!editable}
                            onClick={() =>
                              editable && updateAttendance(dateStr, { status })
                            }
                            className={`dgv-status-badge ${STATUS_CLASS[status]} ${
                              isActive ? "is-active" : ""
                            }`}
                            aria-pressed={isActive}
                          >
                            {status}
                          </button>
                        );
                      }
                    )}

                    {data.status === "Working" && (
                      <input
                        type="number"
                        disabled={!editable}
                        value={data.hours || ""}
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
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>

        {/* SUBMIT */}
        <button
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
      </div>
    </Layout>
  );
}

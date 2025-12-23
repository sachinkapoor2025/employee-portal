import { useState, useEffect } from "react";
import Layout from "../components/Layout";

export default function Attendance() {
  const [currentWeekStart, setCurrentWeekStart] = useState(() => getStartOfWeek(new Date(2026, 0, 1)));
  const [attendanceData, setAttendanceData] = useState({});

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function getStartOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
  }

  function formatDate(date) {
    return date.toISOString().split('T')[0];
  }

  function getWeekDates(start) {
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      dates.push(date);
    }
    return dates;
  }

  const fetchAttendance = async (start, end) => {
    const token = localStorage.getItem("token");
    try {
      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/attendance?startDate=${start}&endDate=${end}`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );
      const data = await res.json();
      const dataObj = {};
      data.forEach(item => {
        dataObj[item.date] = { status: item.status, hours: item.hours };
      });
      setAttendanceData(dataObj);
    } catch (error) {
      console.error("Error fetching attendance:", error);
    }
  };

  const submitAttendance = async () => {
    const token = localStorage.getItem("token");
    const attendanceArray = [];
    const dates = getWeekDates(currentWeekStart);
    dates.forEach(date => {
      const dateStr = formatDate(date);
      const data = attendanceData[dateStr];
      if (data && data.status) {
        attendanceArray.push({
          date: dateStr,
          status: data.status,
          hours: data.hours
        });
      }
    });

    try {
      await fetch(`${process.env.REACT_APP_API_URL}/attendance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}` // ✅ FIX
        },
        body: JSON.stringify(attendanceArray)
      });
      alert("Attendance saved");
    } catch (error) {
      console.error("Error saving attendance:", error);
      alert("Error saving attendance");
    }
  };

  const updateAttendance = (dateStr, updates) => {
    setAttendanceData(prev => ({
      ...prev,
      [dateStr]: { ...prev[dateStr], ...updates }
    }));
  };

  const goToPreviousWeek = () => {
    setCurrentWeekStart(prev => {
      const newStart = new Date(prev.getTime() - 7 * 24 * 60 * 60 * 1000);
      if (newStart.getFullYear() < 2026) return prev;
      return newStart;
    });
  };

  const goToNextWeek = () => {
    setCurrentWeekStart(prev => {
      const newStart = new Date(prev.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (newStart.getFullYear() > 2026) return prev;
      return newStart;
    });
  };

  useEffect(() => {
    const dates = getWeekDates(currentWeekStart);
    const startDate = formatDate(dates[0]);
    const endDate = formatDate(dates[6]);
    fetchAttendance(startDate, endDate);
  }, [currentWeekStart]);

  const dates = getWeekDates(currentWeekStart);

  const styles = {
    container: { backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" },
    table: { width: "100%", borderCollapse: "collapse" },
    th: { border: "1px solid #ddd", padding: "8px", textAlign: "left", backgroundColor: "#f2f2f2" },
    td: { border: "1px solid #ddd", padding: "8px" },
    button: { padding: "6px 12px", margin: "2px", border: "none", borderRadius: "4px", cursor: "pointer" },
    workingButton: { backgroundColor: "#4caf50", color: "white" },
    holidayButton: { backgroundColor: "#ff9800", color: "white" },
    leaveButton: { backgroundColor: "#f44336", color: "white" },
    weeklyOffButton: { backgroundColor: "#9e9e9e", color: "white" },
    input: { padding: "4px", width: "60px", marginLeft: "10px" },
    navButton: { padding: "10px 20px", margin: "10px", backgroundColor: "#1976d2", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" },
    submitButton: { padding: "10px 20px", backgroundColor: "#1976d2", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", marginTop: "20px" }
  };

  return (
    <Layout>
      <div style={styles.container}>
        <h2>Attendance</h2>
        <div>
          <button style={styles.navButton} onClick={goToPreviousWeek}>Previous Week</button>
          <button style={styles.navButton} onClick={goToNextWeek}>Next Week</button>
        </div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Day</th>
              <th style={styles.th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {dates.map(date => {
              const dateStr = formatDate(date);
              const data = attendanceData[dateStr] || {};
              const dayName = dayNames[date.getDay()];
              return (
                <tr key={dateStr}>
                  <td style={styles.td}>{dateStr}</td>
                  <td style={styles.td}>{dayName}</td>
                  <td style={styles.td}>
                    <button
                      style={{ ...styles.button, ...(data.status === 'Working' ? styles.workingButton : {}) }}
                      onClick={() => updateAttendance(dateStr, { status: 'Working' })}
                    >
                      Working Day
                    </button>
                    <button
                      style={{ ...styles.button, ...(data.status === 'Holiday' ? styles.holidayButton : {}) }}
                      onClick={() => updateAttendance(dateStr, { status: 'Holiday' })}
                    >
                      Holiday
                    </button>
                    <button
                      style={{ ...styles.button, ...(data.status === 'Leave' ? styles.leaveButton : {}) }}
                      onClick={() => updateAttendance(dateStr, { status: 'Leave' })}
                    >
                      Leave
                    </button>
                    <button
                      style={{ ...styles.button, ...(data.status === 'WeeklyOff' ? styles.weeklyOffButton : {}) }}
                      onClick={() => updateAttendance(dateStr, { status: 'WeeklyOff' })}
                    >
                      Weekly Off
                    </button>
                    {data.status === 'Working' && (
                      <input
                        type="number"
                        placeholder="Hours"
                        value={data.hours || ''}
                        onChange={(e) => updateAttendance(dateStr, { hours: parseFloat(e.target.value) })}
                        style={styles.input}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button style={styles.submitButton} onClick={submitAttendance}>Submit Attendance</button>
      </div>
    </Layout>
  );
}

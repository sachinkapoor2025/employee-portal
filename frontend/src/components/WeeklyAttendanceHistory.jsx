import Button from "./ui/Button";
import { colors } from "../theme";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDisplayDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

/** e.g. 09:15 AM */
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

/** e.g. 8h 55m */
function formatWorkingHours(record) {
  if (!record) return "—";

  let totalMinutes = null;

  if (record.workingSeconds != null && Number.isFinite(Number(record.workingSeconds))) {
    totalMinutes = Math.floor(Number(record.workingSeconds) / 60);
  } else if (record.workingTime && typeof record.workingTime === "string") {
    const match = record.workingTime.match(/(\d+)\s*h.*?(\d+)\s*m/i);
    if (match) {
      totalMinutes = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    }
  } else if (
    record.hours != null &&
    record.hours !== "" &&
    !Number.isNaN(Number(record.hours))
  ) {
    totalMinutes = Math.round(Number(record.hours) * 60);
  }

  if (totalMinutes == null || totalMinutes < 0) return "—";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Map stored attendance → display status for the weekly tracker.
 */
export function getWeeklyDisplayStatus(record) {
  if (!record) return "Not Marked";
  if (record.status === "Leave") return "Leave";
  if (record.status === "PlannedOff") return "Planned Off";
  if (record.status === "Holiday") return "Absent";
  if (record.status === "WeeklyOff") return "Weekly Off";
  if (
    record.status === "Working" ||
    record.sessionStatus === "Active" ||
    record.sessionStatus === "Checked Out" ||
    record.sessionStatus === "Present" ||
    record.checkInTime
  ) {
    return "Present";
  }
  return "Not Marked";
}

const STATUS_CLASS = {
  Present: "dgv-badge dgv-badge--success",
  Leave: "dgv-badge dgv-badge--danger",
  "Planned Off": "dgv-badge dgv-badge--info",
  Absent: "dgv-badge dgv-badge--neutral",
  "Not Marked": "dgv-badge dgv-badge--info",
  "Weekly Off": "dgv-badge dgv-badge--neutral",
  "Attendance Not Marked": "dgv-badge dgv-badge--info",
};

function buildWeekRows(weekStart, attendanceData) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + i);
    const dateKey = formatDateKey(date);
    const record = attendanceData?.[dateKey] || null;
    const displayStatus = getWeeklyDisplayStatus(record);
    return {
      date,
      dateKey,
      dayName: DAY_NAMES[date.getDay()],
      record,
      displayStatus,
      isToday: formatDateKey(startOfDay(new Date())) === dateKey,
    };
  });
}

function summarize(rows) {
  const summary = {
    totalWorkingDays: rows.length,
    present: 0,
    absent: 0,
    leave: 0,
    plannedOff: 0,
    notMarked: 0,
    totalHours: 0,
  };

  rows.forEach((row) => {
    if (row.displayStatus === "Present") summary.present += 1;
    else if (row.displayStatus === "Leave") summary.leave += 1;
    else if (row.displayStatus === "Planned Off") summary.plannedOff += 1;
    else if (row.displayStatus === "Absent") summary.absent += 1;
    else if (row.displayStatus === "Weekly Off") {
      /* counted in total days only */
    } else summary.notMarked += 1;

    const hrs = Number(row.record?.hours);
    if (Number.isFinite(hrs) && hrs > 0) summary.totalHours += hrs;
    else if (row.record?.workingSeconds) {
      summary.totalHours += Number(row.record.workingSeconds) / 3600;
    }
  });

  summary.totalHours = Math.round(summary.totalHours * 100) / 100;
  return summary;
}

function formatWeekRange(weekStart) {
  const end = new Date(weekStart);
  end.setDate(weekStart.getDate() + 6);
  const opts = { day: "2-digit", month: "short", year: "numeric" };
  return `${weekStart.toLocaleDateString("en-GB", opts)} – ${end.toLocaleDateString("en-GB", opts)}`;
}

function formatTotalHours(hours) {
  if (!hours || hours <= 0) return "—";
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function TodayBanner({ rows }) {
  const today = rows.find((r) => r.isToday);
  if (!today) return null;

  if (today.displayStatus === "Not Marked") {
    return (
      <div className="dgv-weekly-attendance__today-banner" role="status">
        <strong>Today</strong>
        <span className={STATUS_CLASS["Attendance Not Marked"]}>
          Attendance Not Marked
        </span>
      </div>
    );
  }

  const checkIn = formatTime(today.record?.checkInTime);
  return (
    <div className="dgv-weekly-attendance__today-banner is-marked" role="status">
      <strong>Today</strong>
      <span className={STATUS_CLASS[today.displayStatus] || STATUS_CLASS.Present}>
        {today.displayStatus}
      </span>
      {checkIn !== "—" ? <span>Check-in: {checkIn}</span> : null}
      {today.record?.checkOutTime ? (
        <span>Check-out: {formatTime(today.record.checkOutTime)}</span>
      ) : null}
    </div>
  );
}

/**
 * Read-only weekly attendance history for the logged-in employee.
 * Uses the same attendance records as the marking UI (no duplicate system).
 */
export default function WeeklyAttendanceHistory({
  weekStart,
  attendanceData,
  loading,
  error,
  onPreviousWeek,
  onCurrentWeek,
  onNextWeek,
}) {
  const rows = buildWeekRows(weekStart, attendanceData);
  const summary = summarize(rows);

  return (
    <section
      className="dgv-weekly-attendance"
      aria-labelledby="my-attendance-title"
    >
      <div className="dgv-weekly-attendance__header">
        <div>
          <h3 id="my-attendance-title" className="dgv-weekly-attendance__title">
            My Attendance
          </h3>
          <p className="dgv-weekly-attendance__range">{formatWeekRange(weekStart)}</p>
        </div>
        <div className="dgv-weekly-attendance__nav" aria-label="Week navigation">
          <Button type="button" variant="outline" onClick={onPreviousWeek}>
            ← Previous Week
          </Button>
          <Button type="button" variant="secondary" onClick={onCurrentWeek}>
            Current Week
          </Button>
          <Button type="button" variant="outline" onClick={onNextWeek}>
            Next Week →
          </Button>
        </div>
      </div>

      <TodayBanner rows={rows} />

      <div
        className="dgv-weekly-attendance__summary"
        role="group"
        aria-label="Weekly summary"
      >
        <div className="dgv-weekly-attendance__chip">
          <span>Total Working Days</span>
          <strong>{summary.totalWorkingDays}</strong>
        </div>
        <div className="dgv-weekly-attendance__chip is-present">
          <span>Present</span>
          <strong>{summary.present}</strong>
        </div>
        <div className="dgv-weekly-attendance__chip is-absent">
          <span>Absent</span>
          <strong>{summary.absent}</strong>
        </div>
        <div className="dgv-weekly-attendance__chip is-leave">
          <span>Leave</span>
          <strong>{summary.leave}</strong>
        </div>
        <div className="dgv-weekly-attendance__chip is-present">
          <span>Planned Off</span>
          <strong>{summary.plannedOff}</strong>
        </div>
        <div className="dgv-weekly-attendance__chip is-empty">
          <span>Not Marked</span>
          <strong>{summary.notMarked}</strong>
        </div>
        <div className="dgv-weekly-attendance__chip">
          <span>Total Working Hours</span>
          <strong>{formatTotalHours(summary.totalHours)}</strong>
        </div>
      </div>

      {loading ? (
        <p style={{ color: colors.textMuted }}>Loading weekly attendance…</p>
      ) : error ? (
        <div className="dgv-alert dgv-alert--error" role="alert">
          {error}
        </div>
      ) : (
        <div className="dgv-table-wrap">
          <table className="dgv-table dgv-weekly-attendance__table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Date</th>
                <th>Check-in</th>
                <th>Check-out</th>
                <th>Working Hours</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const empty = row.displayStatus === "Not Marked";
                return (
                  <tr
                    key={row.dateKey}
                    className={
                      row.isToday ? "dgv-weekly-attendance__today" : undefined
                    }
                  >
                    <td>
                      <strong>{row.dayName}</strong>
                      {row.isToday ? (
                        <span className="dgv-weekly-attendance__today-tag">
                          Today
                        </span>
                      ) : null}
                    </td>
                    <td>{formatDisplayDate(row.date)}</td>
                    <td>{empty ? "—" : formatTime(row.record?.checkInTime)}</td>
                    <td>{empty ? "—" : formatTime(row.record?.checkOutTime)}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>
                      {empty ? "—" : formatWorkingHours(row.record)}
                    </td>
                    <td>
                      {empty ? (
                        <span className={STATUS_CLASS["Attendance Not Marked"]}>
                          Attendance Not Marked
                        </span>
                      ) : (
                        <span
                          className={
                            STATUS_CLASS[row.displayStatus] ||
                            STATUS_CLASS["Not Marked"]
                          }
                        >
                          {row.displayStatus}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

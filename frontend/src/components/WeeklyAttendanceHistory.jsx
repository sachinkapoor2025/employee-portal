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

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysToKey(key, days) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function formatDisplayDate(dateKey) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** e.g. 09:15 AM — company timezone */
function formatTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(t));
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

function buildWeekRows(weekStart, attendanceData, todayKey) {
  const mondayKey =
    typeof weekStart === "string" ? weekStart : formatDateKey(weekStart);
  const today =
    todayKey ||
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return Array.from({ length: 7 }, (_, i) => {
    const dateKey = addDaysToKey(mondayKey, i);
    const [y, m, d] = dateKey.split("-").map(Number);
    const record = attendanceData?.[dateKey] || null;
    const displayStatus =
      dateKey === today && !record?.submittedAt
        ? "Not Marked"
        : getWeeklyDisplayStatus(record);
    return {
      dateKey,
      dayName: DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
      record,
      displayStatus,
      isToday: dateKey === today,
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
  };

  rows.forEach((row) => {
    if (row.displayStatus === "Present") summary.present += 1;
    else if (row.displayStatus === "Leave") summary.leave += 1;
    else if (row.displayStatus === "Planned Off") summary.plannedOff += 1;
    else if (row.displayStatus === "Absent") summary.absent += 1;
    else if (row.displayStatus === "Weekly Off") {
      /* counted in total days only */
    } else summary.notMarked += 1;
  });

  return summary;
}

function formatWeekRange(weekStart) {
  const mondayKey =
    typeof weekStart === "string" ? weekStart : formatDateKey(weekStart);
  const endKey = addDaysToKey(mondayKey, 6);
  const opts = { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" };
  const start = new Date(`${mondayKey}T12:00:00Z`);
  const end = new Date(`${endKey}T12:00:00Z`);
  return `${start.toLocaleDateString("en-GB", opts)} – ${end.toLocaleDateString("en-GB", opts)}`;
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
  todayKey,
  onPreviousWeek,
  onCurrentWeek,
  onNextWeek,
}) {
  const rows = buildWeekRows(weekStart, attendanceData, todayKey);
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
                    <td>{formatDisplayDate(row.dateKey)}</td>
                    <td>{empty ? "—" : formatTime(row.record?.checkInTime)}</td>
                    <td>{empty ? "—" : formatTime(row.record?.checkOutTime)}</td>
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

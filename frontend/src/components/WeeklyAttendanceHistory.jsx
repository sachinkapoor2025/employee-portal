import Button from "./ui/Button";
import { colors } from "../theme";
import {
  COMPLIANCE,
  attendanceCompliance,
  formatInstant,
  lateByLabel,
} from "../utils/attendanceCompliance";

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
export function formatTime(iso) {
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

const OFF_STATUSES = new Set(["Leave", "Holiday", "WeeklyOff", "PlannedOff"]);

/**
 * Punch columns use actualCheckInTime/actualCheckOutTime only.
 * Compatibility checkInTime/checkOutTime are expected-window / historical.
 */
export function attendancePunchDisplay(record) {
  if (!record || OFF_STATUSES.has(record.status)) {
    return {
      inLabel: "—",
      outLabel: "—",
      windowLabel: null,
      beyond: false,
      beyondReason: null,
      historical: false,
    };
  }

  const expectedStart = record.expectedStartTime || null;
  const expectedEnd = record.expectedEndTime || null;
  const windowStart = expectedStart || (!record.actualCheckInTime ? record.checkInTime : null);
  const windowEnd = expectedEnd || (!record.actualCheckOutTime ? record.checkOutTime : null);
  const windowLabel =
    windowStart || windowEnd
      ? `${formatTime(windowStart)} — ${formatTime(windowEnd)}`
      : null;

  if (record.actualCheckInTime || record.actualCheckOutTime) {
    return {
      inLabel: record.actualCheckInTime ? formatTime(record.actualCheckInTime) : "—",
      outLabel: record.actualCheckOutTime
        ? formatTime(record.actualCheckOutTime)
        : record.actualCheckInTime
          ? "Not checked out"
          : "—",
      windowLabel,
      beyond: !!record.workedBeyondShift,
      beyondReason: record.workedBeyondReason || null,
      historical: false,
    };
  }

  return {
    inLabel: "—",
    outLabel: "—",
    windowLabel,
    beyond: false,
    beyondReason: null,
    historical: Boolean(windowLabel),
  };
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
    record.actualCheckInTime ||
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
  [COMPLIANCE.ON_TIME]: "dgv-badge dgv-badge--success",
  [COMPLIANCE.LATE]: "dgv-badge dgv-badge--danger",
  [COMPLIANCE.NOT_MARKED]: "dgv-badge dgv-badge--info",
  [COMPLIANCE.LEAVE]: "dgv-badge dgv-badge--danger",
  [COMPLIANCE.WEEK_OFF]: "dgv-badge dgv-badge--info",
  [COMPLIANCE.HOLIDAY]: "dgv-badge dgv-badge--neutral",
  [COMPLIANCE.UPCOMING]: "dgv-badge dgv-badge--neutral",
};

function buildWeekRows(weekStart, attendanceData, todayKey, assignedShift) {
  const mondayKey =
    typeof weekStart === "string" ? weekStart : formatDateKey(weekStart);
  const today =
    todayKey ||
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return Array.from({ length: 7 }, (_, i) => {
    const dateKey = addDaysToKey(mondayKey, i);
    const [y, m, d] = dateKey.split("-").map(Number);
    const record = attendanceData?.[dateKey] || null;
    const compliance = attendanceCompliance({
      dateKey,
      todayKey: today,
      record,
      shift: assignedShift,
    });
    const displayStatus = compliance.status;
    return {
      dateKey,
      dayName: DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
      record,
      displayStatus,
      compliance,
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
    if (row.displayStatus === "Present" || row.displayStatus === COMPLIANCE.ON_TIME || row.displayStatus === COMPLIANCE.LATE) {
      summary.present += 1;
    } else if (row.displayStatus === "Leave" || row.displayStatus === COMPLIANCE.LEAVE) {
      summary.leave += 1;
    } else if (row.displayStatus === "Planned Off" || row.displayStatus === COMPLIANCE.WEEK_OFF) {
      summary.plannedOff += 1;
    } else if (row.displayStatus === "Absent") summary.absent += 1;
    else if (row.displayStatus === "Weekly Off" || row.displayStatus === COMPLIANCE.HOLIDAY) {
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
  const compliance = today.compliance;
  const status = today.displayStatus;

  if (status === "Not Marked" || status === COMPLIANCE.NOT_MARKED) {
    return (
      <div className="dgv-weekly-attendance__today-banner" role="status">
        <strong>Today</strong>
        <span className={STATUS_CLASS[COMPLIANCE.NOT_MARKED]}>
          {COMPLIANCE.NOT_MARKED}
        </span>
        {compliance?.expectedByMs ? (
          <span>Expected by: {formatInstant(compliance.expectedByMs)}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="dgv-weekly-attendance__today-banner is-marked" role="status">
      <strong>Today</strong>
      <span className={STATUS_CLASS[status] || STATUS_CLASS.Present}>
        {status}
      </span>
      {compliance?.markedAtMs ? (
        <span>Marked: {formatInstant(compliance.markedAtMs)}</span>
      ) : null}
      {compliance?.expectedByMs ? (
        <span>Expected by: {formatInstant(compliance.expectedByMs)}</span>
      ) : null}
      {status === COMPLIANCE.LATE && compliance?.lateMinutes != null ? (
        <span>Late by: {lateByLabel(compliance.lateMinutes)}</span>
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
  assignedShift,
  onPreviousWeek,
  onCurrentWeek,
  onNextWeek,
}) {
  const rows = buildWeekRows(weekStart, attendanceData, todayKey, assignedShift);
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
                <th>Status</th>
                <th>Marked At</th>
                <th>Expected By</th>
                <th>Late By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const compliance = row.compliance;
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
                    <td>
                      <span
                        className={
                          STATUS_CLASS[row.displayStatus] ||
                          STATUS_CLASS[COMPLIANCE.NOT_MARKED]
                        }
                      >
                        {row.displayStatus === "Not Marked"
                          ? COMPLIANCE.NOT_MARKED
                          : row.displayStatus}
                      </span>
                    </td>
                    <td>
                      {compliance?.markedAtMs
                        ? formatInstant(compliance.markedAtMs)
                        : "—"}
                    </td>
                    <td>
                      {compliance?.expectedByMs
                        ? formatInstant(compliance.expectedByMs)
                        : "—"}
                    </td>
                    <td>
                      {row.displayStatus === COMPLIANCE.LATE
                        ? lateByLabel(compliance?.lateMinutes) || "—"
                        : "—"}
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

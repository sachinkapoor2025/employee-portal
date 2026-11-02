import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ClockAlert,
  Coffee,
  GraduationCap,
} from "lucide-react";
import Layout from "../components/Layout";
import { attendancePunchDisplay } from "../components/WeeklyAttendanceHistory";
import {
  fetchAttendance,
  fetchEmployeeShift,
  fetchTasks,
  fetchUserProfile,
  fetchWeekOffState,
} from "../services/api";
import { getLoggedInDisplayName, getLoggedInEmail } from "../services/auth";
import {
  attendanceCompliance,
  companyTodayKey,
  COMPLIANCE,
  formatInstant,
} from "../utils/attendanceCompliance";
import {
  assignmentInPeriod,
  assignmentPeriodRange,
  createRequestGate,
} from "../utils/employeeTaskVisibility";
import {
  currentWeekStartKey,
  weekEndKey,
} from "../utils/myActivityReport";

function formatCompanyDate(key, withWeekday) {
  const [year, month, day] = String(key || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: withWeekday ? "short" : undefined,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatWorkweek(now) {
  const start = currentWeekStartKey(now);
  const end = weekEndKey(start);
  const startLabel = formatCompanyDate(start, true).replace(/ \d{4}$/, "");
  const endLabel = formatCompanyDate(end, true);
  return `${startLabel} – ${endLabel}`;
}

function assignedCount(tasks, start, end) {
  const range = assignmentPeriodRange("CUSTOM", { start, end });
  return (tasks || []).filter((task) => assignmentInPeriod(task, range)).length;
}

function attendanceCopy(compliance) {
  if (!compliance) return "Not recorded yet";
  if (compliance.status === COMPLIANCE.ON_TIME) return "On Time";
  if (compliance.status === COMPLIANCE.LATE) return "Late";
  if (compliance.status === COMPLIANCE.WEEK_OFF) return "Weekly day off";
  if (compliance.status === COMPLIANCE.LEAVE) return "On leave";
  if (compliance.status === COMPLIANCE.HOLIDAY) return "Holiday";
  return "Not recorded yet";
}

function attendanceTone(compliance) {
  if (compliance?.status === COMPLIANCE.LATE) return "late";
  if (compliance?.status === COMPLIANCE.ON_TIME) return "ontime";
  return "neutral";
}

function AttendanceStatusIcon({ status }) {
  if (status === COMPLIANCE.ON_TIME) return <CheckCircle2 size={20} aria-hidden="true" />;
  if (status === COMPLIANCE.LATE) return <ClockAlert size={20} aria-hidden="true" />;
  return <Clock3 size={20} aria-hidden="true" />;
}

export function localTimeGreeting(date) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

function msUntilNextGreeting(date) {
  const next = new Date(date.getTime());
  const hour = next.getHours();
  if (hour < 5) next.setHours(5, 0, 0, 0);
  else if (hour < 12) next.setHours(12, 0, 0, 0);
  else if (hour < 17) next.setHours(17, 0, 0, 0);
  else {
    next.setDate(next.getDate() + 1);
    next.setHours(5, 0, 0, 0);
  }
  const delay = next.getTime() - date.getTime();
  return delay > 0 ? delay : 1000;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  const [tasksReady, setTasksReady] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [weekOffState, setWeekOffState] = useState(null);
  const [weekOffReady, setWeekOffReady] = useState(false);
  const [attendance, setAttendance] = useState(null);
  const [attendanceReady, setAttendanceReady] = useState(false);
  const [attendanceError, setAttendanceError] = useState("");
  const [profileName, setProfileName] = useState("");
  const [greetingNow, setGreetingNow] = useState(() => Date.now());
  const taskRequests = useRef(createRequestGate());
  const employeeName = getLoggedInDisplayName() || profileName;
  const now = Date.now();
  const todayKey = companyTodayKey(now);
  const weekStart = currentWeekStartKey(now);
  const weekEnd = weekEndKey(weekStart);

  useEffect(() => {
    let active = true;
    const loadTasks = () => {
      const requestId = taskRequests.current.next();
      fetchTasks({ mine: "true" })
        .then((rows) => {
          if (!active || !taskRequests.current.isLatest(requestId)) return;
          setTasks(Array.isArray(rows) ? rows : []);
          setTaskError("");
          setTasksReady(true);
        })
        .catch(() => {
          if (!active || !taskRequests.current.isLatest(requestId)) return;
          setTaskError("Unable to load tasks. Please try again.");
          setTasksReady(true);
        });
    };
    const loadRest = () => {
      fetchWeekOffState()
        .then((weekOff) => {
          if (!active) return;
          setWeekOffState(
            weekOff && typeof weekOff === "object" && !Array.isArray(weekOff)
              ? weekOff
              : null
          );
          setWeekOffReady(true);
        })
        .catch(() => {
          if (!active) return;
          setWeekOffState(null);
          setWeekOffReady(true);
        });

      const email = getLoggedInEmail();
      Promise.allSettled([
        fetchAttendance(todayKey, todayKey),
        email ? fetchEmployeeShift(email) : Promise.resolve(null),
      ]).then(([attendanceResult, shiftResult]) => {
        if (!active) return;
        if (attendanceResult.status === "rejected") {
          setAttendance(null);
          setAttendanceError("Unable to load attendance.");
          setAttendanceReady(true);
          return;
        }
        const rows = Array.isArray(attendanceResult.value)
          ? attendanceResult.value
          : [];
        const record = rows.find((row) => row?.date === todayKey) || null;
        const shift =
          shiftResult.status === "fulfilled" ? shiftResult.value?.shift || null : null;
        setAttendance({ record, shift });
        setAttendanceError("");
        setAttendanceReady(true);
      });
    };
    if (!getLoggedInDisplayName()) {
      const email = getLoggedInEmail();
      if (email) {
        fetchUserProfile(email)
          .then((data) => {
            if (!active) return;
            const name = String(data?.name || "").trim();
            if (name && !name.includes("@")) setProfileName(name);
          })
          .catch(() => {});
      }
    }
    loadTasks();
    loadRest();
    const timer = setInterval(() => {
      loadTasks();
      loadRest();
    }, 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [todayKey]);

  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setGreetingNow(Date.now());
        schedule();
      }, msUntilNextGreeting(new Date(Date.now())));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  const weekCount = tasksReady && !taskError ? assignedCount(tasks, weekStart, weekEnd) : null;
  const todayCount = tasksReady && !taskError ? assignedCount(tasks, todayKey, todayKey) : null;
  const entitlement = Number(weekOffState?.weekOffEntitlement) === 0 ? 0 : 1;
  const weekOffUsed = Number(weekOffState?.weekOffUsed) === 1;
  const weekOffRemaining = !weekOffReady || !weekOffState ? null : weekOffUsed ? 0 : entitlement;
  const weekOffStatus = !weekOffReady
    ? "—"
    : !weekOffState
      ? "Unavailable"
      : weekOffUsed
        ? "Used"
        : entitlement === 0
          ? "Not available"
          : "Not taken yet";
  const compliance = attendance
    ? attendanceCompliance({
        dateKey: todayKey,
        todayKey,
        record: attendance.record,
        shift: attendance.shift,
        nowMs: now,
      })
    : null;
  const punch = attendance?.record ? attendancePunchDisplay(attendance.record) : null;
  const checkInLabel =
    punch && punch.inLabel && punch.inLabel !== "—" ? punch.inLabel : "";
  const shiftLabel = compliance?.shiftLabel || "";

  return (
    <Layout>
      <div className="dgv-home">
        <header className="dgv-home__header">
          <div>
            <h1>
              {employeeName
                ? `${localTimeGreeting(new Date(greetingNow))}, ${employeeName}`
                : localTimeGreeting(new Date(greetingNow))}
            </h1>
            <p>Here’s your work overview for today and this week.</p>
          </div>
          <div className="dgv-home__dates">
            <span>{formatWorkweek(now)}</span>
            <strong>Today, {formatCompanyDate(todayKey, true)}</strong>
          </div>
        </header>

        {taskError ? (
          <p className="dgv-home__alert" role="alert">
            {taskError}
          </p>
        ) : null}

        <div className="dgv-home__stats">
          <button type="button" onClick={() => navigate("/work")}>
            <span className="dgv-home__icon" aria-hidden="true">
              <GraduationCap size={18} />
            </span>
            <span>
              <small>Tasks This Week</small>
              <strong>{weekCount == null ? "—" : weekCount}</strong>
              <em>Assigned in this week</em>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => navigate("/work")}>
            <span className="dgv-home__icon" aria-hidden="true">
              <CalendarDays size={18} />
            </span>
            <span>
              <small>Assigned Today</small>
              <strong>{todayCount == null ? "—" : todayCount}</strong>
              <em>New tasks assigned today</em>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => navigate("/attendance")}>
            <span className="dgv-home__icon" aria-hidden="true">
              <Coffee size={18} />
            </span>
            <span>
              <small>Weekly Day Off</small>
              <strong>
                {weekOffRemaining == null ? (
                  "—"
                ) : (
                  <>
                    {weekOffRemaining} <span>remaining</span>
                  </>
                )}
              </strong>
              <em>You can take 1 day off this week</em>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="dgv-home__panels">
          <section
            className="dgv-home__panel dgv-home__panel--attendance"
            aria-labelledby="attendance-today-heading"
          >
            <header>
              <h2 id="attendance-today-heading">
                <span className="dgv-home__panel-icon" aria-hidden="true">
                  <Clock3 size={16} />
                </span>
                Attendance Today
              </h2>
              {shiftLabel ? <p>Shift: {shiftLabel}</p> : null}
            </header>
            {attendanceError ? (
              <p role="alert">{attendanceError}</p>
            ) : !attendanceReady ? (
              <p role="status">Loading attendance...</p>
            ) : (
              <div
                className={`dgv-home__attendance is-${attendanceTone(compliance)}`}
                role="group"
                aria-label="Today's attendance"
              >
                <div className="dgv-home__status">
                  <span className="dgv-home__status-icon" aria-hidden="true">
                    <AttendanceStatusIcon status={compliance?.status} />
                  </span>
                  <strong>{attendanceCopy(compliance)}</strong>
                </div>
                {checkInLabel || compliance?.markedAtMs ? (
                  <span className="dgv-home__attendance-rule" aria-hidden="true" />
                ) : null}
                {checkInLabel ? (
                  <p className="dgv-home__checkin">
                    <span>Checked in at</span>
                    <b>{checkInLabel}</b>
                  </p>
                ) : compliance?.markedAtMs ? (
                  <p className="dgv-home__checkin">
                    <span>Marked at</span>
                    <b>{formatInstant(compliance.markedAtMs)}</b>
                  </p>
                ) : null}
              </div>
            )}
          </section>
          <section className="dgv-home__panel" aria-labelledby="week-overview-heading">
            <header>
              <h2 id="week-overview-heading">
                <CalendarDays size={18} aria-hidden="true" />
                This Week Overview
              </h2>
            </header>
            <dl>
              <div>
                <dt>Work Week</dt>
                <dd>{formatWorkweek(now)}</dd>
              </div>
              <div>
                <dt>Weekly Day Off Status</dt>
                <dd>{weekOffStatus}</dd>
              </div>
              <div>
                <dt>Note</dt>
                <dd>1 day off per week (Monday – Sunday)</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </Layout>
  );
}

import { useCallback, useEffect, useState } from "react";
import {
  attendanceCheckIn,
  attendanceCheckOut,
  fetchAttendance,
} from "../services/api";

const COMPANY_TZ = "Asia/Kolkata";

function companyTodayKey(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: COMPANY_TZ });
}

function parseTs(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Format as 00h 00m 00s */
function formatDuration(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

function formatTimeOfDay(iso) {
  const t = parseTs(iso);
  if (t == null) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(t));
}

function computeElapsedSeconds(checkInTime, checkOutTime, nowMs) {
  const start = parseTs(checkInTime);
  if (start == null) return 0;
  const end = parseTs(checkOutTime) ?? nowMs;
  return Math.max(0, Math.floor((end - start) / 1000));
}

const EMPTY_SESSION = {
  actualCheckInTime: null,
  actualCheckOutTime: null,
  expectedEndTime: null,
  status: null,
  submittedAt: null,
};

/**
 * Working Time from actual punch fields.
 * Persistence uses server timestamps; client clocks are display-only.
 */
export function useWorkingTime() {
  const [actualCheckInTime, setActualCheckInTime] = useState(null);
  const [actualCheckOutTime, setActualCheckOutTime] = useState(null);
  const [expectedEndTime, setExpectedEndTime] = useState(null);
  const [status, setStatus] = useState(null);
  const [submittedAt, setSubmittedAt] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const applySession = useCallback((session = EMPTY_SESSION) => {
    setActualCheckInTime(session.actualCheckInTime || null);
    setActualCheckOutTime(session.actualCheckOutTime || null);
    setExpectedEndTime(session.expectedEndTime || null);
    setStatus(session.status || null);
    setSubmittedAt(session.submittedAt || null);
  }, []);

  const refresh = useCallback(async () => {
    const date = companyTodayKey();
    try {
      const list = await fetchAttendance(date, date);
      const today = Array.isArray(list)
        ? list.find((r) => r.date === date) || null
        : null;

      applySession({
        actualCheckInTime: today?.actualCheckInTime || null,
        actualCheckOutTime: today?.actualCheckOutTime || null,
        expectedEndTime: today?.expectedEndTime || null,
        status: today?.status || null,
        submittedAt: today?.submittedAt || null,
      });
    } catch (err) {
      console.warn("Working time attendance fetch failed:", err);
      applySession(EMPTY_SESSION);
    } finally {
      setLoading(false);
    }
  }, [applySession]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const isWorking = status === "Working" && !!submittedAt;
  const isCheckedIn = !!actualCheckInTime;
  const isCheckedOut = !!actualCheckOutTime;
  const isActive = isCheckedIn && !isCheckedOut;

  const statusLabel = !isWorking
    ? { key: "idle", label: "Not Checked In" }
    : !isCheckedIn
      ? { key: "idle", label: "Not Checked In" }
      : isCheckedOut
        ? { key: "out", label: "Checked Out" }
        : { key: "active", label: "Active" };

  const elapsedSeconds = computeElapsedSeconds(
    actualCheckInTime,
    actualCheckOutTime,
    nowMs
  );

  const pastExpectedEnd =
    !!expectedEndTime && Number.isFinite(parseTs(expectedEndTime))
      ? nowMs > parseTs(expectedEndTime)
      : false;

  const canCheckIn = isWorking && !isCheckedIn;
  const canCheckOut = isWorking && isActive;

  const checkIn = useCallback(async () => {
    if (busy || !canCheckIn) return;
    setBusy(true);
    const date = companyTodayKey();
    try {
      const res = await attendanceCheckIn({ date });
      const saved = res?.attendance;
      applySession({
        actualCheckInTime: saved?.actualCheckInTime || null,
        actualCheckOutTime: saved?.actualCheckOutTime || null,
        expectedEndTime: saved?.expectedEndTime || expectedEndTime,
        status: saved?.status || "Working",
        submittedAt: saved?.submittedAt || submittedAt,
      });
      setNowMs(Date.now());
    } catch (err) {
      console.warn("Check-in failed:", err);
    } finally {
      setBusy(false);
    }
  }, [applySession, busy, canCheckIn, expectedEndTime, submittedAt]);

  const checkOut = useCallback(
    async ({ workedBeyondReason } = {}) => {
      if (busy || !canCheckOut) return;
      setBusy(true);
      const date = companyTodayKey();
      try {
        const res = await attendanceCheckOut({
          date,
          workedBeyondReason,
        });
        const saved = res?.attendance;
        applySession({
          actualCheckInTime: saved?.actualCheckInTime || actualCheckInTime,
          actualCheckOutTime: saved?.actualCheckOutTime || null,
          expectedEndTime: saved?.expectedEndTime || expectedEndTime,
          status: saved?.status || "Working",
          submittedAt: saved?.submittedAt || submittedAt,
        });
        setNowMs(Date.now());
      } catch (err) {
        console.warn("Check-out failed:", err);
      } finally {
        setBusy(false);
      }
    },
    [
      actualCheckInTime,
      applySession,
      busy,
      canCheckOut,
      expectedEndTime,
      submittedAt,
    ]
  );

  return {
    loading,
    busy,
    status: statusLabel,
    isActive,
    isLive: isActive,
    canCheckIn,
    canCheckOut,
    pastExpectedEnd,
    checkInTime: actualCheckInTime,
    checkOutTime: actualCheckOutTime,
    actualCheckInTime,
    actualCheckOutTime,
    expectedEndTime,
    elapsedSeconds,
    formattedElapsed: formatDuration(elapsedSeconds),
    formattedCheckIn: formatTimeOfDay(actualCheckInTime),
    formattedCheckOut: formatTimeOfDay(actualCheckOutTime),
    checkIn,
    checkOut,
    refresh,
  };
}

import { useCallback, useEffect, useState } from "react";
import {
  attendanceCheckIn,
  attendanceCheckOut,
  fetchAttendance,
} from "../services/api";

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
  checkInTime: null,
  checkOutTime: null,
};

/**
 * Working Time from attendance records.
 * Live clock uses browser `new Date()`; persistence uses backend timestamps.
 * API failures fall back to a clean default UI (no user-facing error text).
 */
export function useWorkingTime() {
  const [checkInTime, setCheckInTime] = useState(null);
  const [checkOutTime, setCheckOutTime] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const applySession = useCallback((session = EMPTY_SESSION) => {
    setCheckInTime(session.checkInTime || null);
    setCheckOutTime(session.checkOutTime || null);
  }, []);

  const refresh = useCallback(async () => {
    const date = localDateKey();
    try {
      const list = await fetchAttendance(date, date);
      const today = Array.isArray(list)
        ? list.find((r) => r.date === date) || null
        : null;

      applySession({
        checkInTime: today?.checkInTime || null,
        checkOutTime: today?.checkOutTime || null,
      });
    } catch (err) {
      // Technical detail for developers only — never surface to the UI
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

  const isCheckedIn = !!checkInTime;
  const isCheckedOut = !!checkOutTime;
  const isActive = isCheckedIn && !isCheckedOut;

  const status = !isCheckedIn
    ? { key: "idle", label: "Not Checked In" }
    : isCheckedOut
      ? { key: "out", label: "Checked Out" }
      : { key: "active", label: "Active" };

  const elapsedSeconds = computeElapsedSeconds(
    checkInTime,
    checkOutTime,
    nowMs
  );

  const canCheckIn = !isCheckedIn;
  const canCheckOut = isActive;

  const checkIn = useCallback(async () => {
    if (busy || !canCheckIn) return;
    setBusy(true);
    const date = localDateKey();
    const checkInTimeIso = new Date().toISOString();
    try {
      const res = await attendanceCheckIn({
        date,
        checkInTime: checkInTimeIso,
      });
      const saved = res?.attendance;
      applySession({
        checkInTime: saved?.checkInTime || checkInTimeIso,
        checkOutTime: saved?.checkOutTime || null,
      });
      setNowMs(Date.now());
    } catch (err) {
      console.warn("Check-in failed:", err);
      // Optimistic local session so the widget stays usable if API is down
      applySession({
        checkInTime: checkInTimeIso,
        checkOutTime: null,
      });
      setNowMs(Date.now());
    } finally {
      setBusy(false);
    }
  }, [applySession, busy, canCheckIn]);

  const checkOut = useCallback(async () => {
    if (busy || !canCheckOut) return;
    setBusy(true);
    const date = localDateKey();
    const checkOutTimeIso = new Date().toISOString();
    try {
      const res = await attendanceCheckOut({
        date,
        checkOutTime: checkOutTimeIso,
      });
      const saved = res?.attendance;
      applySession({
        checkInTime: saved?.checkInTime || checkInTime,
        checkOutTime: saved?.checkOutTime || checkOutTimeIso,
      });
      setNowMs(Date.now());
    } catch (err) {
      console.warn("Check-out failed:", err);
      applySession({
        checkInTime,
        checkOutTime: checkOutTimeIso,
      });
      setNowMs(Date.now());
    } finally {
      setBusy(false);
    }
  }, [applySession, busy, canCheckOut, checkInTime]);

  return {
    loading,
    busy,
    status,
    isActive,
    isLive: isActive,
    canCheckIn,
    canCheckOut,
    checkInTime,
    checkOutTime,
    elapsedSeconds,
    formattedElapsed: formatDuration(elapsedSeconds),
    formattedCheckIn: formatTimeOfDay(checkInTime),
    formattedCheckOut: formatTimeOfDay(checkOutTime),
    checkIn,
    checkOut,
    refresh,
  };
}

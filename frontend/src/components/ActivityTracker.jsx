import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import {
  startActivityTracking,
  stopActivityTracking,
  trackHeartbeat,
} from "../services/activityTracker";

export default function ActivityTracker() {
  const location = useLocation();

  useEffect(() => {
    if (localStorage.getItem("token")) {
      startActivityTracking();
    }
    return () => stopActivityTracking();
  }, []);

  useEffect(() => {
    if (!localStorage.getItem("token")) return;
    // Always catch — network failures must never crash the UI overlay
    Promise.resolve()
      .then(() => trackHeartbeat(location.pathname))
      .catch((err) => console.warn("Heartbeat skipped:", err));
  }, [location.pathname]);

  return null;
}

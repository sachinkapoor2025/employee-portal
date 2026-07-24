import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { startActivityTracking, stopActivityTracking } from "../services/activityTracker";

export default function ActivityTracker() {
  const location = useLocation();

  useEffect(() => {
    if (localStorage.getItem("token")) {
      startActivityTracking();
    }
    return () => stopActivityTracking();
  }, []);

  useEffect(() => {
    if (localStorage.getItem("token")) {
      import("../services/activityTracker").then(({ trackHeartbeat }) =>
        trackHeartbeat(location.pathname)
      );
    }
  }, [location.pathname]);

  return null;
}

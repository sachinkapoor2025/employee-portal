import { logActivity } from "./api";

const HEARTBEAT_MS = 5 * 60 * 1000;
let intervalId = null;
let started = false;

function getDeviceInfo() {
  const ua = navigator.userAgent;
  let device = "Unknown";
  if (/Windows/i.test(ua)) device = "Windows";
  else if (/Mac/i.test(ua)) device = "Mac";
  else if (/Android/i.test(ua)) device = "Android";
  else if (/iPhone|iPad/i.test(ua)) device = "iOS";

  return { device, userAgent: ua };
}

export async function trackLogin() {
  const { device, userAgent } = getDeviceInfo();
  try {
    await logActivity({
      type: "login",
      page: window.location.pathname,
      device,
      userAgent,
      sessionMinutes: 0,
    });
  } catch (e) {
    console.warn("Activity log failed", e);
  }
}

export async function trackHeartbeat(page) {
  const { device, userAgent } = getDeviceInfo();
  try {
    await logActivity({
      type: "heartbeat",
      page: page || window.location.pathname,
      device,
      userAgent,
      sessionMinutes: 5,
    });
  } catch (e) {
    console.warn("Heartbeat failed", e);
  }
}

export function startActivityTracking() {
  if (started || !localStorage.getItem("token")) return;
  started = true;

  trackHeartbeat(window.location.pathname);

  intervalId = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      trackHeartbeat(window.location.pathname);
    }
  }, HEARTBEAT_MS);
}

export function stopActivityTracking() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  started = false;
}

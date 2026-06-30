function parseDevice(userAgent = "") {
  const ua = userAgent.toLowerCase();
  if (ua.includes("windows")) return "Windows";
  if (ua.includes("mac")) return "Mac";
  if (ua.includes("android")) return "Android";
  if (ua.includes("iphone") || ua.includes("ipad")) return "iOS";
  if (ua.includes("linux")) return "Linux";
  return "Unknown";
}

function parseBrowser(userAgent = "") {
  if (/edg\//i.test(userAgent)) return "Edge";
  if (/chrome\//i.test(userAgent)) return "Chrome";
  if (/firefox\//i.test(userAgent)) return "Firefox";
  if (/safari\//i.test(userAgent)) return "Safari";
  return "Unknown";
}

exports.getRequestMeta = (event) => {
  const headers = event.headers || {};
  const forwarded = headers["X-Forwarded-For"] || headers["x-forwarded-for"] || "";
  const ip = forwarded.split(",")[0]?.trim() || headers["X-Real-Ip"] || "unknown";
  const userAgent = headers["User-Agent"] || headers["user-agent"] || "";

  return {
    ip,
    userAgent,
    device: parseDevice(userAgent),
    browser: parseBrowser(userAgent),
  };
};

exports.todayKey = () => new Date().toISOString().slice(0, 10);

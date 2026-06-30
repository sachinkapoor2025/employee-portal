async function resolveLocation(ip) {
  if (!ip || ip === "unknown" || ip.startsWith("127.") || ip.startsWith("10.")) {
    return "Unknown";
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const data = await res.json();
    if (data.status === "success") {
      return [data.city, data.regionName, data.country].filter(Boolean).join(", ");
    }
  } catch (err) {
    console.warn("Geo lookup failed for", ip, err.message);
  }

  return "Unknown";
}

module.exports = { resolveLocation };

export function isZoneNotification(item) {
  const type = String(item?.type || item?.category || "").toUpperCase();
  return (
    type === "TASK_ORANGE" ||
    type === "TASK_RED" ||
    type === "TASK_MOVED_TO_ORANGE" ||
    type === "TASK_MOVED_TO_RED"
  );
}

export function isRedZoneNotification(item) {
  const type = String(item?.type || item?.category || "").toUpperCase();
  const zone = String(item?.zone || "").toUpperCase();
  return type === "TASK_RED" || type === "TASK_MOVED_TO_RED" || zone === "RED";
}

export function notificationTaskPath(item, employeeView) {
  const taskId = item?.taskId;
  if (!taskId) return "";
  return employeeView
    ? `/work/${encodeURIComponent(taskId)}`
    : `/admin/tasks/${encodeURIComponent(taskId)}`;
}

export function relativeTime(value) {
  const ms = Date.parse(value || "");
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function unreadCount(items) {
  return (items || []).filter((n) => n && n.read !== true).length;
}

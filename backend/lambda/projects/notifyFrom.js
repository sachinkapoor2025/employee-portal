const DEFAULT_FROM = "notify@mydgv.com";

function notifyFromAddress() {
  const configured = String(process.env.TASK_NOTIFY_FROM_EMAIL || "").trim();
  return configured || DEFAULT_FROM;
}

function notifyFromName() {
  return (
    String(process.env.TASK_NOTIFY_FROM_NAME || "").trim() ||
    process.env.NOTIFICATION_FROM_NAME ||
    "DGV Portal"
  );
}

module.exports = {
  DEFAULT_FROM,
  notifyFromAddress,
  notifyFromName,
};

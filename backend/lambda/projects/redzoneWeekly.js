/**
 * Weekly Red-Zone ticket email — uses existing escalation zone math.
 * Does not replace Green/Orange/Red calculation.
 */

const escalation = require("./escalation");

const DGV_EMAIL = "dgv@mydgv.com";
const CONFIG_PK = "ENTITY#CONFIG";
const CONFIG_SK = "REDZONE_WEEKLY_EMAIL";
const REPORT_PK = "ENTITY#REDZONE_REPORT";
const LOCK_MS = 10 * 60 * 1000;

const WEEKDAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

const WEEKDAY_FROM_SHORT = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function companyTimeZone() {
  return process.env.COMPANY_TIMEZONE || "Asia/Kolkata";
}

function portalUrl() {
  return String(process.env.PORTAL_URL || "https://login.mydgv.com").replace(
    /\/$/,
    ""
  );
}

function normalizeConfig(raw = {}) {
  const weekday = Number(raw.weekday);
  const time = String(raw.sendTime || "09:00").trim();
  const okTime = /^\d{2}:\d{2}$/.test(time) ? time : "09:00";
  return {
    enabled: raw.enabled === true || raw.enabled === "true",
    weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : 1,
    sendTime: okTime,
    dgvEmail: DGV_EMAIL,
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || "",
  };
}

function zonedParts(date, timeZone = companyTimeZone()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const map = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const weekday = WEEKDAY_FROM_SHORT[String(map.weekday || "").slice(0, 3).toLowerCase()];
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: Number.isInteger(weekday) ? weekday : 1,
  };
}

function minutesOfDay(hour, minute) {
  return Number(hour) * 60 + Number(minute);
}

function parseSendMinutes(sendTime) {
  const [h, m] = String(sendTime || "09:00").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 9 * 60;
  return minutesOfDay(h, m);
}

function weekIdFor(date, timeZone, weekday) {
  const parts = zonedParts(date, timeZone);
  const delta = (parts.weekday - weekday + 7) % 7;
  const [y, mo, d] = parts.dateKey.split("-").map(Number);
  const base = Date.UTC(y, mo - 1, d);
  const sendDay = new Date(base - delta * 24 * 60 * 60 * 1000);
  const yyyy = sendDay.getUTCFullYear();
  const mm = String(sendDay.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(sendDay.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function shouldSendNow(config, date = new Date(), timeZone = companyTimeZone()) {
  if (!config || config.enabled === false) return false;
  const parts = zonedParts(date, timeZone);
  if (parts.weekday !== config.weekday) return false;
  return minutesOfDay(parts.hour, parts.minute) >= parseSendMinutes(config.sendTime);
}

function displayTaskId(taskId) {
  if (!taskId) return "—";
  const short = String(taskId).replace(/-/g, "").slice(0, 8).toUpperCase();
  return `TASK-${short}`;
}

function statusLabel(status) {
  const key = String(status || "TODO").toUpperCase();
  const map = {
    TODO: "To Do",
    IN_PROGRESS: "In Progress",
    REVIEW: "Review",
    DONE: "Completed",
    CANCELLED: "Cancelled",
    BACKLOG: "Backlog",
  };
  return map[key] || key.replace(/_/g, " ");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function summarize(text, max = 160) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "—";
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1)}…`;
}

function formatInZone(value, timeZone = companyTimeZone()) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
}

function redDurationLabel(dueDate, nowMs = Date.now()) {
  const deadlineMs = escalation.parseDeadlineMs(dueDate);
  if (!Number.isFinite(deadlineMs)) return "—";
  const redStart = deadlineMs + escalation.ORANGE_MS;
  if (nowMs < redStart) return "—";
  return escalation.formatDuration(nowMs - redStart);
}

function taskLink(taskId) {
  if (!taskId) return portalUrl();
  return `${portalUrl()}/admin/tasks/${encodeURIComponent(taskId)}`;
}

function collectRedZoneRows(tasks, nowMs = Date.now()) {
  const rows = [];
  for (const task of tasks || []) {
    if (!task || task.archived) continue;
    const decorated = escalation.decorateTask(task, nowMs);
    for (const assignment of decorated.assignments || []) {
      if (!assignment || assignment.removed) continue;
      if (escalation.isComplete(assignment.status)) continue;
      if (escalation.isCancelled(assignment.status)) continue;
      if (assignment.zone !== escalation.ZONES.RED) continue;
      rows.push({ task: decorated, assignment });
    }
  }
  return rows;
}

function indexProfiles(items = []) {
  const byEmail = {};
  const byName = {};
  for (const p of items) {
    const email = escalation.normalizeEmail(
      p.email || String(p.PK || "").replace(/^USER#/i, "")
    );
    if (!email) continue;
    const row = {
      email,
      name: p.name || "",
      groupLead: p.groupLead || "",
      manager: p.manager || "",
    };
    byEmail[email] = row;
    if (row.name) byName[String(row.name).trim().toLowerCase()] = email;
  }
  return { byEmail, byName };
}

function resolveTeamLeadEmail(profile, profiles) {
  const raw = String(profile?.groupLead || profile?.manager || "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return escalation.normalizeEmail(raw);
  return profiles.byName[raw.toLowerCase()] || "";
}

function enrichRows(rows, profiles, nowMs = Date.now()) {
  return (rows || []).map((row) => {
    const assigneeEmail = escalation.normalizeEmail(row.assignment.email);
    const profile = profiles.byEmail[assigneeEmail] || {
      email: assigneeEmail,
      name: "",
    };
    const leadEmail = resolveTeamLeadEmail(profile, profiles);
    const lead = leadEmail
      ? profiles.byEmail[leadEmail] || { email: leadEmail, name: "" }
      : { email: "", name: "" };
    return {
      taskId: row.task.taskId,
      displayId: displayTaskId(row.task.taskId),
      title: row.task.title || "Untitled task",
      description: summarize(row.task.description),
      assigneeEmail,
      assigneeName: profile.name || assigneeEmail,
      leadEmail,
      leadName: lead.name || leadEmail || "—",
      status: statusLabel(row.assignment.status || row.task.status),
      zone: "Red Zone",
      priority: escalation.priorityLabel(row.task.priority),
      dueDate: row.task.dueDate || "",
      createdAt: row.task.createdAt || "",
      redDuration: redDurationLabel(row.task.dueDate, nowMs),
      escalation: row.assignment.timing ||
        escalation.formatTiming({
          dueDate: row.task.dueDate,
          zone: escalation.ZONES.RED,
          status: row.assignment.status,
          nowMs,
        }),
      link: taskLink(row.task.taskId),
    };
  });
}

function uniqueEmails(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const email = escalation.normalizeEmail(item);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function recipientsForRow(row, dgvEmail = DGV_EMAIL) {
  return uniqueEmails([row.assigneeEmail, row.leadEmail, dgvEmail]);
}

function groupByRecipient(rows, dgvEmail = DGV_EMAIL) {
  const grouped = {};
  if (!rows || !rows.length) {
    grouped[escalation.normalizeEmail(dgvEmail)] = [];
    return grouped;
  }
  for (const row of rows) {
    for (const email of recipientsForRow(row, dgvEmail)) {
      if (!grouped[email]) grouped[email] = [];
      grouped[email].push(row);
    }
  }
  return grouped;
}

function buildEmptyHtml() {
  return `
  <div style="font-family:Arial,sans-serif;color:#111827;max-width:720px">
    <div style="background:#166534;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
      <h1 style="margin:0;font-size:20px">Weekly Red-Zone Ticket Report</h1>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 8px 8px">
      <p style="margin:0 0 8px;font-size:16px"><strong>There are currently no Red-Zone tasks.</strong></p>
      <p style="margin:0;color:#4b5563">No incomplete assignments are in Red Zone at this time.</p>
    </div>
  </div>`;
}

function buildReportHtml(rows, recipientEmail) {
  if (!rows.length) return buildEmptyHtml();
  const count = rows.length;
  const body = rows
    .map((row) => {
      return `<tr>
        <td style="padding:8px;border:1px solid #fecaca">${escapeHtml(row.displayId)}</td>
        <td style="padding:8px;border:1px solid #fecaca">
          <a href="${escapeHtml(row.link)}" style="color:#b91c1c;font-weight:700">${escapeHtml(row.title)}</a>
        </td>
        <td style="padding:8px;border:1px solid #fecaca">${escapeHtml(row.description)}</td>
        <td style="padding:8px;border:1px solid #fecaca">${escapeHtml(row.assigneeName)}<br/><span style="color:#6b7280;font-size:12px">${escapeHtml(row.assigneeEmail)}</span></td>
        <td style="padding:8px;border:1px solid #fecaca">${escapeHtml(row.leadName)}${row.leadEmail ? `<br/><span style="color:#6b7280;font-size:12px">${escapeHtml(row.leadEmail)}</span>` : ""}</td>
        <td style="padding:8px;border:1px solid #fecaca">${escapeHtml(row.status)}</td>
        <td style="padding:8px;border:1px solid #fecaca;background:#fee2e2;color:#991b1b;font-weight:700">🔴 Red Zone</td>
        <td style="padding:8px;border:1px solid #fecaca">${escapeHtml(row.priority)}</td>
        <td style="padding:8px;border:1px solid #fecaca">${escapeHtml(formatInZone(row.dueDate))}</td>
        <td style="padding:8px;border:1px solid #fecaca">${escapeHtml(formatInZone(row.createdAt))}</td>
        <td style="padding:8px;border:1px solid #fecaca">${escapeHtml(row.redDuration)}</td>
        <td style="padding:8px;border:1px solid #fecaca">${escapeHtml(row.escalation)}</td>
      </tr>`;
    })
    .join("");

  return `
  <div style="font-family:Arial,sans-serif;color:#111827;max-width:1100px">
    <div style="background:#991b1b;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
      <h1 style="margin:0;font-size:20px">Weekly Red-Zone Ticket Report</h1>
      <p style="margin:8px 0 0;opacity:.9">Critical overdue assignments that have passed the 24-hour Orange period.</p>
    </div>
    <div style="border:1px solid #fecaca;border-top:none;padding:16px 20px;background:#fef2f2">
      <p style="margin:0;font-size:15px"><strong>${count}</strong> red-zone ${count === 1 ? "task" : "tasks"} require attention.</p>
      <p style="margin:6px 0 0;color:#7f1d1d;font-size:13px">Prepared for ${escapeHtml(recipientEmail)}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff">
      <thead>
        <tr style="background:#7f1d1d;color:#fff">
          <th style="padding:8px;text-align:left">Ticket ID</th>
          <th style="padding:8px;text-align:left">Title</th>
          <th style="padding:8px;text-align:left">Summary</th>
          <th style="padding:8px;text-align:left">Assigned person</th>
          <th style="padding:8px;text-align:left">Team Lead</th>
          <th style="padding:8px;text-align:left">Status</th>
          <th style="padding:8px;text-align:left">Zone</th>
          <th style="padding:8px;text-align:left">Priority</th>
          <th style="padding:8px;text-align:left">Due date</th>
          <th style="padding:8px;text-align:left">Created</th>
          <th style="padding:8px;text-align:left">Red-zone duration</th>
          <th style="padding:8px;text-align:left">Escalation</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function buildReportText(rows) {
  if (!rows.length) {
    return "Weekly Red-Zone Ticket Report\n\nThere are currently no Red-Zone tasks.";
  }
  const lines = [
    `Weekly Red-Zone Ticket Report`,
    `Total red-zone tasks: ${rows.length}`,
    "",
  ];
  for (const row of rows) {
    lines.push(
      `${row.displayId} | ${row.title} | ${row.assigneeName} | Lead: ${row.leadName} | ${row.status} | Red Zone | ${row.priority} | Due ${formatInZone(row.dueDate)} | ${row.redDuration}`
    );
    if (row.link) lines.push(row.link);
    lines.push("");
  }
  return lines.join("\n");
}

function canRetry(report) {
  const status = String(report?.status || "").toUpperCase();
  return status === "FAILED" || status === "PARTIAL";
}

function isInFlight(report, nowMs = Date.now()) {
  if (String(report?.status || "").toUpperCase() !== "PENDING") return false;
  const updated = Date.parse(report.updatedAt || report.createdAt || "");
  return Number.isFinite(updated) && nowMs - updated < LOCK_MS;
}

function alreadySent(report) {
  const status = String(report?.status || "").toUpperCase();
  return status === "SENT" || status === "EMPTY";
}

function emailsToSend(grouped, existing) {
  const all = Object.keys(grouped);
  if (!existing || !canRetry(existing)) return all;
  const failed = new Set(
    (existing.results || [])
      .filter((r) => String(r.status || "").toUpperCase() === "FAILED")
      .map((r) => escalation.normalizeEmail(r.email))
  );
  if (!failed.size) return all;
  return all.filter((email) => failed.has(email));
}

module.exports = {
  DGV_EMAIL,
  CONFIG_PK,
  CONFIG_SK,
  REPORT_PK,
  WEEKDAYS,
  LOCK_MS,
  companyTimeZone,
  portalUrl,
  normalizeConfig,
  zonedParts,
  weekIdFor,
  shouldSendNow,
  displayTaskId,
  collectRedZoneRows,
  indexProfiles,
  resolveTeamLeadEmail,
  enrichRows,
  uniqueEmails,
  recipientsForRow,
  groupByRecipient,
  buildReportHtml,
  buildEmptyHtml,
  buildReportText,
  canRetry,
  isInFlight,
  alreadySent,
  emailsToSend,
  redDurationLabel,
  taskLink,
};

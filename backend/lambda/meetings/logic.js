/**
 * Meeting status, validation, and reminder helpers.
 * Status LIVE/COMPLETED is always computed from start/end time.
 * Only CANCELLED is stored; admins cannot set LIVE or COMPLETED.
 */

const MEETING_TYPES = ["ZOOM", "GOOGLE_MEET", "MICROSOFT_TEAMS", "OTHER"];

const TYPE_LABELS = {
  ZOOM: "Zoom",
  GOOGLE_MEET: "Google Meet",
  MICROSOFT_TEAMS: "Microsoft Teams",
  OTHER: "Other",
};

const TYPE_ALIASES = {
  ZOOM: "ZOOM",
  "GOOGLE MEET": "GOOGLE_MEET",
  GOOGLE_MEET: "GOOGLE_MEET",
  MEET: "GOOGLE_MEET",
  "MICROSOFT TEAMS": "MICROSOFT_TEAMS",
  MICROSOFT_TEAMS: "MICROSOFT_TEAMS",
  TEAMS: "MICROSOFT_TEAMS",
  OTHER: "OTHER",
};

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

function padTime(time) {
  const raw = String(time || "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = String(Number(m[1])).padStart(2, "0");
  const mm = String(m[2]).padStart(2, "0");
  return `${hh}:${mm}`;
}

function combineDateTime(date, time, offset = "+05:30") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  const t = padTime(time);
  if (!t) return null;
  const d = new Date(`${date}T${t}:00${offset}`);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

function normalizeType(value) {
  const key = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  const compact = key.replace(/\s+/g, "_");
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key];
  if (TYPE_ALIASES[compact]) return TYPE_ALIASES[compact];
  if (MEETING_TYPES.includes(compact)) return compact;
  return null;
}

function typeLabel(value) {
  const t = normalizeType(value) || String(value || "").toUpperCase();
  return TYPE_LABELS[t] || value || "";
}

function computeStatus(meeting, nowMs = Date.now()) {
  if (!meeting) return "UPCOMING";
  if (String(meeting.status || "").toUpperCase() === "CANCELLED" || meeting.cancelled) {
    return "CANCELLED";
  }
  const start = new Date(meeting.startDateTime).getTime();
  const end = new Date(meeting.endDateTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "UPCOMING";
  if (nowMs < start) return "UPCOMING";
  if (nowMs >= start && nowMs < end) return "LIVE";
  return "COMPLETED";
}

function joinLeadMinutesFromEnv(env = process.env) {
  const n = Number(env.MEETING_JOIN_LEAD_MINUTES);
  if (!Number.isFinite(n) || n < 0) return 10;
  return Math.min(120, Math.floor(n));
}

function canJoinMeeting(meeting, nowMs = Date.now(), leadMinutes = 10) {
  const status = computeStatus(meeting, nowMs);
  if (status === "CANCELLED" || status === "COMPLETED") return false;
  const start = new Date(meeting.startDateTime).getTime();
  const end = new Date(meeting.endDateTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const openAt = start - leadMinutes * MIN_MS;
  return nowMs >= openAt && nowMs < end;
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function uniqueEmails(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const email = String(raw || "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function validateMeetingPayload(body = {}) {
  const title = String(body.title || body.meetingTitle || "").trim();
  const description = String(body.description || "").trim();
  const date = String(body.date || body.meetingDate || "").trim();
  const startTime = padTime(body.startTime);
  const endTime = padTime(body.endTime);
  const meetingType = normalizeType(body.meetingType);
  const meetingLink = String(body.meetingLink || "").trim();
  const participantEmails = uniqueEmails(
    body.participantEmails ||
      body.participants ||
      (Array.isArray(body.employeeIds) ? body.employeeIds : [])
  );

  if (!title) return { error: "Meeting title is required." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Date is required." };
  if (!startTime) return { error: "Start time is required." };
  if (!endTime) return { error: "End time is required." };
  const start = combineDateTime(date, startTime);
  const end = combineDateTime(date, endTime);
  if (!start || !end) return { error: "Date and time are invalid." };
  if (end.getTime() <= start.getTime()) {
    return { error: "End time must be greater than start time." };
  }
  if (!meetingType) return { error: "Meeting type is required." };
  if (!meetingLink) {
    return { error: "Meeting link is required for Zoom, Google Meet, Microsoft Teams, and Other." };
  }
  if (!isHttpUrl(meetingLink)) {
    return { error: "Meeting link must be a valid http or https URL." };
  }
  if (!participantEmails.length) {
    return { error: "At least one employee should be selected." };
  }

  return {
    error: null,
    value: {
      title,
      description,
      date,
      startTime,
      endTime,
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      meetingType,
      meetingLink,
      participantEmails,
    },
  };
}

function formatNotifyWhen(iso, timeZone = "Asia/Kolkata") {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return { date: "", time: "" };
  const date = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone,
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  });
  return { date, time };
}

function inviteMessage(meeting, timeZone) {
  const { date, time } = formatNotifyWhen(meeting.startDateTime, timeZone);
  return `You have been invited to ${meeting.title} on ${date} at ${time}.`;
}

function cancelMessage(meeting, timeZone) {
  const { date, time } = formatNotifyWhen(meeting.startDateTime, timeZone);
  return `${meeting.title} scheduled for ${date} at ${time} has been cancelled.`;
}

function updateMessage(meeting) {
  return `The meeting details for ${meeting.title} have been updated.`;
}

function reminderMessage(meeting, kind, timeZone) {
  const { time } = formatNotifyWhen(meeting.startDateTime, timeZone);
  if (kind === "24H") {
    return `Reminder: ${meeting.title} is tomorrow at ${time}.`;
  }
  if (kind === "30M") {
    return `Reminder: ${meeting.title} starts in 30 minutes.`;
  }
  return `Reminder: ${meeting.title} starts in 10 minutes.`;
}

function dueReminderKinds(startMs, nowMs) {
  const remaining = startMs - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return [];
  const kinds = [];
  if (remaining <= 24 * HOUR_MS + 6 * MIN_MS && remaining >= 23 * HOUR_MS) {
    kinds.push("24H");
  }
  if (remaining <= 35 * MIN_MS && remaining >= 20 * MIN_MS) {
    kinds.push("30M");
  }
  if (remaining <= 15 * MIN_MS && remaining >= 1 * MIN_MS) {
    kinds.push("10M");
  }
  return kinds;
}

function participantDisplayStatus(participant, meetingStatus) {
  const att = String(participant?.attendanceStatus || "INVITED").toUpperCase();
  if (att === "JOINED" || att === "LEFT" || participant?.joinTime) return "Joined";
  if (meetingStatus === "LIVE" || meetingStatus === "COMPLETED") return "Not Joined";
  return "Invited";
}

function startsInMs(meeting, nowMs = Date.now()) {
  const start = new Date(meeting.startDateTime).getTime();
  if (!Number.isFinite(start)) return null;
  return start - nowMs;
}

function formatStartsIn(ms) {
  if (ms == null) return "";
  if (ms <= 0) return "Starting now";
  const totalMins = Math.round(ms / MIN_MS);
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (mins && parts.length < 2) parts.push(`${mins} minute${mins === 1 ? "" : "s"}`);
  return parts.join(" ") || "less than a minute";
}

function detailsChanged(before, after) {
  if (!before || !after) return false;
  return (
    before.title !== after.title ||
    before.description !== after.description ||
    before.startDateTime !== after.startDateTime ||
    before.endDateTime !== after.endDateTime ||
    before.meetingType !== after.meetingType ||
    before.meetingLink !== after.meetingLink
  );
}

function timeChanged(before, after) {
  return (
    !!before &&
    !!after &&
    (before.startDateTime !== after.startDateTime ||
      before.endDateTime !== after.endDateTime)
  );
}

module.exports = {
  MEETING_TYPES,
  TYPE_LABELS,
  computeStatus,
  canJoinMeeting,
  joinLeadMinutesFromEnv,
  validateMeetingPayload,
  normalizeType,
  typeLabel,
  uniqueEmails,
  combineDateTime,
  padTime,
  isHttpUrl,
  formatNotifyWhen,
  inviteMessage,
  cancelMessage,
  updateMessage,
  reminderMessage,
  dueReminderKinds,
  participantDisplayStatus,
  startsInMs,
  formatStartsIn,
  detailsChanged,
  timeChanged,
};

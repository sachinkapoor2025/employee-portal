export const MEETING_TYPES = [
  { value: "ZOOM", label: "Zoom" },
  { value: "GOOGLE_MEET", label: "Google Meet" },
  { value: "MICROSOFT_TEAMS", label: "Microsoft Teams" },
  { value: "OTHER", label: "Other" },
];

export function meetingTypeLabel(type) {
  const found = MEETING_TYPES.find((t) => t.value === String(type || "").toUpperCase());
  if (found) return found.label;
  const raw = String(type || "").replace(/_/g, " ");
  return raw || "—";
}

export function meetingStatusClass(status) {
  const s = String(status || "").toUpperCase();
  if (s === "LIVE") return "dgv-badge dgv-badge--live";
  if (s === "COMPLETED") return "dgv-badge dgv-badge--success";
  if (s === "CANCELLED") return "dgv-badge dgv-badge--danger";
  return "dgv-badge dgv-badge--info";
}

export function formatMeetingDate(isoOrDate) {
  if (!isoOrDate) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDate)) {
    const d = new Date(`${isoOrDate}T12:00:00`);
    if (!Number.isFinite(d.getTime())) return isoOrDate;
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }
  const d = new Date(isoOrDate);
  if (!Number.isFinite(d.getTime())) return String(isoOrDate);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

export function formatMeetingTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleTimeString("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

export function formatMeetingRange(meeting) {
  if (meeting?.startDateTime && meeting?.endDateTime) {
    return `${formatMeetingTime(meeting.startDateTime)} - ${formatMeetingTime(
      meeting.endDateTime
    )}`;
  }
  if (meeting?.startTime && meeting?.endTime) {
    return `${meeting.startTime} - ${meeting.endTime}`;
  }
  return "—";
}

export function formatStartsIn(ms) {
  if (ms == null) return "";
  if (ms <= 0) return "Starting now";
  const totalMins = Math.round(ms / 60000);
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (mins && parts.length < 2) {
    parts.push(`${mins} minute${mins === 1 ? "" : "s"}`);
  }
  return parts.join(" ") || "less than a minute";
}

export function dateKeyIST(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function todayKeyIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function displayNameFromEmail(email) {
  const local = String(email || "").split("@")[0] || "";
  const name = local
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
  return name || email || "Employee";
}

export function isoToDateInput(iso) {
  return dateKeyIST(iso);
}

export function isoToTimeInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  const mm = parts.find((p) => p.type === "minute")?.value || "00";
  return `${hh}:${mm}`;
}

export function groupEmployeeMeetings(meetings) {
  const today = todayKeyIST();
  const todays = [];
  const upcoming = [];
  const past = [];
  for (const m of meetings || []) {
    const status = String(m.status || "").toUpperCase();
    const key = m.date || dateKeyIST(m.startDateTime);
    if (status === "COMPLETED" || status === "CANCELLED") {
      past.push(m);
    } else if (key === today) {
      todays.push(m);
    } else {
      upcoming.push(m);
    }
  }
  return { todays, upcoming, past };
}

export const MEETING_PREFIX = "DGV_MEETING:";
const JOIN_LEAD_MS = 10 * 60 * 1000;

export function toIsoDate(value) {
  const s = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!dmy) return "";
  return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
}

export function padTime(value) {
  const m = String(value || "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

export function combineIstIso(date, time) {
  const d = toIsoDate(date);
  const t = padTime(time);
  if (!d || !t) return "";
  const dt = new Date(`${d}T${t}:00+05:30`);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : "";
}

export function computeMeetingStatus(meeting, nowMs = Date.now()) {
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

export function withComputedMeeting(meeting, nowMs = Date.now()) {
  if (!meeting) return meeting;
  const status = computeMeetingStatus(meeting, nowMs);
  const start = new Date(meeting.startDateTime).getTime();
  const end = new Date(meeting.endDateTime).getTime();
  const canJoin =
    status !== "CANCELLED" &&
    status !== "COMPLETED" &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    nowMs >= start - JOIN_LEAD_MS &&
    nowMs < end;
  const participants = (meeting.participants || []).map((p) => {
    const att = String(p.attendanceStatus || "INVITED").toUpperCase();
    let displayStatus = "Invited";
    if (att === "JOINED" || att === "LEFT" || p.joinTime) displayStatus = "Joined";
    else if (status === "LIVE" || status === "COMPLETED") displayStatus = "Not Joined";
    return { ...p, displayStatus };
  });
  return {
    ...meeting,
    status,
    canJoin,
    joinLeadMinutes: 10,
    startsInMs: Number.isFinite(start) ? start - nowMs : null,
    participantCount: participants.length || meeting.participantCount || 0,
    participants,
  };
}

export function isMeetingAnnouncement(item) {
  return String(item?.message || "").startsWith(MEETING_PREFIX);
}

export function parseMeetingAnnouncement(item) {
  if (!isMeetingAnnouncement(item)) return null;
  try {
    const raw = JSON.parse(String(item.message).slice(MEETING_PREFIX.length));
    if (!raw?.meetingId) return null;
    return withComputedMeeting({ ...raw, announceId: item.announceId });
  } catch {
    return null;
  }
}

export function serializeMeetingAnnouncement(meeting) {
  const { announceId, canJoin, startsInMs, joinLeadMinutes, ...rest } = meeting;
  void announceId;
  void canJoin;
  void startsInMs;
  void joinLeadMinutes;
  return {
    title: `${MEETING_PREFIX}${rest.title || "Meeting"}`,
    message: MEETING_PREFIX + JSON.stringify(rest),
  };
}

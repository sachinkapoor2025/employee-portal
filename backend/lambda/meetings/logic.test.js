const assert = require("assert");
const {
  computeStatus,
  canJoinMeeting,
  validateMeetingPayload,
  dueReminderKinds,
  participantDisplayStatus,
  normalizeType,
  formatStartsIn,
} = require("./logic");

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function meeting(overrides = {}) {
  const start = overrides.startMs || Date.now() + HOUR;
  const end = overrides.endMs || start + HOUR;
  return {
    title: "Weekly Team Meeting",
    status: overrides.status || "SCHEDULED",
    startDateTime: new Date(start).toISOString(),
    endDateTime: new Date(end).toISOString(),
    ...overrides,
  };
}

const now = Date.parse("2026-08-15T05:30:00.000Z");

assert.strictEqual(
  computeStatus(meeting({ startMs: now + HOUR, endMs: now + 2 * HOUR }), now),
  "UPCOMING"
);
assert.strictEqual(
  computeStatus(meeting({ startMs: now - 10 * MIN, endMs: now + 50 * MIN }), now),
  "LIVE"
);
assert.strictEqual(
  computeStatus(meeting({ startMs: now - 2 * HOUR, endMs: now - MIN }), now),
  "COMPLETED"
);
assert.strictEqual(
  computeStatus(meeting({ status: "CANCELLED", startMs: now + HOUR }), now),
  "CANCELLED"
);

assert.strictEqual(
  canJoinMeeting(meeting({ startMs: now + HOUR, endMs: now + 2 * HOUR }), now, 10),
  false
);
assert.strictEqual(
  canJoinMeeting(meeting({ startMs: now + 5 * MIN, endMs: now + HOUR }), now, 10),
  true
);
assert.strictEqual(
  canJoinMeeting(
    meeting({ status: "CANCELLED", startMs: now - MIN, endMs: now + HOUR }),
    now,
    10
  ),
  false
);
assert.strictEqual(
  canJoinMeeting(meeting({ startMs: now - 2 * HOUR, endMs: now - MIN }), now, 10),
  false
);

assert.strictEqual(normalizeType("Zoom"), "ZOOM");
assert.strictEqual(normalizeType("Google Meet"), "GOOGLE_MEET");
assert.strictEqual(normalizeType("Microsoft Teams"), "MICROSOFT_TEAMS");

const missingTitle = validateMeetingPayload({
  date: "2026-08-15",
  startTime: "11:00",
  endTime: "12:00",
  meetingType: "Zoom",
  meetingLink: "https://zoom.us/j/123",
  participantEmails: ["a@mydgv.com"],
});
assert.ok(missingTitle.error);

const badEnd = validateMeetingPayload({
  title: "Weekly Team Meeting",
  date: "2026-08-15",
  startTime: "12:00",
  endTime: "11:00",
  meetingType: "Zoom",
  meetingLink: "https://zoom.us/j/123",
  participantEmails: ["a@mydgv.com"],
});
assert.ok(String(badEnd.error).toLowerCase().includes("end time"));

const noPeople = validateMeetingPayload({
  title: "Weekly Team Meeting",
  date: "2026-08-15",
  startTime: "11:00",
  endTime: "12:00",
  meetingType: "Zoom",
  meetingLink: "https://zoom.us/j/123",
  participantEmails: [],
});
assert.ok(noPeople.error);

const ok = validateMeetingPayload({
  title: "Weekly Team Meeting",
  date: "2026-08-15",
  startTime: "11:00",
  endTime: "12:00",
  meetingType: "Zoom",
  meetingLink: "https://zoom.us/j/abc",
  participantEmails: ["rahul@mydgv.com"],
});
assert.strictEqual(ok.error, null);
assert.strictEqual(ok.value.meetingType, "ZOOM");

assert.deepStrictEqual(dueReminderKinds(now + 24 * HOUR, now), ["24H"]);
assert.deepStrictEqual(dueReminderKinds(now + 30 * MIN, now), ["30M"]);
assert.deepStrictEqual(dueReminderKinds(now + 10 * MIN, now), ["10M"]);
assert.deepStrictEqual(dueReminderKinds(now + 2 * HOUR, now), []);
assert.deepStrictEqual(dueReminderKinds(now - MIN, now), []);

assert.strictEqual(
  participantDisplayStatus({ attendanceStatus: "JOINED" }, "LIVE"),
  "Joined"
);
assert.strictEqual(
  participantDisplayStatus({ attendanceStatus: "INVITED" }, "COMPLETED"),
  "Not Joined"
);
assert.strictEqual(
  participantDisplayStatus({ attendanceStatus: "INVITED" }, "UPCOMING"),
  "Invited"
);

assert.ok(formatStartsIn(2 * HOUR + 15 * MIN).includes("2 hour"));

console.log("meetings logic tests passed");

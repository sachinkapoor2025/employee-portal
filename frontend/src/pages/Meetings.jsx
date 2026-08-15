import { useEffect, useMemo, useState } from "react";
import Layout from "../components/Layout";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import { fetchMyMeetings, fetchMyMeeting, joinMeeting } from "../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  alertError,
} from "../theme";
import {
  meetingTypeLabel,
  meetingStatusClass,
  formatMeetingDate,
  formatMeetingRange,
  formatStartsIn,
  groupEmployeeMeetings,
} from "../utils/meetings";

function MeetingCard({ meeting, onView, onJoin, joiningId }) {
  const live = meeting.status === "LIVE";
  return (
    <div
      style={{
        background: "var(--dgv-surface-solid)",
        border: `1px solid ${
          live ? "rgba(239,68,68,0.45)" : "var(--dgv-border)"
        }`,
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 16 }}>{meeting.title}</strong>
        <span className={meetingStatusClass(meeting.status)}>{meeting.status}</span>
      </div>
      {meeting.description ? (
        <p style={{ margin: "8px 0", color: colors.textMuted }}>{meeting.description}</p>
      ) : null}
      <p style={{ margin: "4px 0", fontSize: 14 }}>
        {formatMeetingDate(meeting.date || meeting.startDateTime)}
      </p>
      <p style={{ margin: "4px 0", fontSize: 14 }}>{formatMeetingRange(meeting)}</p>
      <p style={{ margin: "4px 0", fontSize: 14 }}>
        {meetingTypeLabel(meeting.meetingType)}
      </p>
      {meeting.meetingLink && meeting.status !== "CANCELLED" ? (
        <p style={{ margin: "4px 0 12px", fontSize: 14, wordBreak: "break-all" }}>
          <a
            href={meeting.meetingLink}
            target="_blank"
            rel="noopener noreferrer"
          >
            {meeting.meetingLink}
          </a>
        </p>
      ) : (
        <div style={{ height: 12 }} />
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="ghost" onClick={() => onView(meeting)}>
          View Details
        </Button>
        {meeting.meetingLink && meeting.status !== "COMPLETED" && meeting.status !== "CANCELLED" ? (
          <Button onClick={() => onJoin(meeting)} loading={joiningId === meeting.meetingId}>
            Join Meeting
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, items, empty, onView, onJoin, joiningId }) {
  return (
    <section style={{ marginTop: 24 }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>{title}</h3>
      {items.length === 0 ? (
        <p style={{ color: colors.textMuted, fontSize: 14 }}>{empty}</p>
      ) : (
        items.map((m) => (
          <MeetingCard
            key={m.meetingId}
            meeting={m}
            onView={onView}
            onJoin={onJoin}
            joiningId={joiningId}
          />
        ))
      )}
    </section>
  );
}

export default function Meetings() {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState(null);
  const [joiningId, setJoiningId] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const rows = await fetchMyMeetings();
      setMeetings(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err.message || "Unable to load meetings.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const grouped = useMemo(() => groupEmployeeMeetings(meetings), [meetings]);

  const openDetails = async (row) => {
    try {
      const full = await fetchMyMeeting(row.meetingId);
      setDetail(full);
    } catch (err) {
      setError(err.message || "Unable to open meeting.");
    }
  };

  const handleJoin = async (row) => {
    const url = row.meetingLink;
    if (!url) {
      setError("Meeting link is not available.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    setJoiningId(row.meetingId);
    try {
      await joinMeeting(row.meetingId);
    } catch (err) {
      console.warn("Join tracking failed:", err);
    } finally {
      setJoiningId("");
    }
  };

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>My Meetings</h2>
        <p style={pageSubtitle}>
          View meetings assigned to you. Join opens Zoom, Google Meet, or
          Microsoft Teams.
        </p>
        {error ? <div style={alertError}>{error}</div> : null}
        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading meetings…</p>
        ) : (
          <>
            <Section
              title="Today's Meetings"
              items={grouped.todays}
              empty="No meetings today."
              onView={openDetails}
              onJoin={handleJoin}
              joiningId={joiningId}
            />
            <Section
              title="Upcoming Meetings"
              items={grouped.upcoming}
              empty="No upcoming meetings."
              onView={openDetails}
              onJoin={handleJoin}
              joiningId={joiningId}
            />
            <Section
              title="Past Meetings"
              items={grouped.past}
              empty="No past meetings."
              onView={openDetails}
              onJoin={handleJoin}
              joiningId={joiningId}
            />
          </>
        )}
      </div>

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.title || "Meeting"}
      >
        {detail ? (
          <>
            <p style={{ color: colors.textMuted, marginTop: 0 }}>
              {detail.description || "No description."}
            </p>
            <p>
              <strong>Date:</strong>{" "}
              {formatMeetingDate(detail.date || detail.startDateTime)}
            </p>
            <p>
              <strong>Time:</strong> {formatMeetingRange(detail)}
            </p>
            <p>
              <strong>Meeting Type:</strong> {meetingTypeLabel(detail.meetingType)}
            </p>
            {detail.meetingLink && detail.status !== "CANCELLED" ? (
              <p style={{ wordBreak: "break-all" }}>
                <strong>Meeting Link:</strong>{" "}
                <a
                  href={detail.meetingLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {detail.meetingLink}
                </a>
              </p>
            ) : null}
            <p>
              <strong>Status:</strong>{" "}
              <span className={meetingStatusClass(detail.status)}>{detail.status}</span>
            </p>
            {detail.status === "UPCOMING" ? (
              <p>
                <strong>Starts in:</strong> {formatStartsIn(detail.startsInMs)}
              </p>
            ) : null}
            {detail.status === "COMPLETED" ? <p>Meeting Completed</p> : null}
            {detail.status === "CANCELLED" ? <p>Meeting Cancelled</p> : null}
            {detail.meetingLink && detail.status !== "COMPLETED" && detail.status !== "CANCELLED" ? (
              <Button
                onClick={() => handleJoin(detail)}
                loading={joiningId === detail.meetingId}
              >
                Join Meeting
              </Button>
            ) : null}
          </>
        ) : null}
      </Modal>
    </Layout>
  );
}

import { useEffect, useMemo, useState } from "react";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import {
  fetchAdminMeetings,
  fetchAdminMeeting,
  createMeeting,
  updateMeeting,
  cancelMeeting,
  fetchUsers,
} from "../../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  formLabel,
  formInput,
  formSelect,
  alertError,
} from "../../theme";
import {
  MEETING_TYPES,
  meetingTypeLabel,
  meetingStatusClass,
  formatMeetingDate,
  formatMeetingRange,
  displayNameFromEmail,
  isoToDateInput,
  isoToTimeInput,
  toIsoDate,
} from "../../utils/meetings";

const TABS = ["UPCOMING", "LIVE", "COMPLETED", "CANCELLED"];

const emptyForm = {
  title: "",
  description: "",
  date: "",
  startTime: "",
  endTime: "",
  meetingType: "ZOOM",
  meetingLink: "",
  participantEmails: [],
};

function endTimeFromStart(startTime) {
  const m = String(startTime || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  const minutes = Number(m[1]) * 60 + Number(m[2]) + 60;
  if (minutes >= 24 * 60) return "23:59";
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function validateForm(form) {
  if (!String(form.title || "").trim()) return "Meeting title is required.";
  if (!toIsoDate(form.date)) return "Date is required.";
  if (!form.startTime) return "Start time is required.";
  if (!endTimeFromStart(form.startTime)) return "Start time is required.";
  if (!form.meetingType) return "Meeting type is required.";
  if (!String(form.meetingLink || "").trim()) {
    return "Meeting link is required for Zoom, Google Meet, Microsoft Teams, and Other.";
  }
  if (!form.participantEmails.length) {
    return "At least one employee should be selected.";
  }
  return "";
}

export default function AdminMeetings() {
  const [meetings, setMeetings] = useState([]);
  const [users, setUsers] = useState([]);
  const [tab, setTab] = useState("UPCOMING");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [viewItem, setViewItem] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);

  const userNames = useMemo(() => {
    const map = {};
    users.forEach((u) => {
      const email = String(u.email || "").toLowerCase();
      if (email) map[email] = u.name || displayNameFromEmail(email);
    });
    return map;
  }, [users]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [rows, people] = await Promise.all([
        fetchAdminMeetings(),
        fetchUsers().catch(() => []),
      ]);
      setMeetings(Array.isArray(rows) ? rows : []);
      setUsers(Array.isArray(people) ? people : []);
    } catch (err) {
      setError(err.message || "Unable to load meetings.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const visible = useMemo(
    () => meetings.filter((m) => String(m.status || "").toUpperCase() === tab),
    [meetings, tab]
  );

  const employeeOptions = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    return users
      .filter((u) => String(u.status || "").toUpperCase() !== "BLOCKED")
      .filter((u) => {
        const email = String(u.email || "").toLowerCase();
        const name = String(u.name || displayNameFromEmail(email)).toLowerCase();
        if (!q) return true;
        return email.includes(q) || name.includes(q);
      })
      .sort((a, b) =>
        String(a.name || a.email).localeCompare(String(b.name || b.email))
      );
  }, [users, userSearch]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormError("");
    setUserSearch("");
    setFormOpen(true);
  };

  const openEdit = (row) => {
    setEditing(row);
    setForm({
      title: row.title || "",
      description: row.description || "",
      date: row.date || isoToDateInput(row.startDateTime),
      startTime: row.startTime || isoToTimeInput(row.startDateTime),
      endTime: row.endTime || isoToTimeInput(row.endDateTime),
      meetingType: row.meetingType || "ZOOM",
      meetingLink: row.meetingLink || "",
      participantEmails: [],
    });
    setFormError("");
    setUserSearch("");
    setFormOpen(true);
    fetchAdminMeeting(row.meetingId)
      .then((detail) => {
        const emails = (detail.participants || []).map((p) =>
          String(p.employeeId || "").toLowerCase()
        );
        setForm((prev) => ({ ...prev, participantEmails: emails }));
      })
      .catch(() => {});
  };

  const openView = async (row) => {
    try {
      const detail = await fetchAdminMeeting(row.meetingId);
      setViewItem(detail);
    } catch (err) {
      setError(err.message || "Unable to load meeting.");
    }
  };

  const toggleParticipant = (email) => {
    const key = String(email).toLowerCase();
    setForm((prev) => {
      const has = prev.participantEmails.includes(key);
      return {
        ...prev,
        participantEmails: has
          ? prev.participantEmails.filter((e) => e !== key)
          : [...prev.participantEmails, key],
      };
    });
  };

  const selectAll = () => {
    const all = employeeOptions
      .map((u) => String(u.email || "").toLowerCase())
      .filter(Boolean);
    setForm((prev) => ({ ...prev, participantEmails: all }));
  };

  const save = async () => {
    const message = validateForm(form);
    if (message) {
      setFormError(message);
      return;
    }
    setSaving(true);
    setFormError("");
    const payload = {
      ...form,
      title: form.title.trim(),
      date: toIsoDate(form.date),
      meetingLink: form.meetingLink.trim(),
      endTime: endTimeFromStart(form.startTime),
      participantNames: userNames,
    };
    try {
      if (editing) {
        await updateMeeting({ ...payload, meetingId: editing.meetingId });
      } else {
        await createMeeting(payload);
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(err.message || "Unable to save meeting.");
    } finally {
      setSaving(false);
    }
  };

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    try {
      await cancelMeeting(cancelTarget.meetingId);
      setCancelTarget(null);
      if (viewItem?.meetingId === cancelTarget.meetingId) setViewItem(null);
      await load();
    } catch (err) {
      setError(err.message || "Unable to cancel meeting.");
    }
  };

  return (
    <Layout>
      <div style={pageCard}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div>
            <h2 style={pageTitle}>Meetings</h2>
            <p style={{ ...pageSubtitle, marginBottom: 0 }}>
              Create and assign meetings. Employees join through Zoom, Google
              Meet, or Microsoft Teams.
            </p>
          </div>
          <Button onClick={openCreate}>+ Create Meeting</Button>
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            margin: "20px 0 16px",
          }}
        >
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              className={tab === t ? "dgv-btn dgv-btn--primary" : "dgv-btn dgv-btn--ghost"}
              onClick={() => setTab(t)}
              style={{ fontSize: 13 }}
            >
              {t.charAt(0) + t.slice(1).toLowerCase()}
            </button>
          ))}
        </div>

        {error ? <div style={alertError}>{error}</div> : null}
        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading meetings…</p>
        ) : visible.length === 0 ? (
          <p style={{ color: colors.textMuted }}>No {tab.toLowerCase()} meetings.</p>
        ) : (
          <div className="dgv-table-wrap">
            <table className="dgv-table">
              <thead>
                <tr>
                  <th>Meeting</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Participants</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.meetingId}>
                    <td>
                      <strong>{row.title}</strong>
                      {row.description ? (
                        <div style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }}>
                          {row.description}
                        </div>
                      ) : null}
                    </td>
                    <td>{formatMeetingDate(row.date || row.startDateTime)}</td>
                    <td>{formatMeetingRange(row)}</td>
                    <td>{row.participantCount || 0} Employees</td>
                    <td>{meetingTypeLabel(row.meetingType)}</td>
                    <td>
                      <span className={meetingStatusClass(row.status)}>{row.status}</span>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <Button variant="ghost" onClick={() => openView(row)}>
                          View
                        </Button>
                        {row.status !== "CANCELLED" && row.status !== "COMPLETED" ? (
                          <Button variant="ghost" onClick={() => openEdit(row)}>
                            Edit
                          </Button>
                        ) : null}
                        {row.status !== "CANCELLED" && row.status !== "COMPLETED" ? (
                          <Button variant="ghost" onClick={() => setCancelTarget(row)}>
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? "Edit Meeting" : "Create Meeting"}
        maxWidth={640}
      >
        <label style={formLabel}>Meeting Title</label>
        <input
          style={formInput}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
        <label style={formLabel}>Description</label>
        <textarea
          style={{ ...formInput, minHeight: 80 }}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <label style={formLabel}>Meeting Date</label>
        <input
          style={formInput}
          type="date"
          value={form.date}
          onChange={(e) => setForm({ ...form, date: e.target.value })}
        />
        <label style={formLabel}>Start Time</label>
        <input
          style={formInput}
          type="time"
          value={form.startTime}
          onChange={(e) => setForm({ ...form, startTime: e.target.value })}
        />
        <label style={formLabel}>Meeting Type</label>
        <select
          style={formSelect}
          value={form.meetingType}
          onChange={(e) => setForm({ ...form, meetingType: e.target.value })}
        >
          {MEETING_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <label style={formLabel}>Meeting Link</label>
        <input
          style={formInput}
          placeholder="https://zoom.us/..."
          value={form.meetingLink}
          onChange={(e) => setForm({ ...form, meetingLink: e.target.value })}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <label style={{ ...formLabel, marginBottom: 0 }}>Participants</label>
          <Button variant="ghost" onClick={selectAll}>
            Select All Employees
          </Button>
        </div>
        <input
          style={formInput}
          placeholder="Search employees"
          value={userSearch}
          onChange={(e) => setUserSearch(e.target.value)}
        />
        <div
          style={{
            maxHeight: 180,
            overflowY: "auto",
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: 8,
            marginBottom: 16,
          }}
        >
          {employeeOptions.length === 0 ? (
            <p style={{ margin: 8, color: colors.textMuted, fontSize: 13 }}>
              No employees found.
            </p>
          ) : (
            employeeOptions.map((u) => {
              const email = String(u.email || "").toLowerCase();
              return (
                <label
                  key={email}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    padding: "6px 8px",
                    fontSize: 14,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={form.participantEmails.includes(email)}
                    onChange={() => toggleParticipant(email)}
                  />
                  <span>
                    {u.name || displayNameFromEmail(email)}
                    <span style={{ color: colors.textMuted, marginLeft: 6, fontSize: 12 }}>
                      {email}
                    </span>
                  </span>
                </label>
              );
            })
          )}
        </div>
        {formError ? <div style={{ ...alertError, marginBottom: 12 }}>{formError}</div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={() => setFormOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {editing ? "Save Changes" : "Create Meeting"}
          </Button>
        </div>
      </Modal>

      <Modal
        open={!!viewItem}
        onClose={() => setViewItem(null)}
        title={viewItem?.title || "Meeting"}
        maxWidth={640}
      >
        {viewItem ? (
          <>
            <p style={{ color: colors.textMuted, marginTop: 0 }}>
              {viewItem.description || "No description."}
            </p>
            <p>
              <strong>Date:</strong>{" "}
              {formatMeetingDate(viewItem.date || viewItem.startDateTime)}
            </p>
            <p>
              <strong>Time:</strong> {formatMeetingRange(viewItem)}
            </p>
            <p>
              <strong>Meeting Type:</strong> {meetingTypeLabel(viewItem.meetingType)}
            </p>
            <p>
              <strong>Meeting Link:</strong>{" "}
              {viewItem.meetingLink ? (
                <a href={viewItem.meetingLink} target="_blank" rel="noopener noreferrer">
                  Open Meeting
                </a>
              ) : (
                "—"
              )}
            </p>
            <p>
              <strong>Status:</strong>{" "}
              <span className={meetingStatusClass(viewItem.status)}>{viewItem.status}</span>
            </p>
            <h4 style={{ marginBottom: 8 }}>Participants</h4>
            <div className="dgv-table-wrap">
              <table className="dgv-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(viewItem.participants || []).map((p) => (
                    <tr key={p.employeeId}>
                      <td>{p.employeeName || displayNameFromEmail(p.employeeId)}</td>
                      <td>{p.displayStatus || p.attendanceStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {viewItem.status !== "CANCELLED" && viewItem.status !== "COMPLETED" ? (
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <Button variant="ghost" onClick={() => { setViewItem(null); openEdit(viewItem); }}>
                  Edit
                </Button>
                <Button variant="ghost" onClick={() => setCancelTarget(viewItem)}>
                  Cancel
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </Modal>

      <Modal
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        title="Cancel meeting"
      >
        <p>Are you sure you want to cancel this meeting?</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={() => setCancelTarget(null)}>
            Keep Meeting
          </Button>
          <Button onClick={confirmCancel}>Cancel Meeting</Button>
        </div>
      </Modal>
    </Layout>
  );
}

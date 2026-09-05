import { useEffect, useMemo, useState } from "react";
import Layout from "../../components/Layout";
import {
  fetchAnnouncements,
  fetchAnnouncementHistory,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  apiOptional,
} from "../../services/api";
import { getLoggedInDisplayName, getLoggedInEmail } from "../../services/auth";
import { displayNameFromEmail } from "../../utils/meetings";
import {
  colors,
  pageCard,
  pageTitle,
  formLabel,
  formInput,
  formSelect,
  buttonPrimary,
} from "../../theme";
import {
  formatTaskDateTime,
  joinDueParts,
  splitDueParts,
} from "../../utils/taskStatus";

const EMPTY_FORM = {
  title: "",
  message: "",
  noExpiry: false,
  expiryDate: "",
  expiryTime: "23:59",
};

function statusLabel(status) {
  if (status === "EXPIRED") return "Expired";
  if (status === "NO_EXPIRY") return "No Expiry";
  if (status === "INACTIVE") return "Inactive";
  return "Active";
}

function statusStyle(status) {
  if (status === "EXPIRED") {
    return { background: "rgba(239,68,68,0.14)", color: "#b91c1c" };
  }
  if (status === "NO_EXPIRY") {
    return { background: "rgba(37,99,235,0.12)", color: "var(--dgv-accent)" };
  }
  return { background: "rgba(22,163,74,0.14)", color: "#15803d" };
}

function summarize(text, max = 140) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "—";
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

function authorLabel(item) {
  const name = String(item?.createdByName || "").trim();
  if (name && !name.includes("@")) return name;
  return displayNameFromEmail(item?.createdBy) || item?.createdBy || "—";
}

function editorLabel(item) {
  const name = String(item?.updatedByName || "").trim();
  if (name && !name.includes("@")) return name;
  if (item?.updatedBy) {
    return displayNameFromEmail(item.updatedBy) || item.updatedBy;
  }
  return "";
}

export default function AdminAnnouncements() {
  const [active, setActive] = useState([]);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState("newest");
  const [authorName, setAuthorName] = useState(
    getLoggedInDisplayName() || displayNameFromEmail(getLoggedInEmail())
  );

  const load = () => {
    fetchAnnouncements()
      .then(setActive)
      .catch((err) => {
        console.error(err);
        setError(err.message || "Unable to load announcements.");
      });
    fetchAnnouncementHistory()
      .then(setHistory)
      .catch((err) => {
        console.error(err);
        setHistory([]);
      });
  };

  useEffect(() => {
    load();
    apiOptional("/admin/getUserProfile", "GET")
      .then((profile) => {
        const name = String(profile?.name || "").trim();
        if (name) setAuthorName(name);
      })
      .catch(() => {});
  }, []);

  const submit = async () => {
    const title = form.title.trim();
    const message = form.message.trim();
    if (!title) {
      setError("Title is required.");
      return;
    }
    if (!message) {
      setError("Message is required.");
      return;
    }
    if (!form.noExpiry && (!form.expiryDate || !form.expiryTime)) {
      setError("Select an expiry date and time, or choose No Expiry.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        title,
        message,
        noExpiry: !!form.noExpiry,
        expiresAt: form.noExpiry
          ? null
          : joinDueParts(form.expiryDate, form.expiryTime),
      };
      if (editingId) {
        await updateAnnouncement({ announceId: editingId, ...payload });
      } else {
        await createAnnouncement(payload);
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      load();
    } catch (err) {
      setError(err.message || "Unable to save announcement.");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (item) => {
    const parts = splitDueParts(item.expiresAt);
    setEditingId(item.announceId);
    setForm({
      title: item.title || "",
      message: item.message || "",
      noExpiry: !item.expiresAt,
      expiryDate: parts.date || "",
      expiryTime: parts.time || "23:59",
    });
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const remove = async (id) => {
    if (!window.confirm("Delete this announcement permanently?")) return;
    await deleteAnnouncement(id);
    if (editingId === id) {
      setForm(EMPTY_FORM);
      setEditingId(null);
    }
    load();
  };

  const filteredHistory = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = history.filter((item) => {
      if (statusFilter !== "ALL" && item.status !== statusFilter) return false;
      if (q) {
        const hay = `${item.title || ""} ${item.message || ""} ${item.createdBy || ""} ${item.createdByName || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const created = String(item.createdAt || "").slice(0, 10);
      if (dateFrom && created && created < dateFrom) return false;
      if (dateTo && created && created > dateTo) return false;
      return true;
    });
    rows = [...rows].sort((a, b) => {
      const left = String(a.createdAt || "");
      const right = String(b.createdAt || "");
      return sort === "oldest" ? left.localeCompare(right) : right.localeCompare(left);
    });
    return rows;
  }, [history, search, statusFilter, dateFrom, dateTo, sort]);

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>
          {editingId ? "Edit Announcement" : "Announcements"}
        </h2>
        {error ? (
          <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 12 }}>
            {error}
          </div>
        ) : null}
        <label style={formLabel}>Author</label>
        <input style={formInput} value={authorName} readOnly />
        <label style={formLabel}>Title</label>
        <input
          style={formInput}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
        <label style={formLabel}>Message</label>
        <textarea
          style={{ ...formInput, minHeight: 80 }}
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
        />
        <label style={{ ...formLabel, display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={form.noExpiry}
            onChange={(e) => setForm({ ...form, noExpiry: e.target.checked })}
          />
          No Expiry
        </label>
        {form.noExpiry ? null : (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 180px" }}>
              <label style={formLabel}>Expiry Date *</label>
              <input
                type="date"
                style={formInput}
                value={form.expiryDate}
                onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
              />
            </div>
            <div style={{ flex: "1 1 160px" }}>
              <label style={formLabel}>Expiry Time *</label>
              <input
                type="time"
                style={formInput}
                value={form.expiryTime}
                onChange={(e) => setForm({ ...form, expiryTime: e.target.value })}
              />
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            style={buttonPrimary}
            onClick={submit}
            disabled={saving}
          >
            {saving ? "Saving..." : editingId ? "Save changes" : "Publish"}
          </button>
          {editingId ? (
            <button
              type="button"
              style={{
                ...buttonPrimary,
                background: "transparent",
                color: colors.text,
                border: `1px solid ${colors.border}`,
                boxShadow: "none",
              }}
              onClick={() => {
                setEditingId(null);
                setForm(EMPTY_FORM);
                setError("");
              }}
            >
              Cancel edit
            </button>
          ) : null}
        </div>

        <h3 style={{ marginTop: 28 }}>Active announcements</h3>
        {active.length === 0 ? (
          <p style={{ color: colors.textMuted }}>No active announcements.</p>
        ) : (
          active.map((a) => (
            <div
              key={a.announceId}
              style={{
                background: colors.background,
                padding: 16,
                borderRadius: 8,
                marginBottom: 10,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong>{a.title}</strong>
                <StatusPill status={a.status} />
              </div>
              <p style={{ margin: "8px 0", color: colors.textMuted }}>{a.message}</p>
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                Author: {authorLabel(a)}
                <br />
                Expires: {a.expiresAt ? formatTaskDateTime(a.expiresAt) : "No Expiry"}
              </div>
              <div style={{ marginTop: 8, display: "flex", gap: 12 }}>
                <button
                  type="button"
                  style={{ fontSize: 12, color: "var(--dgv-accent)", border: "none", background: "none", cursor: "pointer" }}
                  onClick={() => startEdit(a)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  style={{ fontSize: 12, color: colors.error, border: "none", background: "none", cursor: "pointer" }}
                  onClick={() => remove(a.announceId)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div style={{ ...pageCard, marginTop: 16 }}>
        <h2 style={{ ...pageTitle, fontSize: 22 }}>Announcement History</h2>
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >
          <div style={{ flex: "2 1 220px" }}>
            <label style={formLabel}>Search</label>
            <input
              style={formInput}
              placeholder="Title, content, or author"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <label style={formLabel}>Status</label>
            <select
              style={formSelect}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="ALL">All</option>
              <option value="ACTIVE">Active</option>
              <option value="EXPIRED">Expired</option>
              <option value="NO_EXPIRY">No Expiry</option>
            </select>
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <label style={formLabel}>Created from</label>
            <input
              type="date"
              style={formInput}
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <label style={formLabel}>Created to</label>
            <input
              type="date"
              style={formInput}
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <label style={formLabel}>Sort</label>
            <select
              style={formSelect}
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </select>
          </div>
        </div>

        {filteredHistory.length === 0 ? (
          <p style={{ color: colors.textMuted }}>No announcements match these filters.</p>
        ) : (
          filteredHistory.map((a) => (
            <div
              key={a.announceId}
              style={{
                background: colors.background,
                padding: 16,
                borderRadius: 8,
                marginBottom: 10,
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
                <strong>{a.title}</strong>
                <StatusPill status={a.status} />
              </div>
              <p style={{ margin: "8px 0", color: colors.textMuted }}>
                {summarize(a.message)}
              </p>
              <div style={{ fontSize: 12, color: colors.textMuted, lineHeight: 1.6 }}>
                Author: {authorLabel(a)}
                <br />
                Created: {a.createdAt ? formatTaskDateTime(a.createdAt) : "—"}
                <br />
                Expiry: {a.expiresAt ? formatTaskDateTime(a.expiresAt) : "No Expiry"}
                {a.updatedAt ? (
                  <>
                    <br />
                    Last updated: {formatTaskDateTime(a.updatedAt)}
                    {editorLabel(a) ? ` by ${editorLabel(a)}` : ""}
                  </>
                ) : null}
              </div>
              <div style={{ marginTop: 8, display: "flex", gap: 12 }}>
                <button
                  type="button"
                  style={{ fontSize: 12, color: "var(--dgv-accent)", border: "none", background: "none", cursor: "pointer" }}
                  onClick={() => setDetail(a)}
                >
                  View details
                </button>
                <button
                  type="button"
                  style={{ fontSize: 12, color: "var(--dgv-accent)", border: "none", background: "none", cursor: "pointer" }}
                  onClick={() => startEdit(a)}
                >
                  Edit
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {detail ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2000,
            padding: 16,
          }}
          onClick={() => setDetail(null)}
        >
          <div
            style={{
              background: "var(--dgv-card)",
              color: colors.text,
              padding: 24,
              borderRadius: 12,
              width: "100%",
              maxWidth: 520,
              maxHeight: "90vh",
              overflowY: "auto",
              border: `1px solid ${colors.border}`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <h3 style={{ marginTop: 0 }}>{detail.title}</h3>
              <StatusPill status={detail.status} />
            </div>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{detail.message}</p>
            <div style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.7 }}>
              Author: {authorLabel(detail)}
              <br />
              Created: {detail.createdAt ? formatTaskDateTime(detail.createdAt) : "—"}
              <br />
              Expiry: {detail.expiresAt ? formatTaskDateTime(detail.expiresAt) : "No Expiry"}
              <br />
              Last updated:{" "}
              {detail.updatedAt ? formatTaskDateTime(detail.updatedAt) : "—"}
              {editorLabel(detail) ? ` by ${editorLabel(detail)}` : ""}
            </div>
            <button
              type="button"
              style={{ ...buttonPrimary, marginTop: 16 }}
              onClick={() => setDetail(null)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </Layout>
  );
}

function StatusPill({ status }) {
  const style = statusStyle(status);
  return (
    <span
      style={{
        ...style,
        fontSize: 11,
        fontWeight: 700,
        padding: "3px 8px",
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      {statusLabel(status)}
    </span>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import { fetchAdminActivity, fetchUsers } from "../../services/api";
import { colors, pageCard, pageTitle, pageSubtitle, formInput } from "../../theme";

function trackPath(email) {
  return `/admin/employees/${encodeURIComponent(email)}/track?tab=Activity&from=activity`;
}

export default function TeamActivity() {
  const navigate = useNavigate();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchAdminActivity(date).catch((err) => {
        console.error(err);
        return { users: [] };
      }),
      fetchUsers().catch((err) => {
        console.error(err);
        return [];
      }),
    ]).then(([activity, list]) => {
      if (cancelled) return;
      setData(activity || { users: [] });
      setUsers(Array.isArray(list) ? list : []);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [date]);

  const rows = useMemo(() => {
    const byEmail = new Map();
    (Array.isArray(users) ? users : []).forEach((u) => {
      const email = String(u.email || "").trim().toLowerCase();
      if (!email) return;
      byEmail.set(email, {
        email,
        name: u.name || "",
        lastSeen: null,
        eventCount: 0,
        logins: 0,
        locations: [],
        devices: [],
        active: false,
      });
    });
    (data?.users || []).forEach((u) => {
      const email = String(u.email || "").trim().toLowerCase();
      if (!email) return;
      const prev = byEmail.get(email) || {
        email,
        name: "",
        lastSeen: null,
        eventCount: 0,
        logins: 0,
        locations: [],
        devices: [],
        active: false,
      };
      byEmail.set(email, {
        ...prev,
        name: u.name || prev.name || "",
        lastSeen: u.lastSeen || prev.lastSeen,
        eventCount: u.eventCount || 0,
        logins: u.logins || 0,
        locations: u.locations || [],
        devices: u.devices || [],
        active: true,
      });
    });
    return Array.from(byEmail.values()).sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (a.name || a.email).localeCompare(b.name || b.email);
    });
  }, [users, data]);

  const q = search.trim().toLowerCase();
  const filtered = !q
    ? rows
    : rows.filter((u) =>
        [u.name, u.email].join(" ").toLowerCase().includes(q)
      );
  const activeCount = filtered.filter((u) => u.active).length;

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 1100 }}>
        <h2 style={pageTitle}>Team Activity</h2>
        <p style={pageSubtitle}>
          All employee profiles are listed. Open a person to see their activity.
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "flex-end",
            marginBottom: 8,
          }}
        >
          <div>
            <label style={{ fontWeight: 600, display: "block" }}>Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ ...formInput, maxWidth: 200, marginBottom: 0 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label style={{ fontWeight: 600, display: "block" }}>Search</label>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search employee name or email…"
              aria-label="Search employees"
              style={{ ...formInput, marginBottom: 0 }}
            />
          </div>
        </div>

        {loading ? (
          <p>Loading...</p>
        ) : (
          <>
            <h3>
              Users ({filtered.length})
              {q ? "" : ` · Active (${activeCount})`}
            </h3>
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 24 }}>
              <thead>
                <tr style={{ background: colors.primary, color: "#fff" }}>
                  <th style={{ padding: 10, textAlign: "left" }}>Name</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Last Seen</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Events</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Logins</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Location</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Device</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.email} style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <td style={{ padding: 10 }}>
                      <Link
                        to={trackPath(u.email)}
                        style={{
                          fontWeight: 600,
                          color: "var(--dgv-accent)",
                          textDecoration: "none",
                        }}
                      >
                        {u.name || "—"}
                      </Link>
                      <div style={{ fontSize: 12, color: colors.textMuted }}>{u.email}</div>
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      {u.lastSeen ? new Date(u.lastSeen).toLocaleString() : "—"}
                    </td>
                    <td style={{ padding: 10 }}>{u.eventCount || 0}</td>
                    <td style={{ padding: 10 }}>{u.logins || 0}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      {(u.locations || []).join(" · ") || (u.active ? "Unknown" : "—")}
                    </td>
                    <td style={{ padding: 10 }}>
                      {(u.devices || []).join(", ") || "—"}
                    </td>
                    <td style={{ padding: 10 }}>
                      <Button
                        type="button"
                        variant="secondary"
                        style={{ padding: "6px 12px", fontSize: 12 }}
                        onClick={() => navigate(trackPath(u.email))}
                      >
                        View activity
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filtered.length === 0 && (
              <p style={{ color: colors.textMuted }}>
                {q
                  ? "No employee matches that search."
                  : "No employees found."}
              </p>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}

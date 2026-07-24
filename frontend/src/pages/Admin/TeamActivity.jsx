import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { fetchAdminActivity } from "../../services/api";
import { colors, pageCard, pageTitle, formInput } from "../../theme";

export default function TeamActivity() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchAdminActivity(date)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [date]);

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Team Activity</h2>
        <label style={{ fontWeight: 600 }}>Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...formInput, maxWidth: 200 }} />

        {loading ? (
          <p>Loading...</p>
        ) : (
          <>
            <h3>Users Active ({(data?.users || []).length})</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 24 }}>
              <thead>
                <tr style={{ background: colors.primary, color: "#fff" }}>
                  <th style={{ padding: 10, textAlign: "left" }}>Name</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Last Seen</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Events</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Logins</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Location</th>
                  <th style={{ padding: 10, textAlign: "left" }}>Device</th>
                </tr>
              </thead>
              <tbody>
                {(data?.users || []).map((u) => (
                  <tr key={u.email} style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <td style={{ padding: 10 }}>
                      <div style={{ fontWeight: 600 }}>{u.name || "—"}</div>
                      <div style={{ fontSize: 12, color: colors.textMuted }}>{u.email}</div>
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>{new Date(u.lastSeen).toLocaleString()}</td>
                    <td style={{ padding: 10 }}>{u.eventCount}</td>
                    <td style={{ padding: 10 }}>{u.logins}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>{(u.locations || []).join(" · ") || "Unknown"}</td>
                    <td style={{ padding: 10 }}>{(u.devices || []).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {(data?.users || []).length === 0 && (
              <p style={{ color: colors.textMuted }}>No activity recorded for this date.</p>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}

import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { fetchDgvOsStatus } from "../../services/api";
import {
  colors,
  pageCard,
  pageSubtitle,
  pageTitle,
  alertError,
} from "../../theme";

const S2S_BASE =
  "https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod";

export default function DgvAiOs() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const data = await fetchDgvOsStatus();
        if (!cancelled) setStatus(data);
      } catch (err) {
        if (!cancelled) setError(err?.message || "Failed to load DGV AI OS status");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Layout>
      <div style={pageCard}>
        <h1 style={pageTitle}>DGV AI OS</h1>
        <p style={pageSubtitle}>
          Live MyDGV ↔ AI Business OS integration. Agents run in DGV OS; this
          portal exposes people/tasks over a server-to-server API.
        </p>

        {loading ? <p style={{ color: colors.textMuted }}>Loading…</p> : null}
        {error ? <div style={alertError}>{error}</div> : null}

        {status ? (
          <div style={{ display: "grid", gap: 16, marginTop: 8 }}>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: 600,
                  background: status.integrationConfigured
                    ? "var(--dgv-success-bg)"
                    : "var(--dgv-danger-bg, #fee2e2)",
                  color: status.integrationConfigured
                    ? colors.success
                    : colors.error,
                }}
              >
                {status.integrationConfigured
                  ? "S2S key configured"
                  : "S2S key missing"}
              </span>
              <span style={{ color: colors.textMuted, fontSize: 14 }}>
                AI-created tasks: {status.aiTaskCount ?? 0}
              </span>
            </div>

            <section>
              <h2 style={{ fontSize: 16, margin: "8px 0" }}>Server-to-server APIs</h2>
              <p style={{ color: colors.textMuted, fontSize: 13, marginTop: 0 }}>
                Header: <code>x-dgv-os-key: &lt;secret&gt;</code> — never paste the
                key into this browser app.
              </p>
              <pre
                style={{
                  background: "var(--dgv-bg)",
                  border: `1px solid ${colors.border}`,
                  borderRadius: 10,
                  padding: 14,
                  overflow: "auto",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >{`BASE=${S2S_BASE}

curl -H "x-dgv-os-key: $MYDGV_DGV_OS_API_KEY" \\
  $BASE/integrations/dgv-os/health

curl -H "x-dgv-os-key: $MYDGV_DGV_OS_API_KEY" \\
  $BASE/integrations/dgv-os/employees

curl -H "x-dgv-os-key: $MYDGV_DGV_OS_API_KEY" \\
  $BASE/integrations/dgv-os/capacity

curl -H "x-dgv-os-key: $MYDGV_DGV_OS_API_KEY" \\
  $BASE/integrations/dgv-os/tasks

# Create task (Idempotency-Key required)
curl -X POST -H "x-dgv-os-key: $MYDGV_DGV_OS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"title":"Follow up","projectId":"PROJECT_ID","assignee":"name@mydgv.com"}' \\
  $BASE/integrations/dgv-os/tasks`}</pre>
              <ul style={{ fontSize: 13, color: colors.textMuted, marginTop: 8 }}>
                {(status.endpoints || []).map((ep) => (
                  <li key={ep}>{ep}</li>
                ))}
              </ul>
            </section>

            <section>
              <h2 style={{ fontSize: 16, margin: "8px 0" }}>Recent AI OS tasks</h2>
              {(status.aiTasks || []).length === 0 ? (
                <p style={{ color: colors.textMuted, fontSize: 14 }}>
                  None yet. When DGV OS creates human tasks, they appear here and
                  under Admin → Tasks (label <code>ai-os</code>).
                </p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: 13,
                    }}
                  >
                    <thead>
                      <tr style={{ textAlign: "left", color: colors.textMuted }}>
                        <th style={{ padding: "8px 6px" }}>Title</th>
                        <th style={{ padding: "8px 6px" }}>Assignee</th>
                        <th style={{ padding: "8px 6px" }}>Status</th>
                        <th style={{ padding: "8px 6px" }}>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.aiTasks.map((t) => (
                        <tr
                          key={t.taskId || t.title}
                          style={{ borderTop: `1px solid ${colors.border}` }}
                        >
                          <td style={{ padding: "8px 6px" }}>{t.title}</td>
                          <td style={{ padding: "8px 6px" }}>
                            {t.assignee || "—"}
                          </td>
                          <td style={{ padding: "8px 6px" }}>{t.status || "—"}</td>
                          <td style={{ padding: "8px 6px" }}>
                            {(t.createdAt || "").slice(0, 10) || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {status.note ? (
              <p style={{ color: colors.textMuted, fontSize: 13 }}>{status.note}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Layout>
  );
}

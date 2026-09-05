import { useCallback, useEffect, useState } from "react";
import {
  fetchRedZoneWeekly,
  saveRedZoneWeekly,
  runRedZoneWeekly,
} from "../../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  formLabel,
  formInput,
  formSelect,
  buttonPrimary,
} from "../../theme";

const WEEKDAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

function formatWhen(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  return new Date(ms).toLocaleString();
}

export default function RedZoneWeeklySettings() {
  const [config, setConfig] = useState({
    enabled: false,
    weekday: 1,
    sendTime: "09:00",
    dgvEmail: "dgv@mydgv.com",
  });
  const [last, setLast] = useState(null);
  const [history, setHistory] = useState([]);
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const data = await fetchRedZoneWeekly();
    setConfig({
      enabled: !!data.config?.enabled,
      weekday: Number(data.config?.weekday ?? 1),
      sendTime: data.config?.sendTime || "09:00",
      dgvEmail: data.config?.dgvEmail || "dgv@mydgv.com",
    });
    setLast(data.last || null);
    setHistory(Array.isArray(data.history) ? data.history : []);
    setTimezone(data.timezone || "Asia/Kolkata");
  }, []);

  useEffect(() => {
    load()
      .catch((err) => setError(err.message || "Unable to load settings."))
      .finally(() => setLoading(false));
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await saveRedZoneWeekly({
        enabled: config.enabled,
        weekday: Number(config.weekday),
        sendTime: config.sendTime,
      });
      await load();
      setMessage("Weekly Red-Zone email settings saved.");
    } catch (err) {
      setError(err.message || "Unable to save settings.");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setError("");
    setMessage("");
    try {
      const result = await runRedZoneWeekly();
      await load();
      if (result.skipped) {
        setMessage(
          result.reason === "ALREADY_SENT"
            ? "This week's report was already sent. Failed emails can be retried if the last run was partial or failed."
            : `Report not sent (${result.reason || "skipped"}).`
        );
      } else {
        setMessage(
          `Report ${result.status}. Red-zone tickets: ${result.redCount ?? 0}. Emails sent: ${result.sent ?? 0}. Failed: ${result.failed ?? 0}.`
        );
      }
    } catch (err) {
      setError(err.message || "Unable to send the weekly report.");
    } finally {
      setRunning(false);
    }
  };

  const lastSuccess =
    history.find((row) =>
      ["SENT", "EMPTY"].includes(String(row.status || "").toUpperCase())
    ) || (["SENT", "EMPTY"].includes(String(last?.status || "").toUpperCase())
      ? last
      : null);
  const canRetry =
    last &&
    ["FAILED", "PARTIAL"].includes(String(last.status || "").toUpperCase());

  return (
    <div style={{ ...pageCard, marginTop: 16, maxWidth: 1200 }}>
      <h3 style={{ ...pageTitle, fontSize: 20, marginBottom: 6 }}>
        Weekly Red-Zone Email
      </h3>
      <p style={{ color: colors.textMuted, marginTop: 0, marginBottom: 16 }}>
        Every week the portal emails a Red-Zone ticket summary to each assignee,
        their Team Lead, and {config.dgvEmail}. Multiple tickets for the same
        person are combined into one email. Time zone: {timezone}.
      </p>

      {loading ? (
        <p style={{ color: colors.textMuted }}>Loading settings...</p>
      ) : (
        <>
          {error ? (
            <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 12 }}>
              {error}
            </div>
          ) : null}
          {message ? (
            <div style={{ marginBottom: 12, color: colors.text, fontSize: 14 }}>
              {message}
            </div>
          ) : null}

          <label style={{ ...formLabel, display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={!!config.enabled}
              onChange={(e) =>
                setConfig({ ...config, enabled: e.target.checked })
              }
            />
            Enable weekly Red-Zone emails
          </label>

          <label style={formLabel}>DGV email</label>
          <input style={formInput} value={config.dgvEmail} readOnly />

          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "flex-end",
            }}
          >
            <div style={{ minWidth: 180, flex: "1 1 180px" }}>
              <label style={formLabel}>Weekly sending day</label>
              <select
                style={formSelect}
                value={config.weekday}
                onChange={(e) =>
                  setConfig({ ...config, weekday: Number(e.target.value) })
                }
              >
                {WEEKDAYS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ minWidth: 160, flex: "1 1 160px" }}>
              <label style={formLabel}>Sending time</label>
              <input
                type="time"
                style={formInput}
                value={config.sendTime}
                onChange={(e) =>
                  setConfig({ ...config, sendTime: e.target.value })
                }
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
            <button
              type="button"
              style={buttonPrimary}
              onClick={save}
              disabled={saving || running}
            >
              {saving ? "Saving..." : "Save settings"}
            </button>
            <button
              type="button"
              style={{
                ...buttonPrimary,
                background: "transparent",
                color: colors.text,
                border: `1px solid ${colors.border}`,
                boxShadow: "none",
              }}
              onClick={runNow}
              disabled={saving || running}
            >
              {running
                ? "Sending..."
                : canRetry
                ? "Retry failed emails"
                : "Send report now"}
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: 12,
              }}
            >
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                Last successful report
              </div>
              <div style={{ fontWeight: 700, marginTop: 4 }}>
                {formatWhen(lastSuccess?.sentAt)}
              </div>
            </div>
            <div
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: 12,
              }}
            >
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                Tickets in last report
              </div>
              <div style={{ fontWeight: 700, marginTop: 4 }}>
                {lastSuccess?.redCount ?? last?.redCount ?? "—"}
              </div>
            </div>
            <div
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: 12,
              }}
            >
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                Last status
              </div>
              <div style={{ fontWeight: 700, marginTop: 4 }}>
                {last?.status || "—"}
              </div>
            </div>
          </div>

          <h4 style={{ margin: "8px 0 10px" }}>Email / report history</h4>
          {history.length === 0 ? (
            <p style={{ color: colors.textMuted }}>No weekly reports yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    {["Week", "Status", "Tickets", "Recipients", "Sent", "Failed"].map(
                      (h) => (
                        <th
                          key={h}
                          style={{
                            textAlign: "left",
                            padding: "8px 6px",
                            borderBottom: `1px solid ${colors.border}`,
                          }}
                        >
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => {
                    const failed = (row.results || []).filter(
                      (r) => String(r.status).toUpperCase() === "FAILED"
                    ).length;
                    return (
                      <tr key={row.weekId || row.SK}>
                        <td style={{ padding: "8px 6px" }}>{row.weekId}</td>
                        <td style={{ padding: "8px 6px" }}>{row.status}</td>
                        <td style={{ padding: "8px 6px" }}>{row.redCount ?? 0}</td>
                        <td style={{ padding: "8px 6px" }}>
                          {(row.recipients || []).length}
                        </td>
                        <td style={{ padding: "8px 6px" }}>
                          {formatWhen(row.sentAt)}
                        </td>
                        <td style={{ padding: "8px 6px" }}>{failed}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

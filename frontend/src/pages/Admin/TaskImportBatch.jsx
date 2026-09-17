import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Layout from "../../components/Layout";
import {
  fetchTaskImport,
  getTaskImportDownloadUrl,
} from "../../services/api";
import { colors, pageCard, pageSubtitle, pageTitle } from "../../theme";

const thStyle = {
  textAlign: "left",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--dgv-text-muted)",
  padding: "10px 12px",
  borderBottom: "1px solid var(--dgv-border)",
};

const tdStyle = {
  fontSize: 14,
  color: "var(--dgv-text)",
  padding: "12px",
  borderBottom: "1px solid var(--dgv-border)",
  verticalAlign: "middle",
};

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusBadgeClass(status) {
  const value = String(status || "").toUpperCase();
  if (value === "COMPLETED" || value === "VALID" || value === "SUCCESS" || value === "ELIGIBLE") {
    return "dgv-badge dgv-badge--success";
  }
  if (value === "PARTIAL" || value === "NEEDS_FIX" || value === "WARNING" || value === "WAITING_DISTRIBUTION") {
    return "dgv-badge dgv-badge--warning";
  }
  if (value === "FAILED" || value === "INVALID") return "dgv-badge dgv-badge--danger";
  if (value === "PROCESSING" || value === "VALIDATING") return "dgv-badge dgv-badge--info";
  return "dgv-badge dgv-badge--neutral";
}

function statusLabel(status) {
  const value = String(status || "").trim();
  if (!value) return "—";
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatEmails(emails) {
  return (emails || []).map((email) => String(email || "").trim()).filter(Boolean);
}

export function formatAssignmentDisplay(row) {
  const assignment = row?.assignment || {};
  const mode = String(row?.assignmentMode || "").toUpperCase();
  const state = String(assignment.state || "").toUpperCase();
  const scheduled = Boolean(assignment.scheduled) || mode === "SCHEDULED";
  const emails = formatEmails(assignment.emails);
  if (scheduled && (state === "PENDING" || state === "ASSIGNING")) {
    return emails.length
      ? `Scheduled / Pending (${emails.join(", ")})`
      : "Scheduled / Pending";
  }
  if (emails.length) return emails.join(", ");
  return "—";
}

function formatErrorLine(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  const field = item.column || item.field || item.cell || "";
  const message = item.message || "";
  if (field && message) return `${field}: ${message}`;
  return message || field;
}

export function formatRowErrors(row) {
  const lines = [];
  const seen = new Set();
  const push = (value) => {
    const text = formatErrorLine(value).trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    lines.push(text);
  };
  (row?.errors || []).forEach(push);
  (row?.cellErrors || []).forEach(push);
  (row?.warnings || []).forEach((warning) => {
    const text = formatErrorLine(warning).trim();
    if (text) push(`Warning: ${text}`);
  });
  return lines;
}

function SummaryItem({ label, value, title }) {
  return (
    <div className="dgv-import-summary__item">
      <div className="dgv-import-summary__label">{label}</div>
      <div
        className="dgv-import-summary__value"
        title={
          title ||
          (typeof value === "string" || typeof value === "number" ? String(value) : "")
        }
      >
        {value == null || value === "" ? "—" : value}
      </div>
    </div>
  );
}

function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener noreferrer";
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function TaskImportBatch() {
  const { batchId } = useParams();
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setDownloadError("");
    try {
      const data = await fetchTaskImport(batchId);
      setSummary(data?.summary || null);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (err) {
      setSummary(null);
      setRows([]);
      setError(err?.message || "Unable to load import batch.");
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const fileAvailable = Boolean(summary?.fileAvailable);
  const auditEligibility = String(summary?.auditEligibility || "").toUpperCase();
  const waitingDistribution = auditEligibility === "WAITING_DISTRIBUTION";
  const missingFileMessage = waitingDistribution
    ? "The original Excel file will be available for download after every task is fully distributed."
    : "Original Excel file is no longer available.";

  const onDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const data = await getTaskImportDownloadUrl(batchId);
      if (!data?.downloadUrl) {
        setDownloadError(missingFileMessage);
        return;
      }
      triggerDownload(data.downloadUrl);
    } catch (err) {
      const message = err?.message || missingFileMessage;
      setDownloadError(
        /not available|not found|404/i.test(message) ? missingFileMessage : message
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 1100 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={pageTitle}>Excel Import</h1>
            <p style={{ ...pageSubtitle, marginBottom: 16 }}>
              Review the original file and row results for this import.
            </p>
          </div>
          <button
            type="button"
            className="dgv-btn dgv-btn--outline"
            onClick={() => navigate("/admin/task-imports")}
          >
            Excel Import History
          </button>
        </div>

        {error ? (
          <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        ) : null}

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading import...</p>
        ) : !summary ? null : (
          <>
            <div className="dgv-import-summary">
              <SummaryItem label="File" value={summary.fileName} />
              <SummaryItem label="Batch ID" value={summary.batchId} />
              <SummaryItem
                label="Uploaded By"
                value={summary.uploadedByName || summary.uploadedBy}
              />
              <SummaryItem
                label="Uploaded At"
                value={formatDateTime(summary.uploadedAt)}
                title={summary.uploadedAt}
              />
              <SummaryItem
                label="Status"
                value={
                  <span className={statusBadgeClass(summary.status)}>
                    {statusLabel(summary.status)}
                  </span>
                }
              />
              <SummaryItem label="Rows" value={Number(summary.totalRows || 0)} />
              <SummaryItem
                label="Successful"
                value={Number(summary.successCount || 0)}
              />
              <SummaryItem label="Failed" value={Number(summary.failureCount || 0)} />
              <SummaryItem
                label="Confirmed"
                value={formatDateTime(summary.confirmedAt)}
                title={summary.confirmedAt}
              />
              <SummaryItem
                label="Completed"
                value={formatDateTime(summary.completedAt)}
                title={summary.completedAt}
              />
              <SummaryItem
                label="Audit"
                value={
                  <span className={statusBadgeClass(summary.auditEligibility)}>
                    {statusLabel(summary.auditEligibility || "INELIGIBLE")}
                  </span>
                }
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              {fileAvailable ? (
                <button
                  type="button"
                  className="dgv-btn dgv-btn--primary"
                  onClick={onDownload}
                  disabled={downloading}
                >
                  {downloading ? "Downloading..." : "Download Original Excel"}
                </button>
              ) : (
                <p style={{ color: colors.textMuted, margin: 0 }}>
                  {missingFileMessage}
                </p>
              )}
              {downloadError ? (
                <p style={{ color: colors.error, margin: "8px 0 0", fontSize: 14 }}>
                  {downloadError}
                </p>
              ) : null}
            </div>

            {rows.length === 0 ? (
              <p style={{ color: colors.textMuted }}>No import rows found.</p>
            ) : (
              <div className="dgv-imports-table-wrap">
                <table className="dgv-table dgv-import-rows-table">
                  <thead>
                    <tr>
                      <th className="dgv-import-rows-table__row" style={thStyle}>
                        Row
                      </th>
                      <th className="dgv-import-rows-table__task" style={thStyle}>
                        Task
                      </th>
                      <th className="dgv-import-rows-table__project" style={thStyle}>
                        Project
                      </th>
                      <th className="dgv-import-rows-table__assignment" style={thStyle}>
                        Assignment
                      </th>
                      <th className="dgv-import-rows-table__mode" style={thStyle}>
                        Mode
                      </th>
                      <th className="dgv-import-rows-table__status" style={thStyle}>
                        Status
                      </th>
                      <th className="dgv-import-rows-table__error" style={thStyle}>
                        Error
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const title = row.taskTitle || "—";
                      const errors = formatRowErrors(row);
                      return (
                        <tr key={row.rowNumber}>
                          <td className="dgv-import-rows-table__row" style={tdStyle}>
                            {row.rowNumber}
                          </td>
                          <td
                            className="dgv-import-rows-table__task"
                            style={tdStyle}
                            title={title}
                          >
                            {row.taskId ? (
                              <Link to={`/admin/tasks/${encodeURIComponent(row.taskId)}`}>
                                {title}
                              </Link>
                            ) : (
                              title
                            )}
                          </td>
                          <td
                            className="dgv-import-rows-table__project"
                            style={tdStyle}
                            title={row.projectName || ""}
                          >
                            {row.projectName || "—"}
                          </td>
                          <td
                            className="dgv-import-rows-table__assignment"
                            style={tdStyle}
                          >
                            {formatAssignmentDisplay(row)}
                          </td>
                          <td className="dgv-import-rows-table__mode" style={tdStyle}>
                            {statusLabel(row.assignmentMode)}
                          </td>
                          <td className="dgv-import-rows-table__status" style={tdStyle}>
                            <span className={statusBadgeClass(row.status)}>
                              {statusLabel(row.status)}
                            </span>
                          </td>
                          <td className="dgv-import-rows-table__error" style={tdStyle}>
                            {errors.length ? errors.join(" · ") : "—"}
                          </td>
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
    </Layout>
  );
}

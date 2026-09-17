import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import { fetchTaskImports } from "../../services/api";
import { colors, pageCard, pageSubtitle, pageTitle } from "../../theme";

const PAGE_SIZE = 20;

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
  if (value === "COMPLETED") return "dgv-badge dgv-badge--success";
  if (value === "PARTIAL" || value === "NEEDS_FIX") return "dgv-badge dgv-badge--warning";
  if (value === "FAILED") return "dgv-badge dgv-badge--danger";
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

export default function TaskImportHistory() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [nextToken, setNextToken] = useState(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pageTokensRef = useRef([null]);

  const load = useCallback(async (token) => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchTaskImports({
        limit: PAGE_SIZE,
        nextToken: token || undefined,
      });
      setItems(
        (Array.isArray(data?.items) ? data.items : []).filter(
          (item) => String(item?.status || "").toUpperCase() === "COMPLETED"
        )
      );
      setTotalCount(Number(data?.totalCount || 0));
      setNextToken(data?.nextToken || null);
    } catch (err) {
      setItems([]);
      setTotalCount(0);
      setNextToken(null);
      setError(err?.message || "Unable to load import history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(pageTokensRef.current[pageIndex] || null).catch(console.error);
  }, [load, pageIndex]);

  const goNext = () => {
    if (!nextToken || loading) return;
    const next = pageTokensRef.current.slice(0, pageIndex + 1);
    next.push(nextToken);
    pageTokensRef.current = next;
    setPageIndex((index) => index + 1);
  };

  const goPrevious = () => {
    if (pageIndex <= 0 || loading) return;
    setPageIndex((index) => index - 1);
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
            <h1 style={pageTitle}>Excel Import History</h1>
            <p style={{ ...pageSubtitle, marginBottom: 8 }}>
              Review previous Excel task imports and their results.
            </p>
            <p style={{ color: colors.textMuted, fontSize: 14, margin: "0 0 16px" }}>
              Total Imports: {totalCount}
            </p>
          </div>
          <button
            type="button"
            className="dgv-btn dgv-btn--outline"
            onClick={() => navigate("/admin/tasks")}
          >
            Back to Tasks
          </button>
        </div>

        {error ? (
          <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        ) : null}

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading import history...</p>
        ) : items.length === 0 && !error ? (
          <p style={{ color: colors.textMuted }}>No completed Excel imports yet.</p>
        ) : items.length === 0 ? null : (
          <>
            <div className="dgv-imports-table-wrap">
              <table className="dgv-table dgv-imports-table">
                <thead>
                  <tr>
                    <th className="dgv-imports-table__batch" style={thStyle}>
                      Batch ID
                    </th>
                    <th className="dgv-imports-table__file" style={thStyle}>
                      File
                    </th>
                    <th className="dgv-imports-table__by" style={thStyle}>
                      Uploaded By
                    </th>
                    <th className="dgv-imports-table__when" style={thStyle}>
                      Uploaded At
                    </th>
                    <th className="dgv-imports-table__compact" style={thStyle}>
                      Rows
                    </th>
                    <th className="dgv-imports-table__compact" style={thStyle}>
                      Success
                    </th>
                    <th className="dgv-imports-table__compact" style={thStyle}>
                      Failed
                    </th>
                    <th className="dgv-imports-table__status" style={thStyle}>
                      Status
                    </th>
                    <th className="dgv-imports-table__action" style={thStyle}>
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const batchId = item.batchId || "";
                    const fileName = item.fileName || "—";
                    const uploadedBy =
                      item.uploadedByName || item.uploadedBy || "—";
                    return (
                      <tr key={batchId}>
                        <td
                          className="dgv-imports-table__batch dgv-imports-table__clip"
                          style={tdStyle}
                          title={batchId}
                        >
                          {batchId || "—"}
                        </td>
                        <td
                          className="dgv-imports-table__file dgv-imports-table__clip"
                          style={tdStyle}
                          title={fileName}
                        >
                          {fileName}
                        </td>
                        <td
                          className="dgv-imports-table__by dgv-imports-table__clip"
                          style={tdStyle}
                          title={uploadedBy}
                        >
                          {uploadedBy}
                        </td>
                        <td
                          className="dgv-imports-table__when"
                          style={tdStyle}
                          title={item.uploadedAt || ""}
                        >
                          {formatDateTime(item.uploadedAt)}
                        </td>
                        <td className="dgv-imports-table__compact" style={tdStyle}>
                          {Number(item.totalRows || 0)}
                        </td>
                        <td className="dgv-imports-table__compact" style={tdStyle}>
                          {Number(item.successCount || 0)}
                        </td>
                        <td className="dgv-imports-table__compact" style={tdStyle}>
                          {Number(item.failureCount || 0)}
                        </td>
                        <td className="dgv-imports-table__status" style={tdStyle}>
                          <span className={statusBadgeClass(item.status)}>
                            {statusLabel(item.status)}
                          </span>
                        </td>
                        <td className="dgv-imports-table__action" style={tdStyle}>
                          <button
                            type="button"
                            className="dgv-btn dgv-btn--outline"
                            onClick={() =>
                              navigate(
                                `/admin/task-imports/${encodeURIComponent(batchId)}`
                              )
                            }
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pageIndex > 0 || nextToken ? (
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                {pageIndex > 0 ? (
                  <button
                    type="button"
                    className="dgv-btn dgv-btn--outline"
                    onClick={goPrevious}
                    disabled={loading}
                  >
                    Previous
                  </button>
                ) : null}
                {nextToken ? (
                  <button
                    type="button"
                    className="dgv-btn dgv-btn--outline"
                    onClick={goNext}
                    disabled={loading}
                  >
                    Next
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Layout>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import { fetchProjectCosting } from "../../services/api";
import { colors, pageCard, pageSubtitle, pageTitle } from "../../theme";
import {
  confirmedCostHeadline,
  costStatusLabel,
  costingBasisNote,
  formatReportDate,
  hoursLabel,
  INCOMPLETE_COSTING_TOTALS,
  INCOMPLETE_REPORT_DETAIL,
  INCOMPLETE_REPORT_TITLE,
  isCostingTruncated,
  mergeCostingPages,
  moneyUsd,
  PARTIAL_COLLECTED_AMOUNT_LABEL,
  rateSourceLabel,
  withPersistedTruncation,
} from "../../utils/costingReports";
import { projectTypeLabel } from "../../utils/workProjectManage";

const TASK_PAGE_SIZE = 10;

function formatTaskDate(value) {
  if (!value) return "—";
  const raw = String(value).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const date = new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3])
    );
    return date.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }
  return formatReportDate(value);
}

function taskPageNumbers(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set([1, total, current - 1, current, current + 1]);
  return [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
}

function Summary({ summary, truncated }) {
  const items = [
    { label: "Tasks", value: summary?.taskCount ?? 0 },
    { label: "Completed tasks", value: summary?.completedTaskCount ?? 0 },
    {
      label: "Completed actual hours",
      value: hoursLabel(summary?.completedActualHours),
    },
    {
      label: "Confirmed cost",
      value: confirmedCostHeadline(truncated, summary?.confirmedCostUsd),
    },
    {
      label: "Pending review hours",
      value: hoursLabel(summary?.pendingReviewHours),
    },
    { label: "Missing rate", value: summary?.missingRateCount ?? 0 },
    {
      label: "Missing cost records",
      value: summary?.missingCostRecordCount ?? 0,
    },
    {
      label: "Unpriced legacy",
      value: summary?.unpricedLegacyCount ?? 0,
    },
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 12,
        marginBottom: 20,
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            padding: 12,
            borderRadius: 10,
            border: `1px solid ${colors.border}`,
            background: colors.background,
          }}
        >
          <div style={{ fontSize: 12, color: colors.textMuted }}>{item.label}</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ProjectCosting() {
  const { projectId } = useParams();
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [taskPage, setTaskPage] = useState(1);

  const load = useCallback(
    async (cursor) => {
      if (!projectId) return;
      const pageCursor = typeof cursor === "string" && cursor ? cursor : undefined;
      if (pageCursor) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const result = await fetchProjectCosting(projectId, {
          limit: 80,
          cursor: pageCursor,
        });
        setData((prev) =>
          withPersistedTruncation(prev, result, { paged: Boolean(pageCursor) })
        );
        setRows((prev) =>
          mergeCostingPages(prev, result.assignments || [], {
            reset: !pageCursor,
          })
        );
        setTaskPage(1);
      } catch (err) {
        setError(err.message || "Unable to load project costing.");
        if (!pageCursor) {
          setData(null);
          setRows([]);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const project = data?.project;
  const truncated = isCostingTruncated(data);
  const taskPageCount = Math.max(1, Math.ceil(rows.length / TASK_PAGE_SIZE));
  const currentTaskPage = Math.min(Math.max(taskPage, 1), taskPageCount);
  const visibleRows = rows.slice(
    (currentTaskPage - 1) * TASK_PAGE_SIZE,
    currentTaskPage * TASK_PAGE_SIZE
  );
  const taskPageList = taskPageNumbers(currentTaskPage, taskPageCount);

  return (
    <Layout>
      <div style={pageCard}>
        <p style={{ marginTop: 0 }}>
          <Link to="/admin/projects">← Projects</Link>
        </p>
        <h2 style={pageTitle}>{project?.name || "Project costing"}</h2>
        <p style={pageSubtitle}>
          Confirmed cost uses frozen snapshots only. Pending review and missing
          records are listed separately and are not priced from today's rates.
          If an assignment is completed while you page through this list, use
          Refresh to reload totals and rows.
        </p>
        {project ? (
          <p style={{ color: colors.textMuted, marginTop: 0 }}>
            Code {project.projectCode || "—"} ·{" "}
            {projectTypeLabel(project.projectType)}
          </p>
        ) : null}
        {error ? (
          <p style={{ color: colors.error }}>{error}</p>
        ) : loading ? (
          <p style={{ color: colors.textMuted }}>Loading costing…</p>
        ) : (
          <>
            {truncated ? (
              <div
                role="alert"
                style={{
                  color: colors.error,
                  border: `1px solid ${colors.error}`,
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 16,
                  background: colors.background,
                }}
              >
                <strong>{INCOMPLETE_REPORT_TITLE}</strong>
                <p style={{ margin: "8px 0 0" }}>{INCOMPLETE_REPORT_DETAIL}</p>
                <p style={{ margin: "8px 0 0" }}>
                  This project has more tasks than the report window.{" "}
                  {INCOMPLETE_COSTING_TOTALS}
                </p>
              </div>
            ) : null}
            <Summary summary={data?.summary} truncated={truncated} />
            {truncated ? (
              <p style={{ color: colors.textMuted, fontSize: 13, marginTop: 0 }}>
                {PARTIAL_COLLECTED_AMOUNT_LABEL}:{" "}
                {moneyUsd(data?.summary?.confirmedCostUsd)}
              </p>
            ) : null}
            <div className="dgv-costing-tasks">
              <div className="dgv-costing-tasks__scroll">
              <table className="dgv-costing-tasks__grid">
                <thead>
                  <tr>
                    <th className="dgv-costing-tasks__wrap">Task</th>
                    <th>Employee</th>
                    <th>Status</th>
                    <th className="dgv-costing-tasks__num">Est.</th>
                    <th className="dgv-costing-tasks__num">Planned</th>
                    <th className="dgv-costing-tasks__num">Actual</th>
                    <th>Assigned</th>
                    <th>Submitted</th>
                    <th>Completed</th>
                    <th className="dgv-costing-tasks__wrap">Rate</th>
                    <th className="dgv-costing-tasks__num">Cost</th>
                    <th>Cost status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={`${row.taskId}:${row.email}`}>
                      <td className="dgv-costing-tasks__wrap">
                        <Link to={`/admin/tasks/${row.taskId}`}>
                          {row.title || row.taskId}
                        </Link>
                      </td>
                      <td>
                        {row.employeeName || row.email}
                        <div className="dgv-costing-tasks__meta">{row.email}</div>
                      </td>
                      <td>{row.assignmentStatus}</td>
                      <td className="dgv-costing-tasks__num">
                        {hoursLabel(row.estimatedHours)}
                      </td>
                      <td className="dgv-costing-tasks__num">
                        {hoursLabel(row.plannedHours)}
                      </td>
                      <td className="dgv-costing-tasks__num">
                        {hoursLabel(row.actualHours)}
                      </td>
                      <td>{formatTaskDate(row.assignedAt)}</td>
                      <td>{formatTaskDate(row.submittedAt)}</td>
                      <td>
                        {formatTaskDate(row.completedDate || row.completedAt)}
                      </td>
                      <td className="dgv-costing-tasks__wrap">
                        {moneyUsd(row.hourlyRateUsd)}
                        <div className="dgv-costing-tasks__meta">
                          {rateSourceLabel(row.rateSource)}
                          {row.rateVersionId ? ` · ${row.rateVersionId}` : ""}
                        </div>
                      </td>
                      <td className="dgv-costing-tasks__num">
                        {moneyUsd(row.amountUsd)}
                      </td>
                      <td>
                        <div>{costStatusLabel(row.costStatus)}</div>
                        {costingBasisNote(row) ? (
                          <div className="dgv-costing-tasks__meta">
                            {costingBasisNote(row)}
                          </div>
                        ) : null}
                        {row.reason ? (
                          <div className="dgv-costing-tasks__meta">{row.reason}</div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
            <nav
              aria-label="Task pagination"
              style={{
                display: "flex",
                gap: 8,
                marginTop: 16,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <span>
                {rows.length} {rows.length === 1 ? "task" : "tasks"}
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={currentTaskPage <= 1}
                onClick={() => setTaskPage(currentTaskPage - 1)}
              >
                Previous
              </Button>
              {taskPageList.map((pageNumber, index) => {
                const previous = taskPageList[index - 1];
                const gap = previous != null && pageNumber - previous > 1;
                return (
                  <span key={pageNumber} style={{ display: "inline-flex", gap: 8 }}>
                    {gap ? <span aria-hidden="true">…</span> : null}
                    <Button
                      type="button"
                      variant={pageNumber === currentTaskPage ? "primary" : "outline"}
                      aria-label={`Page ${pageNumber}`}
                      aria-current={pageNumber === currentTaskPage ? "page" : undefined}
                      onClick={() => setTaskPage(pageNumber)}
                    >
                      {pageNumber}
                    </Button>
                  </span>
                );
              })}
              <Button
                type="button"
                variant="outline"
                disabled={currentTaskPage >= taskPageCount}
                onClick={() => setTaskPage(currentTaskPage + 1)}
              >
                Next
              </Button>
            </nav>
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <Button
                type="button"
                variant="outline"
                disabled={loading && !data}
                onClick={() => load()}
              >
                Refresh
              </Button>
              {data?.nextCursor ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={loadingMore}
                  onClick={() => load(data.nextCursor)}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

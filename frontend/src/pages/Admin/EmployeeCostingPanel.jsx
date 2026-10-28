import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../../components/ui/Button";
import { fetchEmployeeCosting } from "../../services/api";
import { colors, formInput, formLabel } from "../../theme";
import {
  addDaysToKey,
  companyDateKey,
  confirmedCostHeadline,
  costStatusLabel,
  costingBasisNote,
  defaultCostingRange,
  formatReportDate,
  hoursLabel,
  INCOMPLETE_COSTING_TOTALS,
  INCOMPLETE_REPORT_DETAIL,
  INCOMPLETE_REPORT_TITLE,
  INCOMPLETE_TOTAL_DISPLAY,
  isCostingTruncated,
  mergeCostingPages,
  moneyUsd,
  PARTIAL_COLLECTED_AMOUNT_LABEL,
  rateSourceLabel,
  withPersistedTruncation,
} from "../../utils/costingReports";

const PRESETS = [
  { id: "30", label: "Last 30 days" },
  { id: "90", label: "Last 90 days" },
  { id: "month", label: "This month" },
  { id: "custom", label: "Custom" },
];

function monthStartKey(todayKey) {
  return `${String(todayKey).slice(0, 7)}-01`;
}

function rangeForPreset(preset) {
  const to = companyDateKey();
  if (preset === "90") return { from: addDaysToKey(to, -89), to };
  if (preset === "month") return { from: monthStartKey(to), to };
  if (preset === "30") return defaultCostingRange();
  return defaultCostingRange();
}

export default function EmployeeCostingPanel({ email }) {
  const initial = defaultCostingRange();
  const [preset, setPreset] = useState("30");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const applyPreset = (next) => {
    setPreset(next);
    if (next === "custom") return;
    const range = rangeForPreset(next);
    setFrom(range.from);
    setTo(range.to);
  };

  const load = useCallback(
    async (cursor) => {
      if (!email) return;
      const pageCursor = typeof cursor === "string" && cursor ? cursor : undefined;
      if (pageCursor) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const result = await fetchEmployeeCosting(email, {
          from,
          to,
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
      } catch (err) {
        setError(err.message || "Unable to load employee costing.");
        if (!pageCursor) {
          setData(null);
          setRows([]);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [email, from, to]
  );

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const summary = data?.summary;
  const truncated = isCostingTruncated(data);

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Costing</h3>
      <p style={{ color: colors.textMuted, marginTop: 0 }}>
        Confirmed cost is based on the Admin completion date in Asia/Kolkata.
        Pending review hours stay separate and are never priced from a later rate.
        This list only includes assignments that have an employee index pointer
        or a saved cost snapshot; an empty range is not proof that earlier work
        never existed. If an assignment is completed while you page through this
        list, use Refresh to reload totals and rows.
      </p>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
          alignItems: "end",
        }}
      >
        <label>
          <div style={formLabel}>Range</div>
          <select
            className="dgv-input"
            style={formInput}
            value={preset}
            onChange={(event) => applyPreset(event.target.value)}
          >
            {PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <div style={formLabel}>From</div>
          <input
            type="date"
            className="dgv-input"
            style={formInput}
            value={from}
            onChange={(event) => {
              setPreset("custom");
              setFrom(event.target.value);
            }}
          />
        </label>
        <label>
          <div style={formLabel}>To</div>
          <input
            type="date"
            className="dgv-input"
            style={formInput}
            value={to}
            onChange={(event) => {
              setPreset("custom");
              setTo(event.target.value);
            }}
          />
        </label>
      </div>
      {error ? <p style={{ color: colors.error }}>{error}</p> : null}
      {loading ? (
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
                This employee has more assignments than the report window.{" "}
                {INCOMPLETE_COSTING_TOTALS}
              </p>
            </div>
          ) : null}
          <p>
            Completed hours {hoursLabel(summary?.completedActualHours)} · Confirmed
            cost {confirmedCostHeadline(truncated, summary?.confirmedCostUsd)} ·
            Pending review {hoursLabel(summary?.pendingReviewHours)} · Missing
            rate {summary?.missingRateCount ?? 0} · Missing cost records{" "}
            {summary?.missingCostRecordCount ?? 0}
          </p>
          {truncated ? (
            <p style={{ color: colors.textMuted, fontSize: 13, marginTop: 0 }}>
              {PARTIAL_COLLECTED_AMOUNT_LABEL}:{" "}
              {moneyUsd(summary?.confirmedCostUsd)}
            </p>
          ) : null}
          {(data?.projects || []).length ? (
            <div style={{ overflowX: "auto", marginBottom: 16 }}>
              <table className="dgv-projects-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Hours</th>
                    <th>Confirmed cost</th>
                    <th>Missing</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((project) => (
                    <tr key={project.projectId || project.name}>
                      <td>
                        {project.projectId ? (
                          <Link
                            to={`/admin/projects/${encodeURIComponent(
                              project.projectId
                            )}/costing`}
                          >
                            {project.name || project.projectId}
                          </Link>
                        ) : (
                          project.name || "—"
                        )}
                      </td>
                      <td>{hoursLabel(project.completedActualHours)}</td>
                      <td>
                        {truncated
                          ? INCOMPLETE_TOTAL_DISPLAY
                          : moneyUsd(project.confirmedCostUsd)}
                      </td>
                      <td>
                        {project.missingRateCount} rate /{" "}
                        {project.missingCostRecordCount} records
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div style={{ overflowX: "auto" }}>
            <table className="dgv-projects-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Project</th>
                  <th>Actual</th>
                  <th>Assigned</th>
                  <th>Completed</th>
                  <th>Rate</th>
                  <th>Cost</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.taskId}:${row.email}`}>
                    <td>
                      <Link to={`/admin/tasks/${row.taskId}`}>
                        {row.title || row.taskId}
                      </Link>
                    </td>
                    <td>{row.projectName || row.projectId || "—"}</td>
                    <td>{hoursLabel(row.actualHours)}</td>
                    <td>{formatReportDate(row.assignedAt)}</td>
                    <td>{row.completedDate || formatReportDate(row.completedAt)}</td>
                    <td>
                      {moneyUsd(row.hourlyRateUsd)}
                      <div style={{ fontSize: 12, color: colors.textMuted }}>
                        {rateSourceLabel(row.rateSource)}
                        {row.rateVersionId ? ` · ${row.rateVersionId}` : ""}
                      </div>
                    </td>
                    <td>{moneyUsd(row.amountUsd)}</td>
                    <td>
                      <div>{costStatusLabel(row.costStatus)}</div>
                      {costingBasisNote(row) ? (
                        <div style={{ fontSize: 12, color: colors.textMuted }}>
                          {costingBasisNote(row)}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
  );
}

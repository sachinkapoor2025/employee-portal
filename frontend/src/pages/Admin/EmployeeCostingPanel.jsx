import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../../components/ui/Button";
import { fetchEmployeeCosting } from "../../services/api";
import { colors, formInput, formLabel } from "../../theme";
import {
  addDaysToKey,
  companyDateKey,
  confirmedCostHeadline,
  defaultCostingRange,
  hoursLabel,
  INCOMPLETE_COSTING_TOTALS,
  INCOMPLETE_REPORT_DETAIL,
  INCOMPLETE_REPORT_TITLE,
  INCOMPLETE_TOTAL_DISPLAY,
  isCostingTruncated,
  moneyUsd,
  PARTIAL_COLLECTED_AMOUNT_LABEL,
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

function SummaryMetrics({ summary, truncated }) {
  const items = [
    {
      label: "Completed hours",
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
      label: "Unpriced legacy hours",
      value: hoursLabel(summary?.unpricedLegacyHours),
    },
  ];
  return (
    <div className="dgv-costing-metrics">
      {items.map((item) => (
        <div key={item.label} className="dgv-costing-metrics__card">
          <div className="dgv-costing-metrics__label">{item.label}</div>
          <div className="dgv-costing-metrics__value">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export default function EmployeeCostingPanel({ email }) {
  const initial = defaultCostingRange();
  const [preset, setPreset] = useState("30");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [data, setData] = useState(null);
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
      } catch (err) {
        setError(err.message || "Unable to load employee costing.");
        if (!pageCursor) {
          setData(null);
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
      <p className="dgv-costing-note">
        Confirmed cost is based on approved task snapshots within the selected
        date range.
        <span className="dgv-costing-note__aside">
          Pending review and missing records are not included in that total.
        </span>
      </p>
      <div className="dgv-costing-filters" role="group" aria-label="Costing date range">
        <label>
          <div style={formLabel}>Range</div>
          <select
            className="dgv-input"
            style={{ ...formInput, marginBottom: 0 }}
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
            style={{ ...formInput, marginBottom: 0 }}
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
            style={{ ...formInput, marginBottom: 0 }}
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
          <SummaryMetrics summary={summary} truncated={truncated} />
          {truncated ? (
            <p style={{ color: colors.textMuted, fontSize: 13, marginTop: 0 }}>
              {PARTIAL_COLLECTED_AMOUNT_LABEL}:{" "}
              {moneyUsd(summary?.confirmedCostUsd)}
            </p>
          ) : null}
          {(data?.projects || []).length ? (
            <div className="dgv-costing-tasks">
              <div className="dgv-costing-tasks__scroll">
                <table className="dgv-costing-tasks__grid dgv-costing-tasks__grid--projects">
                  <thead>
                    <tr>
                      <th className="dgv-costing-tasks__wrap">Project</th>
                      <th className="dgv-costing-tasks__num">Confirmed cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.projects.map((project) => (
                      <tr key={project.projectId || project.name}>
                        <td className="dgv-costing-tasks__wrap">
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
                        <td className="dgv-costing-tasks__num">
                          {truncated
                            ? INCOMPLETE_TOTAL_DISPLAY
                            : moneyUsd(project.confirmedCostUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
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

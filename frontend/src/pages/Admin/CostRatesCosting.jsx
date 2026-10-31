import { useCallback, useEffect, useState } from "react";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import { fetchCostingRoster } from "../../services/api";
import { colors, formInput, formLabel, pageSubtitle } from "../../theme";
import {
  addDaysToKey,
  companyDateKey,
  confirmedCostHeadline,
  INCOMPLETE_COSTING_TOTALS,
  INCOMPLETE_REPORT_DETAIL,
  INCOMPLETE_REPORT_TITLE,
  isCostingTruncated,
  moneyUsd,
  PARTIAL_COLLECTED_AMOUNT_LABEL,
} from "../../utils/costingReports";

const PRESETS = [
  { id: "1m", label: "1 month" },
  { id: "3m", label: "3 months" },
  { id: "6m", label: "6 months" },
  { id: "1y", label: "1 year" },
  { id: "custom", label: "Custom" },
];

function rangeForPreset(preset) {
  const to = companyDateKey();
  if (preset === "3m") return { from: addDaysToKey(to, -89), to };
  if (preset === "6m") return { from: addDaysToKey(to, -181), to };
  if (preset === "1y") return { from: addDaysToKey(to, -364), to };
  return { from: addDaysToKey(to, -29), to };
}

function costLabel(truncated, amount) {
  return confirmedCostHeadline(truncated, amount);
}

export default function CostRatesCosting() {
  const initial = rangeForPreset("1m");
  const [preset, setPreset] = useState("1m");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);

  const applyPreset = (next) => {
    setPreset(next);
    if (next === "custom") return;
    const range = rangeForPreset(next);
    setFrom(range.from);
    setTo(range.to);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setSelected(null);
    try {
      const result = await fetchCostingRoster({ from, to });
      setData(result || null);
    } catch (err) {
      setData(null);
      setError(err?.message || "Unable to load costing.");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const employees = Array.isArray(data?.employees) ? data.employees : [];
  const truncated = isCostingTruncated(data);
  const projects = Array.isArray(selected?.projects) ? selected.projects : [];

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Costing</h2>
      <p className="dgv-costing-note">
        Confirmed cost uses saved snapshots for approved work in the selected
        date range. Pending review, missing cost records, and unpriced legacy
        work are not included.
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
              <p style={{ margin: "8px 0 0" }}>{INCOMPLETE_COSTING_TOTALS}</p>
            </div>
          ) : null}
          {employees.length === 0 ? (
            <p style={pageSubtitle}>No confirmed costs in this date range.</p>
          ) : (
            <div className="dgv-costing-tasks">
              <div className="dgv-costing-tasks__scroll">
                <table className="dgv-costing-tasks__grid dgv-costing-tasks__grid--projects">
                  <thead>
                    <tr>
                      <th className="dgv-costing-tasks__wrap">Employee</th>
                      <th className="dgv-costing-tasks__num">Total confirmed cost</th>
                      <th>Projects</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((employee) => (
                      <tr key={employee.email}>
                        <td className="dgv-costing-tasks__wrap">
                          <div>{employee.name || employee.email}</div>
                          {employee.name ? (
                            <div className="dgv-costing-tasks__meta">{employee.email}</div>
                          ) : null}
                        </td>
                        <td className="dgv-costing-tasks__num">
                          {costLabel(truncated || employee.truncated, employee.confirmedCostUsd)}
                          {truncated || employee.truncated ? (
                            <div className="dgv-costing-tasks__meta">
                              {PARTIAL_COLLECTED_AMOUNT_LABEL}:{" "}
                              {moneyUsd(employee.confirmedCostUsd)}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setSelected(employee)}
                          >
                            View project details
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.name || selected?.email || "Project costs"}
        maxWidth={560}
      >
        {selected?.email ? (
          <p className="dgv-costing-tasks__meta" style={{ marginTop: 0 }}>
            {selected.email}
          </p>
        ) : null}
        {projects.length === 0 ? (
          <p style={pageSubtitle}>No project costs in this date range.</p>
        ) : (
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
                  {projects.map((project) => (
                    <tr key={project.projectId || project.name}>
                      <td className="dgv-costing-tasks__wrap">
                        {project.name || project.projectId || "—"}
                      </td>
                      <td className="dgv-costing-tasks__num">
                        {costLabel(
                          truncated || selected?.truncated,
                          project.confirmedCostUsd
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

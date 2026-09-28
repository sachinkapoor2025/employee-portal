import { colors } from "../theme";

const OPTIONS = [
  { value: "ALL", label: "All", tone: "neutral" },
  { value: "GREEN", label: "Green", tone: "success" },
  { value: "ORANGE", label: "Orange", tone: "warning" },
  { value: "RED", label: "Red", tone: "danger" },
  { value: "COMPLETED", label: "Completed", tone: "success" },
];

const TONES = {
  success: "var(--dgv-success)",
  warning: "var(--dgv-warning)",
  danger: "var(--dgv-danger)",
  neutral: "var(--dgv-text-muted)",
};

export default function ZoneFilter({
  value,
  onChange,
  counts = {},
  includeAll = true,
}) {
  const options = includeAll
    ? OPTIONS
    : OPTIONS.filter((opt) => opt.value !== "ALL");
  const selected = String(
    value || (includeAll ? "ALL" : "GREEN")
  ).toUpperCase();
  return (
    <div
      className="dgv-zone-filter"
      role="tablist"
      aria-label="Task zone filter"
    >
      {options.map((opt) => {
        const active = selected === opt.value;
        const count = counts[opt.value];
        const text =
          typeof count === "number"
            ? `${opt.label} (${count})`
            : opt.label;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            className="dgv-zone-filter__chip"
            onClick={() => onChange(opt.value)}
            style={{
              border: `1px solid ${active ? "transparent" : colors.border}`,
              background: active ? "var(--dgv-accent-soft)" : "var(--dgv-surface-solid)",
              color: active ? colors.text : colors.textSecondary || colors.text,
            }}
          >
            {opt.value !== "ALL" ? (
              <span
                aria-hidden="true"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: TONES[opt.tone],
                }}
              />
            ) : null}
            <span>{text}</span>
          </button>
        );
      })}
    </div>
  );
}

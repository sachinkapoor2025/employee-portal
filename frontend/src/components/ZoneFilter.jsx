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

export default function ZoneFilter({ value, onChange, counts = {} }) {
  const selected = String(value || "ALL").toUpperCase();
  return (
    <div
      role="tablist"
      aria-label="Task zone filter"
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "nowrap",
        overflowX: "auto",
        paddingBottom: 4,
        margin: "8px 0 4px",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {OPTIONS.map((opt) => {
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
            onClick={() => onChange(opt.value)}
            style={{
              flex: "0 0 auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              minHeight: 40,
              padding: "8px 12px",
              borderRadius: 8,
              border: `1px solid ${active ? "transparent" : colors.border}`,
              background: active ? "var(--dgv-accent-soft)" : "var(--dgv-surface-solid)",
              color: active ? colors.text : colors.textSecondary || colors.text,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
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

import { colors } from "../theme";

const OPTIONS = [
  { value: "ALL", emoji: "", label: "All" },
  { value: "GREEN", emoji: "🟢", label: "Green" },
  { value: "ORANGE", emoji: "🟠", label: "Orange" },
  { value: "RED", emoji: "🔴", label: "Red" },
  { value: "COMPLETED", emoji: "✅", label: "Completed" },
];

const ACTIVE = {
  ALL: { bg: "var(--dgv-accent)", color: "#fff", border: "var(--dgv-accent)" },
  GREEN: { bg: "rgba(34,197,94,0.2)", color: "#4ade80", border: "rgba(34,197,94,0.55)" },
  ORANGE: { bg: "rgba(249,115,22,0.2)", color: "#fb923c", border: "rgba(249,115,22,0.55)" },
  RED: { bg: "rgba(239,68,68,0.2)", color: "#f87171", border: "rgba(239,68,68,0.55)" },
  COMPLETED: { bg: "rgba(34,197,94,0.2)", color: "#4ade80", border: "rgba(34,197,94,0.55)" },
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
        const tone = ACTIVE[opt.value];
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
              gap: 6,
              padding: "8px 12px",
              borderRadius: 999,
              border: `1px solid ${active ? tone.border : colors.border}`,
              background: active ? tone.bg : "var(--dgv-surface-solid)",
              color: active ? tone.color : colors.text,
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {opt.emoji ? <span aria-hidden="true">{opt.emoji}</span> : null}
            <span>{text}</span>
          </button>
        );
      })}
    </div>
  );
}

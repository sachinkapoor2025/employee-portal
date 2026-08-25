import { zoneBadgeStyle, zoneDisplay } from "../utils/taskStatus";

export default function ZoneBadge({ zone, status, size = "sm" }) {
  const display = zoneDisplay(zone, status);
  const style = zoneBadgeStyle(zone, status);
  const compact = size === "sm";
  return (
    <span
      title={`${display.emoji} ${display.label}`.trim()}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: compact ? 5 : 8,
        padding: compact ? "3px 8px" : "6px 12px",
        borderRadius: 999,
        fontSize: compact ? 11 : 13,
        fontWeight: 700,
        letterSpacing: 0.3,
        background: style.bg,
        color: style.color,
        border: `1px solid ${style.border}`,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">{display.emoji || "●"}</span>
      {display.label}
    </span>
  );
}

import { zoneBadgeStyle, zoneDisplay } from "../utils/taskStatus";

export default function ZoneBadge({ zone, status, size = "sm" }) {
  const display = zoneDisplay(zone, status);
  const style = zoneBadgeStyle(zone, status);
  const compact = size === "sm";
  return (
    <span
      title={display.label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: compact ? 6 : 8,
        padding: compact ? "4px 10px" : "6px 12px",
        borderRadius: 999,
        fontSize: compact ? 12 : 13,
        fontWeight: 600,
        letterSpacing: 0,
        background: style.bg,
        color: style.color,
        border: `1px solid ${style.border}`,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: compact ? 7 : 8,
          height: compact ? 7 : 8,
          borderRadius: 999,
          background: style.dot,
          flexShrink: 0,
        }}
      />
      {display.label}
    </span>
  );
}

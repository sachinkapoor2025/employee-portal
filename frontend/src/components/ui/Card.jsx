export default function Card({ children, className = "", hover = true, style, ...rest }) {
  return (
    <div
      className={`dgv-card ${hover ? "" : "no-hover"} ${className}`.trim()}
      style={hover ? style : { ...style, transform: "none" }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function StatCard({ label, value, icon }) {
  return (
    <div className="dgv-stat-card">
      {icon ? (
        <div style={{ marginBottom: 10, color: "var(--dgv-accent)" }}>{icon}</div>
      ) : null}
      <div className="dgv-stat-card__value">{value}</div>
      <div className="dgv-stat-card__label">{label}</div>
    </div>
  );
}

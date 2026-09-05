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

export function StatCard({ label, value, hint, icon }) {
  return (
    <div className="dgv-stat-card">
      <div className="dgv-stat-card__top">
        <div className="dgv-stat-card__label">{label}</div>
        {icon ? <span className="dgv-stat-card__icon">{icon}</span> : null}
      </div>
      <div className="dgv-stat-card__value">{value}</div>
      {hint ? <div className="dgv-stat-card__hint">{hint}</div> : null}
    </div>
  );
}

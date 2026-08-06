import { useState } from "react";

export default function Button({
  children,
  variant = "primary",
  type = "button",
  disabled = false,
  loading = false,
  className = "",
  onClick,
  style,
  ...rest
}) {
  const [ripples, setRipples] = useState([]);

  const handleClick = (e) => {
    if (disabled || loading) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    const id = Date.now();

    setRipples((prev) => [...prev, { id, x, y, size }]);
    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, 600);

    try {
      const result = onClick?.(e);
      // Prevent unhandled async rejections from crashing the CRA error overlay
      if (result != null && typeof result.then === "function") {
        result.catch((err) => console.warn("Button action failed:", err));
      }
    } catch (err) {
      console.warn("Button action failed:", err);
    }
  };

  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`dgv-btn dgv-btn--${variant} ${className}`.trim()}
      onClick={handleClick}
      style={style}
      aria-busy={loading || undefined}
      {...rest}
    >
      {ripples.map((r) => (
        <span
          key={r.id}
          className="dgv-btn__ripple"
          style={{
            width: r.size,
            height: r.size,
            left: r.x,
            top: r.y,
          }}
        />
      ))}
      {loading ? "Loading..." : children}
    </button>
  );
}

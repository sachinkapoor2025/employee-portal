export default function Modal({ open, onClose, title, children, maxWidth = 520 }) {
  if (!open) return null;

  return (
    <div
      className="dgv-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title || "Dialog"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="dgv-modal" style={{ maxWidth }}>
        {title ? (
          <h3 style={{ marginTop: 0, marginBottom: 16 }}>{title}</h3>
        ) : null}
        {children}
      </div>
    </div>
  );
}

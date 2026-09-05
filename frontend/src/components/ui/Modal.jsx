import { createPortal } from "react-dom";

export default function Modal({ open, onClose, title, children, maxWidth = 520 }) {
  if (!open) return null;

  return createPortal(
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
        {title ? <h3 className="dgv-modal__header">{title}</h3> : null}
        {children}
      </div>
    </div>,
    document.body
  );
}

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function confirmDiscardIfDirty(dirty) {
  if (!dirty) return true;
  return window.confirm(
    "Discard changes?\n\nYour entered information will be lost."
  );
}

export default function Modal({
  open = true,
  onClose,
  title,
  children,
  footer,
  maxWidth = 520,
  dirty = false,
  closeDisabled = false,
}) {
  const panelRef = useRef(null);
  const lastFocusRef = useRef(null);
  const dirtyRef = useRef(dirty);
  const disabledRef = useRef(closeDisabled);
  dirtyRef.current = dirty;
  disabledRef.current = closeDisabled;

  const requestClose = () => {
    if (disabledRef.current) return;
    if (!confirmDiscardIfDirty(dirtyRef.current)) return;
    onClose?.();
  };

  useEffect(() => {
    if (!open) return undefined;
    lastFocusRef.current = document.activeElement;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        requestClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => {
      const firstField = panelRef.current?.querySelector(
        "input, select, textarea, button:not(.dgv-modal__close)"
      );
      (firstField || panelRef.current)?.focus();
    }, 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      const prev = lastFocusRef.current;
      if (prev && typeof prev.focus === "function") prev.focus();
    };
  // requestClose reads latest dirty/disabled via refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="dgv-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        className="dgv-modal"
        style={{ maxWidth }}
        role="dialog"
        aria-modal="true"
        aria-label={title || "Dialog"}
        tabIndex={-1}
      >
        <div className="dgv-modal__header">
          {title ? <h3 className="dgv-modal__title">{title}</h3> : <span />}
          <button
            type="button"
            className="dgv-modal__close"
            aria-label="Close"
            onClick={requestClose}
            disabled={closeDisabled}
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>
        <div className="dgv-modal__body">{children}</div>
        {footer ? <div className="dgv-modal__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}

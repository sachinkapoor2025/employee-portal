export function positionFixedPopover(anchorEl, popoverEl, { width = 300 } = {}) {
  if (!anchorEl || !popoverEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const gap = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const popWidth = Math.min(width, vw - 16);
  popoverEl.style.width = `${popWidth}px`;
  const popHeight = popoverEl.offsetHeight;
  let top = rect.bottom + gap;
  if (top + popHeight > vh - 8 && rect.top - gap - popHeight > 8) {
    top = rect.top - gap - popHeight;
  }
  top = Math.max(8, Math.min(top, vh - popHeight - 8));
  let left = rect.left;
  if (left + popWidth > vw - 8) left = vw - popWidth - 8;
  left = Math.max(8, left);
  popoverEl.style.top = `${Math.round(top)}px`;
  popoverEl.style.left = `${Math.round(left)}px`;
}

export function bindPickerDismiss(onClose, { ignoreEls = [] } = {}) {
  const inside = (target) =>
    ignoreEls.some((el) => el && (el === target || el.contains(target)));

  const onPointer = (event) => {
    if (inside(event.target)) return;
    event.stopPropagation();
    onClose();
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  document.addEventListener("mousedown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("mousedown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

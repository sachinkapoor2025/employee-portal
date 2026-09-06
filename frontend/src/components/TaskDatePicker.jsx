import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { formLabel } from "../theme";
import { bindPickerDismiss, positionFixedPopover } from "../utils/pickerPopover";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function pad(n) {
  return String(n).padStart(2, "0");
}

function toYmd(year, month, day) {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function parseYmd(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const dt = new Date(year, month, day);
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month ||
    dt.getDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function formatDisplay(value) {
  const parsed = parseYmd(value);
  if (!parsed) return "";
  return new Date(parsed.year, parsed.month, parsed.day).toLocaleDateString(
    "en-GB",
    { day: "2-digit", month: "short", year: "numeric" }
  );
}

function todayYmd() {
  const now = new Date();
  return toYmd(now.getFullYear(), now.getMonth(), now.getDate());
}

function monthLabel(year, month) {
  return new Date(year, month, 1).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}

function buildCells(year, month) {
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < first; i += 1) {
    const day = prevDays - first + 1 + i;
    const dt = new Date(year, month - 1, day);
    cells.push({
      key: `p-${day}`,
      day,
      ymd: toYmd(dt.getFullYear(), dt.getMonth(), day),
      outside: true,
    });
  }
  for (let day = 1; day <= days; day += 1) {
    cells.push({
      key: `c-${day}`,
      day,
      ymd: toYmd(year, month, day),
      outside: false,
    });
  }
  let next = 1;
  while (cells.length < 42) {
    const dt = new Date(year, month + 1, next);
    cells.push({
      key: `n-${next}`,
      day: next,
      ymd: toYmd(dt.getFullYear(), dt.getMonth(), next),
      outside: true,
    });
    next += 1;
  }
  return cells;
}

export default function TaskDatePicker({ id, label, value, onChange, error }) {
  const autoId = useId();
  const fieldId = id || autoId;
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const [open, setOpen] = useState(false);
  const selected = parseYmd(value);
  const initial = selected || parseYmd(todayYmd());
  const [cursor, setCursor] = useState({
    year: initial.year,
    month: initial.month,
  });

  const cells = useMemo(
    () => buildCells(cursor.year, cursor.month),
    [cursor.year, cursor.month]
  );

  useEffect(() => {
    if (!open) return undefined;
    const parsed = parseYmd(value) || parseYmd(todayYmd());
    setCursor({ year: parsed.year, month: parsed.month });
    return undefined;
  }, [open, value]);

  useEffect(() => {
    if (!open) return undefined;
    const place = () =>
      positionFixedPopover(triggerRef.current, panelRef.current, { width: 312 });
    const raf = window.requestAnimationFrame(place);
    const onWin = () => place();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    const unbind = bindPickerDismiss(() => setOpen(false), {
      ignoreEls: [rootRef.current, panelRef.current],
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
      unbind();
    };
  }, [open]);

  const shiftMonth = (delta) => {
    setCursor((prev) => {
      const dt = new Date(prev.year, prev.month + delta, 1);
      return { year: dt.getFullYear(), month: dt.getMonth() };
    });
  };

  return (
    <div className="dgv-task-picker" ref={rootRef}>
      <label style={formLabel} htmlFor={fieldId}>
        {label}
      </label>
      <button
        ref={triggerRef}
        id={fieldId}
        type="button"
        className={`dgv-task-picker__trigger${error ? " is-error" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={value ? "" : "is-placeholder"}>
          {formatDisplay(value) || "dd-mm-yyyy"}
        </span>
        <Calendar size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="dgv-task-picker__panel dgv-task-date__panel"
              role="dialog"
              aria-label={label}
            >
              <div className="dgv-task-date__nav">
                <p>{monthLabel(cursor.year, cursor.month)}</p>
                <div>
                  <button
                    type="button"
                    className="dgv-task-picker__navbtn"
                    aria-label="Previous month"
                    onClick={() => shiftMonth(-1)}
                  >
                    <ChevronLeft size={18} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="dgv-task-picker__navbtn"
                    aria-label="Next month"
                    onClick={() => shiftMonth(1)}
                  >
                    <ChevronRight size={18} strokeWidth={2} />
                  </button>
                </div>
              </div>
              <div className="dgv-task-date__week">
                {WEEKDAYS.map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </div>
              <div className="dgv-task-date__grid">
                {cells.map((cell) => {
                  const isSelected = value === cell.ymd;
                  const isToday = cell.ymd === todayYmd();
                  return (
                    <button
                      key={cell.key}
                      type="button"
                      className={`dgv-task-date__day${
                        cell.outside ? " is-outside" : ""
                      }${isSelected ? " is-selected" : ""}${
                        isToday ? " is-today" : ""
                      }`}
                      aria-label={`Select ${formatDisplay(cell.ymd)}`}
                      aria-pressed={isSelected}
                      onClick={() => {
                        onChange(cell.ymd);
                        setOpen(false);
                      }}
                    >
                      {cell.day}
                    </button>
                  );
                })}
              </div>
              <div className="dgv-task-date__actions">
                <button
                  type="button"
                  className="dgv-task-picker__textbtn"
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="dgv-task-picker__textbtn is-accent"
                  onClick={() => {
                    onChange(todayYmd());
                    setOpen(false);
                  }}
                >
                  Today
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
      {error ? <div className="dgv-field-error">{error}</div> : <div style={{ marginBottom: 16 }} />}
    </div>
  );
}

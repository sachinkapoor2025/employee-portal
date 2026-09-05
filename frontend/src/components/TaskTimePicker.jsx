import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formLabel, formInput } from "../theme";

const HOURS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
const MINUTES = ["00", "15", "30", "45"];
const PERIODS = ["AM", "PM"];
const COMPANY_TZ = "Asia/Kolkata";

function pad(n) {
  return String(n).padStart(2, "0");
}

function companyClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: COMPANY_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

/** Round current Asia/Kolkata time up to the next 15-minute slot (keep exact slots). */
export function nextQuarterHourKolkata(now = new Date()) {
  const clock = companyClock(now);
  let { hour, minute } = clock;
  if (minute % 15 !== 0) {
    const next = Math.ceil(minute / 15) * 15;
    if (next >= 60) {
      hour = (hour + 1) % 24;
      minute = 0;
    } else {
      minute = next;
    }
  }
  return `${pad(hour)}:${pad(minute)}`;
}

function parse24(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour24 = Math.min(23, Math.max(0, Number(match[1])));
  const rawMinute = Number(match[2]);
  const minute = MINUTES.includes(pad(rawMinute)) ? pad(rawMinute) : "00";
  const period = hour24 >= 12 ? "PM" : "AM";
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour: pad(hour12), minute, period };
}

function to24(hour, minute, period) {
  let hour24 = Number(hour) % 12;
  if (period === "PM") hour24 += 12;
  if (period === "AM" && Number(hour) === 12) hour24 = 0;
  if (period === "PM" && Number(hour) === 12) hour24 = 12;
  return `${pad(hour24)}:${minute}`;
}

function formatDisplay(value) {
  const parsed = parse24(value);
  if (!parsed) return "";
  return `${parsed.hour}:${parsed.minute} ${parsed.period}`;
}

export default function TaskTimePicker({
  id,
  label,
  value,
  onChange,
  error,
  fallbackValue = "",
}) {
  const autoId = useId();
  const fieldId = id || autoId;
  const rootRef = useRef(null);
  const hourRefs = useRef({});
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () => parse24(value) || parse24(fallbackValue) || parse24(nextQuarterHourKolkata()),
    [value, fallbackValue]
  );

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const node = hourRefs.current[selected.hour];
    if (node) node.scrollIntoView({ block: "center" });
  }, [open, selected.hour]);

  const commit = (next) => {
    onChange(to24(next.hour, next.minute, next.period));
  };

  const openPicker = () => {
    if (!value) {
      onChange(to24(selected.hour, selected.minute, selected.period));
    }
    setOpen(true);
  };

  return (
    <div className="dgv-task-time" ref={rootRef}>
      <label style={formLabel} htmlFor={fieldId}>
        {label}
      </label>
      <div className="dgv-task-time__box">
        <button
          id={fieldId}
          type="button"
          className="dgv-task-time__trigger"
          style={{
            ...formInput,
            marginBottom: 0,
            textAlign: "left",
            cursor: "pointer",
            border: error
              ? "1px solid var(--dgv-danger)"
              : formInput.border,
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => (open ? setOpen(false) : openPicker())}
        >
          {formatDisplay(value) || "Select time"}
        </button>
        {open ? (
          <div className="dgv-task-time__panel" role="group" aria-label={label}>
            <div className="dgv-task-time__col" role="listbox" aria-label="Hour">
              {HOURS.map((hour) => (
                <button
                  key={hour}
                  type="button"
                  ref={(node) => {
                    hourRefs.current[hour] = node;
                  }}
                  role="option"
                  aria-selected={selected.hour === hour}
                  className={`dgv-task-time__opt ${
                    selected.hour === hour ? "is-selected" : ""
                  }`}
                  onClick={() => commit({ ...selected, hour })}
                >
                  {hour}
                </button>
              ))}
            </div>
            <div className="dgv-task-time__col" role="listbox" aria-label="Minute">
              {MINUTES.map((minute) => (
                <button
                  key={minute}
                  type="button"
                  role="option"
                  aria-selected={selected.minute === minute}
                  className={`dgv-task-time__opt ${
                    selected.minute === minute ? "is-selected" : ""
                  }`}
                  onClick={() => commit({ ...selected, minute })}
                >
                  {minute}
                </button>
              ))}
            </div>
            <div className="dgv-task-time__col" role="listbox" aria-label="AM or PM">
              {PERIODS.map((period) => (
                <button
                  key={period}
                  type="button"
                  role="option"
                  aria-selected={selected.period === period}
                  className={`dgv-task-time__opt ${
                    selected.period === period ? "is-selected" : ""
                  }`}
                  onClick={() => commit({ ...selected, period })}
                >
                  {period}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {error ? (
        <div
          style={{
            color: "var(--dgv-danger)",
            fontSize: 12,
            marginTop: 4,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      ) : (
        <div style={{ marginBottom: 16 }} />
      )}
    </div>
  );
}

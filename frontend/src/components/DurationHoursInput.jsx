import { formLabel, colors } from "../theme";
import {
  HH_MM_HELPER,
  HH_MM_PLACEHOLDER,
  formatHhMm,
  normalizeHhMmInput,
  stepDuration,
} from "../utils/durationHours";

const fieldBox = (error) => ({
  display: "flex",
  alignItems: "stretch",
  width: "fit-content",
  maxWidth: "100%",
  minHeight: 40,
  borderRadius: 8,
  border: error ? "1px solid var(--dgv-danger)" : "1px solid var(--dgv-border)",
  background: "var(--dgv-surface-solid)",
  overflow: "hidden",
});

const segmentInput = {
  width: 64,
  border: "none",
  outline: "none",
  background: "transparent",
  color: "var(--dgv-text)",
  fontSize: 15,
  textAlign: "center",
  padding: "8px 4px",
  minHeight: 40,
  boxSizing: "border-box",
};

const stepperCol = {
  display: "flex",
  flexDirection: "column",
  borderLeft: "1px solid var(--dgv-border)",
};

const stepBtn = {
  flex: 1,
  margin: 0,
  padding: 0,
  width: 22,
  border: "none",
  background: "var(--dgv-surface-muted, transparent)",
  color: "var(--dgv-text-muted)",
  cursor: "pointer",
  lineHeight: 1,
  fontSize: 10,
};

function partsFromValue(value) {
  const text = String(value || "").trim();
  if (!text) return { hours: "", minutes: "" };
  const match = text.match(/^(-?\d{0,4}):(\d{0,2})$/);
  if (!match) return { hours: "", minutes: "" };
  return { hours: match[1], minutes: match[2] };
}

function emitValue(hours, minutes) {
  if (hours === "" && minutes === "") return "";
  return `${hours}:${minutes}`;
}

function Stepper({ label, onIncrease, onDecrease }) {
  return (
    <div style={stepperCol}>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        style={{ ...stepBtn, borderBottom: "1px solid var(--dgv-border)" }}
        onClick={onIncrease}
      >
        ▲
      </button>
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        style={stepBtn}
        onClick={onDecrease}
      >
        ▼
      </button>
    </div>
  );
}

export default function DurationHoursInput({
  id,
  label,
  value,
  onChange,
  error,
  required = false,
  helper = HH_MM_HELPER,
  "aria-label": ariaLabel,
}) {
  const fieldLabel = ariaLabel || label;
  const parts = partsFromValue(value);
  const hoursId = id;
  const minutesId = id ? `${id}-minutes` : undefined;

  const commit = (hours, minutes) => {
    onChange(emitValue(hours, minutes));
  };

  const handleHoursChange = (raw) => {
    const next = raw.replace(/[^\d]/g, "").slice(0, 4);
    commit(next, parts.minutes);
  };

  const handleMinutesChange = (raw) => {
    const next = raw.replace(/[^\d]/g, "").slice(0, 2);
    commit(parts.hours, next);
  };

  const handleBlur = () => {
    onChange(normalizeHhMmInput(value));
  };

  const nudge = (unit, delta) => {
    const current =
      parts.hours === "" && parts.minutes === ""
        ? ""
        : formatHhMm(parts.hours || 0, parts.minutes || 0);
    onChange(stepDuration(current, unit, delta));
  };

  const onWheel = (unit) => (event) => {
    event.preventDefault();
    nudge(unit, event.deltaY < 0 ? 1 : -1);
  };

  return (
    <div>
      {label ? (
        <label style={formLabel} htmlFor={hoursId}>
          {required ? `${label} *` : label}
        </label>
      ) : null}
      <div
        role="group"
        aria-label={fieldLabel}
        style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
      >
        <div style={fieldBox(error)}>
          <input
            id={hoursId}
            inputMode="numeric"
            autoComplete="off"
            placeholder="HH"
            aria-label={`${fieldLabel} hours`}
            aria-invalid={error ? true : undefined}
            aria-required={required || undefined}
            value={parts.hours}
            style={segmentInput}
            onChange={(e) => handleHoursChange(e.target.value)}
            onBlur={handleBlur}
            onWheel={onWheel("hours")}
          />
          <span
            aria-hidden="true"
            style={{
              alignSelf: "center",
              fontWeight: 700,
              color: "var(--dgv-text-muted)",
              padding: "0 2px",
            }}
          >
            :
          </span>
          <input
            id={minutesId}
            inputMode="numeric"
            autoComplete="off"
            placeholder="MM"
            aria-label={`${fieldLabel} minutes`}
            aria-invalid={error ? true : undefined}
            aria-required={required || undefined}
            value={parts.minutes}
            style={segmentInput}
            onChange={(e) => handleMinutesChange(e.target.value)}
            onBlur={handleBlur}
            onWheel={onWheel("minutes")}
          />
          <Stepper
            label={`${fieldLabel} hours`}
            onIncrease={() => nudge("hours", 1)}
            onDecrease={() => nudge("hours", -1)}
          />
          <Stepper
            label={`${fieldLabel} minutes`}
            onIncrease={() => nudge("minutes", 1)}
            onDecrease={() => nudge("minutes", -1)}
          />
        </div>
        <span style={{ fontSize: 13, color: colors.textMuted }}>{HH_MM_PLACEHOLDER}</span>
      </div>
      {helper ? (
        <p style={{ margin: "8px 0 0", fontSize: 13, color: colors.textMuted }}>
          {helper}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          style={{ margin: "8px 0 0", fontSize: 13, color: "var(--dgv-danger)" }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

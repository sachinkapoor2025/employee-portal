import { useState } from "react";
import { Clock } from "lucide-react";
import { useWorkingTime } from "../hooks/useWorkingTime";
import Button from "./ui/Button";

const STATUS_BADGE = {
  active: "dgv-badge dgv-badge--success",
  out: "dgv-badge dgv-badge--neutral",
  idle: "dgv-badge dgv-badge--neutral",
};

export default function WorkingTimeWidget() {
  const {
    loading,
    busy,
    status,
    isActive,
    canCheckIn,
    canCheckOut,
    pastExpectedEnd,
    formattedElapsed,
    checkIn,
    checkOut,
  } = useWorkingTime();
  const [beyondReason, setBeyondReason] = useState("");

  const onCheckOut = () =>
    checkOut({
      workedBeyondReason: pastExpectedEnd ? beyondReason : undefined,
    });

  return (
    <section
      className="dgv-work-card"
      aria-labelledby="working-time-title"
      aria-live="polite"
    >
      <div className="dgv-work-card__header">
        <div className="dgv-work-card__title-row">
          <span className="dgv-work-card__icon" aria-hidden="true">
            <Clock size={18} strokeWidth={2.2} />
          </span>
          <div>
            <h3 id="working-time-title" className="dgv-work-card__title">
              Working Time Today
            </h3>
            <p className="dgv-work-card__subtitle">
              Based on your attendance check-in / check-out
            </p>
          </div>
        </div>

        <span
          className={`${STATUS_BADGE[status.key] || STATUS_BADGE.idle} dgv-work-card__status`}
          role="status"
        >
          {isActive ? (
            <span className="dgv-work-card__pulse" aria-hidden="true" />
          ) : null}
          {status.label}
        </span>
      </div>

      {loading ? (
        <p className="dgv-work-card__loading">Loading attendance…</p>
      ) : (
        <>
          <div className="dgv-work-card__timer-block">
            <div
              className={`dgv-work-card__timer ${isActive ? "is-live" : ""}`}
              aria-label={`Working time ${formattedElapsed}`}
            >
              {formattedElapsed}
            </div>
          </div>

          {canCheckOut && pastExpectedEnd ? (
            <label className="dgv-work-card__subtitle" htmlFor="worked-beyond-reason">
              Worked beyond shift (optional)
              <textarea
                id="worked-beyond-reason"
                className="dgv-input"
                rows={2}
                value={beyondReason}
                onChange={(e) => setBeyondReason(e.target.value)}
                style={{ display: "block", width: "100%", marginTop: 8 }}
              />
            </label>
          ) : null}

          {canCheckIn || canCheckOut ? (
            <div className="dgv-work-card__actions">
              {canCheckIn ? (
                <Button type="button" onClick={checkIn} disabled={busy} loading={busy}>
                  Check In
                </Button>
              ) : null}
              {canCheckOut ? (
                <Button type="button" onClick={onCheckOut} disabled={busy} loading={busy}>
                  Check Out
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import {
  createShift,
  fetchShifts,
  updateShift,
} from "../../services/api";
import {
  alertError,
  alertSuccess,
  colors,
  formInput,
  formLabel,
  pageCard,
  pageSubtitle,
  pageTitle,
} from "../../theme";

const EMPTY_HALF = {
  startTime: "",
  endTime: "",
  graceMinutes: 0,
};

const EMPTY_FORM = {
  name: "",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 0,
  halfDayEnabled: false,
  firstHalf: { ...EMPTY_HALF },
  secondHalf: { ...EMPTY_HALF },
};

function formatWindow(shift) {
  if (!shift?.startTime || !shift?.endTime) return "—";
  const suffix = shift.crossesMidnight ? " (overnight)" : "";
  return `${shift.startTime} – ${shift.endTime}${suffix}`;
}

function formatHalfWindow(half) {
  if (!half?.startTime || !half?.endTime) return "—";
  return `${half.startTime} – ${half.endTime}`;
}

function formatHalfDay(shift) {
  if (shift?.halfDayEnabled !== true) return "Not enabled";
  return `First ${formatHalfWindow(shift.firstHalf)} / Second ${formatHalfWindow(shift.secondHalf)}`;
}

function halfFromShift(half) {
  return {
    startTime: half?.startTime || "",
    endTime: half?.endTime || "",
    graceMinutes: Number(half?.graceMinutes || 0),
  };
}

function isValidFormHm(value) {
  return /^\d{2}:\d{2}$/.test(String(value || "").trim());
}

function validateHalfForm(label, half) {
  if (!isValidFormHm(half?.startTime) || !isValidFormHm(half?.endTime)) {
    return `${label} start and end times are required.`;
  }
  if (half.startTime === half.endTime) {
    return `${label} end time must be different from start time.`;
  }
  const grace = Number(half?.graceMinutes);
  if (!Number.isFinite(grace) || grace < 0 || grace > 1440) {
    return `${label} grace period must be minutes between 0 and 1440.`;
  }
  return "";
}

export default function ManageShifts() {
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState("");

  const load = useCallback(async ({ silent } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await fetchShifts();
      setShifts(Array.isArray(res?.shifts) ? res.shifts : []);
    } catch (err) {
      setShifts([]);
      setError(err?.message || "Unable to load shifts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startCreate = () => {
    setEditingId("");
    setForm(EMPTY_FORM);
    setMessage("");
    setError("");
  };

  const startEdit = (shift) => {
    setEditingId(shift.shiftId);
    setForm({
      name: shift.name || "",
      startTime: shift.startTime || "11:00",
      endTime: shift.endTime || "20:00",
      graceMinutes: Number(shift.graceMinutes || 0),
      halfDayEnabled: shift.halfDayEnabled === true,
      firstHalf: halfFromShift(shift.firstHalf),
      secondHalf: halfFromShift(shift.secondHalf),
    });
    setMessage("");
    setError("");
  };

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");
    if (form.halfDayEnabled) {
      const halfError =
        validateHalfForm("First half", form.firstHalf) ||
        validateHalfForm("Second half", form.secondHalf);
      if (halfError) {
        setError(halfError);
        return;
      }
    }
    setSaving(true);
    const payload = {
      name: form.name,
      startTime: form.startTime,
      endTime: form.endTime,
      graceMinutes: Number(form.graceMinutes || 0),
      halfDayEnabled: form.halfDayEnabled === true,
    };
    if (payload.halfDayEnabled) {
      payload.firstHalf = {
        startTime: form.firstHalf.startTime,
        endTime: form.firstHalf.endTime,
        graceMinutes: Number(form.firstHalf.graceMinutes || 0),
      };
      payload.secondHalf = {
        startTime: form.secondHalf.startTime,
        endTime: form.secondHalf.endTime,
        graceMinutes: Number(form.secondHalf.graceMinutes || 0),
      };
    }
    try {
      if (editingId) {
        await updateShift(editingId, payload);
        setMessage("Shift updated.");
      } else {
        await createShift(payload);
        setMessage("Shift created.");
        setForm(EMPTY_FORM);
      }
      await load({ silent: true });
    } catch (err) {
      setError(err?.message || "Unable to save shift.");
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (shift) => {
    const next =
      String(shift.status).toUpperCase() === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setError("");
    setMessage("");
    setStatusBusy(shift.shiftId);
    try {
      await updateShift(shift.shiftId, { status: next });
      setMessage(
        next === "INACTIVE" ? "Shift deactivated." : "Shift activated."
      );
      await load({ silent: true });
    } catch (err) {
      setError(err?.message || "Unable to update shift status.");
    } finally {
      setStatusBusy("");
    }
  };

  return (
    <Layout>
      <h1 style={pageTitle}>Manage Shifts</h1>
      <p style={pageSubtitle}>
        Define company shifts and their hours. Assign a shift to each employee
        from the employee profile. Employees can view their shift but cannot
        change it.
      </p>

      {error ? (
        <div className="dgv-alert dgv-alert--error" style={{ ...alertError, marginBottom: 16 }}>
          {error}
        </div>
      ) : null}
      {message ? (
        <div style={{ ...alertSuccess, marginBottom: 16 }}>{message}</div>
      ) : null}

      <div style={pageCard}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>
          {editingId ? "Edit shift" : "Add shift"}
        </h2>
        <p style={{ ...pageSubtitle, marginBottom: 12 }}>
          End time can be the next morning for overnight shifts, for example
          22:00 to 06:00.
        </p>
        <form onSubmit={save} style={{ display: "grid", gap: 12, maxWidth: 520 }}>
          <label style={formLabel} htmlFor="shift-name">
            Name
            <input
              id="shift-name"
              style={formInput}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </label>
          <label style={formLabel} htmlFor="shift-start">
            Start time
            <input
              id="shift-start"
              style={formInput}
              type="time"
              value={form.startTime}
              onChange={(e) =>
                setForm((f) => ({ ...f, startTime: e.target.value }))
              }
              required
            />
          </label>
          <label style={formLabel} htmlFor="shift-end">
            End time
            <input
              id="shift-end"
              style={formInput}
              type="time"
              value={form.endTime}
              onChange={(e) =>
                setForm((f) => ({ ...f, endTime: e.target.value }))
              }
              required
            />
          </label>
          <label style={formLabel} htmlFor="shift-grace">
            Grace period (minutes)
            <input
              id="shift-grace"
              style={formInput}
              type="number"
              min="0"
              max="1440"
              value={form.graceMinutes}
              onChange={(e) =>
                setForm((f) => ({ ...f, graceMinutes: e.target.value }))
              }
            />
          </label>
          <label
            style={{ ...formLabel, display: "flex", alignItems: "center", gap: 8 }}
            htmlFor="shift-half-day"
          >
            <input
              id="shift-half-day"
              type="checkbox"
              checked={form.halfDayEnabled === true}
              onChange={(e) =>
                setForm((f) => ({ ...f, halfDayEnabled: e.target.checked }))
              }
            />
            Enable half-day attendance
          </label>
          {form.halfDayEnabled ? (
            <>
              <div>
                <div style={{ ...formLabel, marginBottom: 8 }}>First Half</div>
                <div style={{ display: "grid", gap: 12 }}>
                  <label style={formLabel} htmlFor="shift-first-start">
                    Start time
                    <input
                      id="shift-first-start"
                      style={formInput}
                      type="time"
                      value={form.firstHalf.startTime}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          firstHalf: { ...f.firstHalf, startTime: e.target.value },
                        }))
                      }
                      required
                    />
                  </label>
                  <label style={formLabel} htmlFor="shift-first-end">
                    End time
                    <input
                      id="shift-first-end"
                      style={formInput}
                      type="time"
                      value={form.firstHalf.endTime}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          firstHalf: { ...f.firstHalf, endTime: e.target.value },
                        }))
                      }
                      required
                    />
                  </label>
                  <label style={formLabel} htmlFor="shift-first-grace">
                    Grace minutes
                    <input
                      id="shift-first-grace"
                      style={formInput}
                      type="number"
                      min="0"
                      max="1440"
                      value={form.firstHalf.graceMinutes}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          firstHalf: {
                            ...f.firstHalf,
                            graceMinutes: e.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                </div>
              </div>
              <div>
                <div style={{ ...formLabel, marginBottom: 8 }}>Second Half</div>
                <div style={{ display: "grid", gap: 12 }}>
                  <label style={formLabel} htmlFor="shift-second-start">
                    Start time
                    <input
                      id="shift-second-start"
                      style={formInput}
                      type="time"
                      value={form.secondHalf.startTime}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          secondHalf: {
                            ...f.secondHalf,
                            startTime: e.target.value,
                          },
                        }))
                      }
                      required
                    />
                  </label>
                  <label style={formLabel} htmlFor="shift-second-end">
                    End time
                    <input
                      id="shift-second-end"
                      style={formInput}
                      type="time"
                      value={form.secondHalf.endTime}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          secondHalf: { ...f.secondHalf, endTime: e.target.value },
                        }))
                      }
                      required
                    />
                  </label>
                  <label style={formLabel} htmlFor="shift-second-grace">
                    Grace minutes
                    <input
                      id="shift-second-grace"
                      style={formInput}
                      type="number"
                      min="0"
                      max="1440"
                      value={form.secondHalf.graceMinutes}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          secondHalf: {
                            ...f.secondHalf,
                            graceMinutes: e.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                </div>
              </div>
            </>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="submit" loading={saving}>
              {editingId ? "Save Changes" : "Add Shift"}
            </Button>
            {editingId ? (
              <Button type="button" variant="ghost" onClick={startCreate}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </div>

      <div style={{ ...pageCard, marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Shifts</h2>
        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading shifts…</p>
        ) : !shifts.length ? (
          <p style={{ color: colors.textMuted, margin: 0 }}>
            No shifts found. Add a shift above.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              className="dgv-table"
              style={{ width: "100%", borderCollapse: "collapse" }}
            >
              <thead>
                <tr>
                  <th align="left">Name</th>
                  <th align="left">Hours</th>
                  <th align="left">Grace</th>
                  <th align="left">Half-day</th>
                  <th align="left">Status</th>
                  <th align="left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((shift) => (
                  <tr key={shift.shiftId}>
                    <td>{shift.name}</td>
                    <td>{formatWindow(shift)}</td>
                    <td>{Number(shift.graceMinutes || 0)} min</td>
                    <td>{formatHalfDay(shift)}</td>
                    <td>{shift.status}</td>
                    <td>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => startEdit(shift)}
                      >
                        Edit
                      </Button>{" "}
                      <Button
                        type="button"
                        variant="secondary"
                        loading={statusBusy === shift.shiftId}
                        onClick={() => toggleStatus(shift)}
                      >
                        {String(shift.status).toUpperCase() === "ACTIVE"
                          ? "Deactivate"
                          : "Activate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}

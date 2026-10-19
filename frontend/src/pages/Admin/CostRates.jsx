import { useCallback, useEffect, useMemo, useState } from "react";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import {
  createCostRateDesignation,
  fetchCostRateDesignations,
  fetchCostRateEmployee,
  fetchCostRateEmployees,
  saveCostRateEmployee,
  setCostRateDesignationStatus,
  setCostRateEmployeeStatus,
  updateCostRateDesignation,
} from "../../services/api";
import {
  displayRateOrUnset,
  parseUsdRateInput,
  rateSourceLabel,
} from "../../utils/costRates";
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

const EMPTY_DES_FORM = {
  name: "",
  internalHourlyRate: "",
  externalHourlyRate: "",
};

const EMPTY_EMP_FORM = {
  email: "",
  designationId: "",
  internalHourlyRate: "",
  externalHourlyRate: "",
};

function rateFieldValue(value) {
  return value == null ? "" : String(value);
}

function ResolvedCell({ side }) {
  const configured = side?.rate != null;
  return (
    <span>
      {displayRateOrUnset(side?.rate)}
      <span
        style={{
          marginLeft: 8,
          color: configured ? colors.textMuted : colors.error,
          fontSize: 12,
        }}
      >
        ({rateSourceLabel(side?.source)})
      </span>
    </span>
  );
}

export default function CostRates() {
  const [tab, setTab] = useState("designations");
  const [designations, setDesignations] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [savingDes, setSavingDes] = useState(false);
  const [savingEmp, setSavingEmp] = useState(false);
  const [statusBusy, setStatusBusy] = useState("");
  const [desForm, setDesForm] = useState(EMPTY_DES_FORM);
  const [editingDesId, setEditingDesId] = useState("");
  const [empForm, setEmpForm] = useState(EMPTY_EMP_FORM);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [employeeQuery, setEmployeeQuery] = useState("");

  const load = useCallback(async ({ silent } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const [desRes, empRes] = await Promise.all([
        fetchCostRateDesignations(),
        fetchCostRateEmployees(),
      ]);
      setDesignations(Array.isArray(desRes?.designations) ? desRes.designations : []);
      setEmployees(Array.isArray(empRes?.employees) ? empRes.employees : []);
    } catch (err) {
      setDesignations([]);
      setEmployees([]);
      setError(err?.message || "Unable to load cost rates.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filteredEmployees = useMemo(() => {
    const q = employeeQuery.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((row) => {
      const hay = `${row.email} ${row.name || ""} ${row.empId || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [employees, employeeQuery]);

  const startCreateDes = () => {
    setEditingDesId("");
    setDesForm(EMPTY_DES_FORM);
    setMessage("");
    setError("");
  };

  const startEditDes = (row) => {
    setEditingDesId(row.designationId);
    setDesForm({
      name: row.name || "",
      internalHourlyRate: rateFieldValue(row.internalHourlyRate),
      externalHourlyRate: rateFieldValue(row.externalHourlyRate),
    });
    setMessage("");
    setError("");
  };

  const saveDesignation = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");
    const internal = parseUsdRateInput(desForm.internalHourlyRate);
    const external = parseUsdRateInput(desForm.externalHourlyRate);
    if (!internal.ok) {
      setError(internal.error);
      return;
    }
    if (!external.ok) {
      setError(external.error);
      return;
    }
    if (!String(desForm.name || "").trim()) {
      setError("Designation name is required.");
      return;
    }
    setSavingDes(true);
    const payload = {
      name: desForm.name,
      internalHourlyRate: internal.value,
      externalHourlyRate: external.value,
    };
    try {
      if (editingDesId) {
        await updateCostRateDesignation(editingDesId, payload);
        setMessage("Designation updated.");
      } else {
        await createCostRateDesignation(payload);
        setMessage("Designation created.");
        setDesForm(EMPTY_DES_FORM);
      }
      await load({ silent: true });
    } catch (err) {
      setError(err?.message || "Unable to save designation.");
    } finally {
      setSavingDes(false);
    }
  };

  const toggleDesStatus = async (row) => {
    const next =
      String(row.status).toUpperCase() === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setError("");
    setMessage("");
    setStatusBusy(`des:${row.designationId}`);
    try {
      await setCostRateDesignationStatus(row.designationId, next);
      setMessage(
        next === "INACTIVE"
          ? "Designation deactivated."
          : "Designation activated."
      );
      await load({ silent: true });
    } catch (err) {
      setError(err?.message || "Unable to update designation status.");
    } finally {
      setStatusBusy("");
    }
  };

  const selectEmployee = async (row) => {
    setError("");
    setMessage("");
    setSelectedEmployee(row);
    setEmpForm({
      email: row.email,
      designationId: row.designationId || "",
      internalHourlyRate: rateFieldValue(row.internalHourlyRate),
      externalHourlyRate: rateFieldValue(row.externalHourlyRate),
    });
    try {
      const res = await fetchCostRateEmployee(row.email);
      const employee = res?.employee || row;
      setSelectedEmployee(employee);
      setEmpForm({
        email: employee.email,
        designationId: employee.designationId || "",
        internalHourlyRate: rateFieldValue(employee.internalHourlyRate),
        externalHourlyRate: rateFieldValue(employee.externalHourlyRate),
      });
    } catch (err) {
      setError(err?.message || "Unable to load employee rates.");
    }
  };

  const saveEmployee = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!empForm.email) {
      setError("Select an employee.");
      return;
    }
    if (!empForm.designationId) {
      setError("Select a managed designation.");
      return;
    }
    const internal = parseUsdRateInput(empForm.internalHourlyRate);
    const external = parseUsdRateInput(empForm.externalHourlyRate);
    if (!internal.ok) {
      setError(internal.error);
      return;
    }
    if (!external.ok) {
      setError(external.error);
      return;
    }
    setSavingEmp(true);
    try {
      await saveCostRateEmployee(empForm.email, {
        designationId: empForm.designationId,
        internalHourlyRate: internal.value,
        externalHourlyRate: external.value,
      });
      setMessage("Employee rates saved.");
      await load({ silent: true });
      const res = await fetchCostRateEmployee(empForm.email);
      if (res?.employee) {
        setSelectedEmployee(res.employee);
        setEmpForm({
          email: res.employee.email,
          designationId: res.employee.designationId || "",
          internalHourlyRate: rateFieldValue(res.employee.internalHourlyRate),
          externalHourlyRate: rateFieldValue(res.employee.externalHourlyRate),
        });
      }
    } catch (err) {
      setError(err?.message || "Unable to save employee rates.");
    } finally {
      setSavingEmp(false);
    }
  };

  const toggleEmpStatus = async () => {
    if (!selectedEmployee?.email || !selectedEmployee.hasRateRecord) return;
    const next =
      String(selectedEmployee.status).toUpperCase() === "ACTIVE"
        ? "INACTIVE"
        : "ACTIVE";
    setError("");
    setMessage("");
    setStatusBusy(`emp:${selectedEmployee.email}`);
    try {
      await setCostRateEmployeeStatus(selectedEmployee.email, next);
      setMessage(
        next === "INACTIVE"
          ? "Employee rate record deactivated."
          : "Employee rate record activated."
      );
      await load({ silent: true });
      const res = await fetchCostRateEmployee(selectedEmployee.email);
      if (res?.employee) setSelectedEmployee(res.employee);
    } catch (err) {
      setError(err?.message || "Unable to update employee rate status.");
    } finally {
      setStatusBusy("");
    }
  };

  const tabBtn = (id, label) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      aria-pressed={tab === id}
      style={{
        ...formInput,
        width: "auto",
        fontWeight: tab === id ? 700 : 500,
        background: tab === id ? colors.primary : colors.card,
        color: tab === id ? "#fff" : colors.text,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <Layout>
      <h1 style={pageTitle}>Cost Rates</h1>
      <p style={pageSubtitle}>
        Super Admin hourly rates in USD. Personalized Internal and External
        rates override the linked designation independently. A blank rate is
        unset, not zero, and falls back to the designation when that side is
        configured.
      </p>

      {error ? (
        <div
          className="dgv-alert dgv-alert--error"
          style={{ ...alertError, marginBottom: 16 }}
        >
          {error}
        </div>
      ) : null}
      {message ? (
        <div style={{ ...alertSuccess, marginBottom: 16 }}>{message}</div>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {tabBtn("designations", "Designations")}
        {tabBtn("employees", "Employees")}
      </div>

      {loading ? <p>Loading cost rates…</p> : null}

      {!loading && tab === "designations" ? (
        <>
          <div style={pageCard}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>
              {editingDesId ? "Edit designation" : "Add designation"}
            </h2>
            <form
              onSubmit={saveDesignation}
              style={{ display: "grid", gap: 12, maxWidth: 520 }}
            >
              <label style={formLabel} htmlFor="des-name">
                Designation name
                <input
                  id="des-name"
                  style={formInput}
                  value={desForm.name}
                  onChange={(e) =>
                    setDesForm((f) => ({ ...f, name: e.target.value }))
                  }
                  required
                />
              </label>
              <label style={formLabel} htmlFor="des-internal">
                Internal hourly rate (USD)
                <input
                  id="des-internal"
                  style={formInput}
                  inputMode="decimal"
                  placeholder="Unset"
                  value={desForm.internalHourlyRate}
                  onChange={(e) =>
                    setDesForm((f) => ({
                      ...f,
                      internalHourlyRate: e.target.value,
                    }))
                  }
                />
              </label>
              <label style={formLabel} htmlFor="des-external">
                External hourly rate (USD)
                <input
                  id="des-external"
                  style={formInput}
                  inputMode="decimal"
                  placeholder="Unset"
                  value={desForm.externalHourlyRate}
                  onChange={(e) =>
                    setDesForm((f) => ({
                      ...f,
                      externalHourlyRate: e.target.value,
                    }))
                  }
                />
              </label>
              <p style={{ ...pageSubtitle, margin: 0 }}>
                Leave a rate blank to leave it unset. Do not enter 0.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <Button type="submit" loading={savingDes} disabled={savingDes}>
                  {editingDesId ? "Save designation" : "Create designation"}
                </Button>
                {editingDesId ? (
                  <Button type="button" variant="secondary" onClick={startCreateDes}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>
          </div>

          <div style={{ ...pageCard, marginTop: 16 }}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Designation catalog</h2>
            {designations.length === 0 ? (
              <p style={pageSubtitle}>No designations yet.</p>
            ) : (
              <table className="dgv-employees-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Internal</th>
                    <th>External</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {designations.map((row) => (
                    <tr key={row.designationId}>
                      <td>
                        {row.name}
                        {!row.hasConfiguredRate ? (
                          <div style={{ fontSize: 12, color: colors.textMuted }}>
                            No configured rate
                          </div>
                        ) : null}
                      </td>
                      <td>{displayRateOrUnset(row.internalHourlyRate)}</td>
                      <td>{displayRateOrUnset(row.externalHourlyRate)}</td>
                      <td>{row.status}</td>
                      <td>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => startEditDes(row)}
                        >
                          Edit
                        </Button>{" "}
                        <Button
                          type="button"
                          variant="secondary"
                          loading={statusBusy === `des:${row.designationId}`}
                          disabled={Boolean(statusBusy)}
                          onClick={() => toggleDesStatus(row)}
                        >
                          {String(row.status).toUpperCase() === "ACTIVE"
                            ? "Deactivate"
                            : "Activate"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}

      {!loading && tab === "employees" ? (
        <>
          <div style={pageCard}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Employee rates</h2>
            <label style={formLabel} htmlFor="emp-search">
              Search employees
              <input
                id="emp-search"
                style={formInput}
                value={employeeQuery}
                onChange={(e) => setEmployeeQuery(e.target.value)}
                placeholder="Email, name, or employee ID"
              />
            </label>
            <div style={{ maxHeight: 220, overflow: "auto", marginTop: 8 }}>
              {filteredEmployees.map((row) => (
                <button
                  key={row.email}
                  type="button"
                  onClick={() => selectEmployee(row)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 10px",
                    border:
                      selectedEmployee?.email === row.email
                        ? `1px solid ${colors.primary}`
                        : "1px solid transparent",
                    background:
                      selectedEmployee?.email === row.email
                        ? colors.background
                        : "transparent",
                    cursor: "pointer",
                  }}
                >
                  {row.name || row.email} ({row.email})
                </button>
              ))}
            </div>
          </div>

          {selectedEmployee ? (
            <div style={{ ...pageCard, marginTop: 16 }}>
              <h2 style={{ marginTop: 0, fontSize: 16 }}>
                Rates for {selectedEmployee.email}
              </h2>
              <p style={pageSubtitle}>
                Profile designation (not used for costing):{" "}
                {selectedEmployee.profileDesignation || "—"}
              </p>
              <form
                onSubmit={saveEmployee}
                style={{ display: "grid", gap: 12, maxWidth: 520 }}
              >
                <label style={formLabel} htmlFor="emp-des">
                  Managed designation
                  <select
                    id="emp-des"
                    style={formInput}
                    value={empForm.designationId}
                    onChange={(e) =>
                      setEmpForm((f) => ({ ...f, designationId: e.target.value }))
                    }
                    required
                  >
                    <option value="">Select designation</option>
                    {designations.map((d) => (
                      <option key={d.designationId} value={d.designationId}>
                        {d.name}
                        {String(d.status).toUpperCase() === "INACTIVE"
                          ? " (inactive)"
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={formLabel} htmlFor="emp-internal">
                  Personal internal hourly rate (USD)
                  <input
                    id="emp-internal"
                    style={formInput}
                    inputMode="decimal"
                    placeholder="Use designation"
                    value={empForm.internalHourlyRate}
                    onChange={(e) =>
                      setEmpForm((f) => ({
                        ...f,
                        internalHourlyRate: e.target.value,
                      }))
                    }
                  />
                </label>
                <label style={formLabel} htmlFor="emp-external">
                  Personal external hourly rate (USD)
                  <input
                    id="emp-external"
                    style={formInput}
                    inputMode="decimal"
                    placeholder="Use designation"
                    value={empForm.externalHourlyRate}
                    onChange={(e) =>
                      setEmpForm((f) => ({
                        ...f,
                        externalHourlyRate: e.target.value,
                      }))
                    }
                  />
                </label>
                <p style={{ ...pageSubtitle, margin: 0 }}>
                  Clear a personal rate to use the designation fallback for that
                  project type only.
                </p>
                <div>
                  <div>
                    Resolved Internal:{" "}
                    <ResolvedCell side={selectedEmployee.resolved?.internal} />
                  </div>
                  <div>
                    Resolved External:{" "}
                    <ResolvedCell side={selectedEmployee.resolved?.external} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button type="submit" loading={savingEmp} disabled={savingEmp}>
                    Save employee rates
                  </Button>
                  {selectedEmployee.hasRateRecord ? (
                    <Button
                      type="button"
                      variant="secondary"
                      loading={statusBusy === `emp:${selectedEmployee.email}`}
                      disabled={Boolean(statusBusy)}
                      onClick={toggleEmpStatus}
                    >
                      {String(selectedEmployee.status).toUpperCase() === "ACTIVE"
                        ? "Deactivate employee rates"
                        : "Activate employee rates"}
                    </Button>
                  ) : null}
                </div>
              </form>
            </div>
          ) : (
            <p style={pageSubtitle}>Select an employee to configure rates.</p>
          )}
        </>
      ) : null}
    </Layout>
  );
}

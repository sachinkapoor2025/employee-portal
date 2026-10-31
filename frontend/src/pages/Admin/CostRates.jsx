import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import Modal, { confirmDiscardIfDirty } from "../../components/ui/Modal";
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
  formatUsdRate,
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

function fallbackHint(designation, side) {
  const rate =
    side === "internal"
      ? designation?.internalHourlyRate
      : designation?.externalHourlyRate;
  const label = side === "internal" ? "internal" : "external";
  const name = designation?.name || "the linked designation";
  if (rate == null) {
    return `Unset. ${name} has no ${label} rate, so this side stays unconfigured. A blank rate is not zero.`;
  }
  return `Unset. Falls back to ${name}'s ${label} rate (${formatUsdRate(rate)}). A blank rate is not zero.`;
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
  const [desModalOpen, setDesModalOpen] = useState(false);
  const [desDirty, setDesDirty] = useState(false);
  const [editingDesId, setEditingDesId] = useState("");
  const [empForm, setEmpForm] = useState(EMPTY_EMP_FORM);
  const [empModalOpen, setEmpModalOpen] = useState(false);
  const [empDirty, setEmpDirty] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const pickerRef = useRef(null);

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

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onPointer = (event) => {
      if (!pickerRef.current?.contains(event.target)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [pickerOpen]);

  const closeDesModal = () => {
    setDesModalOpen(false);
    setDesDirty(false);
    setEditingDesId("");
    setDesForm(EMPTY_DES_FORM);
  };

  const requestCloseDes = () => {
    if (savingDes) return;
    if (!confirmDiscardIfDirty(desDirty)) return;
    closeDesModal();
  };

  const closeEmpModal = () => {
    setEmpModalOpen(false);
    setEmpDirty(false);
  };

  const startCreateDes = () => {
    setEditingDesId("");
    setDesForm(EMPTY_DES_FORM);
    setDesDirty(false);
    setDesModalOpen(true);
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
    setDesDirty(false);
    setDesModalOpen(true);
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
      }
      closeDesModal();
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
    setPickerOpen(false);
    setEmpDirty(false);
    setEmpModalOpen(true);
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

  const onPickerKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPickerOpen(true);
      setActiveIndex((current) => {
        if (!filteredEmployees.length) return -1;
        if (current < 0 || current >= filteredEmployees.length - 1) return 0;
        return current + 1;
      });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setPickerOpen(true);
      setActiveIndex((current) => {
        if (!filteredEmployees.length) return -1;
        return current <= 0 ? 0 : current - 1;
      });
      return;
    }
    if (event.key === "Escape") {
      setPickerOpen(false);
      return;
    }
    if (event.key === "Enter" && pickerOpen && filteredEmployees[activeIndex]) {
      event.preventDefault();
      selectEmployee(filteredEmployees[activeIndex]);
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
      setEmpDirty(false);
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

  const linkedDesignation = designations.find(
    (row) => row.designationId === empForm.designationId
  );
  const pageAlert = !desModalOpen && !empModalOpen;
  const activeOptionId =
    activeIndex >= 0 ? `emp-suggestion-${activeIndex}` : undefined;

  return (
    <Layout>
      <h1 style={pageTitle}>Cost Rates</h1>
      <p style={pageSubtitle}>
        Super Admin hourly rates in USD. Personalized Internal and External
        rates override the linked designation independently. A blank rate is
        unset, not zero, and falls back to the designation when that side is
        configured.
      </p>

      {pageAlert && error ? (
        <div
          className="dgv-alert dgv-alert--error"
          style={{ ...alertError, marginBottom: 16 }}
        >
          {error}
        </div>
      ) : null}
      {pageAlert && message ? (
        <div style={{ ...alertSuccess, marginBottom: 16 }}>{message}</div>
      ) : null}

      <div className="dgv-cost-rates-tabs" role="tablist" aria-label="Cost rates">
        <button
          type="button"
          role="tab"
          className="dgv-cost-rates-tab"
          aria-selected={tab === "designations"}
          onClick={() => setTab("designations")}
        >
          Designations
        </button>
        <button
          type="button"
          role="tab"
          className="dgv-cost-rates-tab"
          aria-selected={tab === "employees"}
          onClick={() => setTab("employees")}
        >
          Employees
        </button>
      </div>

      {loading ? <p>Loading cost rates…</p> : null}

      {!loading && tab === "designations" ? (
        <div style={pageCard}>
          <div className="dgv-cost-rates-head">
            <div>
              <h2>Designations</h2>
              <p className="dgv-cost-rates-note">
                Leave a rate blank to leave it unset. Do not enter 0.
              </p>
            </div>
            <Button type="button" onClick={startCreateDes}>
              + New designation
            </Button>
          </div>
          {designations.length === 0 ? (
            <p style={pageSubtitle}>No designations yet.</p>
          ) : (
            <div className="dgv-cost-rates-table-wrap">
              <table className="dgv-cost-rates-table">
                <thead>
                  <tr>
                    <th>Designation name</th>
                    <th>Internal hourly rate (USD)</th>
                    <th>External hourly rate (USD)</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {designations.map((row) => (
                    <tr key={row.designationId}>
                      <td data-label="Designation name">
                        {row.name}
                        {!row.hasConfiguredRate ? (
                          <div className="dgv-cost-rates-note">No configured rate</div>
                        ) : null}
                      </td>
                      <td data-label="Internal hourly rate (USD)">
                        {displayRateOrUnset(row.internalHourlyRate)}
                      </td>
                      <td data-label="External hourly rate (USD)">
                        {displayRateOrUnset(row.externalHourlyRate)}
                      </td>
                      <td data-label="Status">{row.status}</td>
                      <td data-label="Actions">
                        <div className="dgv-cost-rates-actions">
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => startEditDes(row)}
                          >
                            Edit
                          </Button>
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
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {!loading && tab === "employees" ? (
        <div style={pageCard}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Employees</h2>
          <p style={{ ...pageSubtitle, marginTop: 0 }}>
            Search for an employee, then set personal rates. A blank rate stays
            unset and falls back to the linked designation.
          </p>
          <label style={formLabel} htmlFor="emp-search">
            Search employees
          </label>
          <div className="dgv-cost-rates-picker" ref={pickerRef}>
            <div className="dgv-cost-rates-picker__field">
              <input
                id="emp-search"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={pickerOpen}
                aria-controls="emp-suggestions"
                aria-activedescendant={pickerOpen ? activeOptionId : undefined}
                value={employeeQuery}
                placeholder="Name, email, or employee ID"
                onChange={(event) => {
                  setEmployeeQuery(event.target.value);
                  setPickerOpen(true);
                  setActiveIndex(-1);
                }}
                onFocus={() => setPickerOpen(true)}
                onKeyDown={onPickerKeyDown}
              />
              <button
                type="button"
                className="dgv-cost-rates-picker__chevron"
                aria-label={pickerOpen ? "Hide employees" : "Show employees"}
                aria-expanded={pickerOpen}
                aria-controls="emp-suggestions"
                onClick={() => {
                  setPickerOpen((open) => !open);
                  setActiveIndex(-1);
                }}
              >
                <ChevronDown size={18} aria-hidden="true" />
              </button>
            </div>
            {pickerOpen ? (
              <ul
                id="emp-suggestions"
                role="listbox"
                aria-label="Matching employees"
                className="dgv-cost-rates-picker__list"
              >
                {filteredEmployees.length === 0 ? (
                  <li className="dgv-cost-rates-picker__meta" style={{ padding: 12 }}>
                    No matching employees
                  </li>
                ) : (
                  filteredEmployees.map((row, index) => (
                    <li key={row.email}>
                      <button
                        type="button"
                        id={`emp-suggestion-${index}`}
                        role="option"
                        aria-selected={index === activeIndex}
                        className="dgv-cost-rates-picker__option"
                        onClick={() => selectEmployee(row)}
                      >
                        <span>{row.name || row.email}</span>
                        <span className="dgv-cost-rates-picker__meta">
                          {row.email}
                          {row.empId ? ` · ${row.empId}` : ""}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      <Modal
        open={desModalOpen}
        onClose={closeDesModal}
        dirty={desDirty}
        closeDisabled={savingDes}
        title={editingDesId ? "Edit designation" : "New designation"}
        footer={
          <div className="dgv-cost-rates-actions">
            <Button
              type="submit"
              form="designation-rate-form"
              loading={savingDes}
              disabled={savingDes}
            >
              {editingDesId ? "Save designation" : "Create designation"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={requestCloseDes}
              disabled={savingDes}
            >
              Cancel
            </Button>
          </div>
        }
      >
        {error ? (
          <div
            className="dgv-alert dgv-alert--error"
            style={{ ...alertError, marginBottom: 16 }}
          >
            {error}
          </div>
        ) : null}
        <form
          id="designation-rate-form"
          className="dgv-cost-rates-form"
          onSubmit={saveDesignation}
        >
          <label style={formLabel} htmlFor="des-name">
            Designation name
            <input
              id="des-name"
              style={formInput}
              value={desForm.name}
              onChange={(event) => {
                setDesDirty(true);
                setDesForm((form) => ({ ...form, name: event.target.value }));
              }}
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
              onChange={(event) => {
                setDesDirty(true);
                setDesForm((form) => ({
                  ...form,
                  internalHourlyRate: event.target.value,
                }));
              }}
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
              onChange={(event) => {
                setDesDirty(true);
                setDesForm((form) => ({
                  ...form,
                  externalHourlyRate: event.target.value,
                }));
              }}
            />
          </label>
          <p className="dgv-cost-rates-hint">
            Leave a rate blank to leave it unset. Do not enter 0.
          </p>
        </form>
      </Modal>

      <Modal
        open={empModalOpen}
        onClose={closeEmpModal}
        dirty={empDirty}
        closeDisabled={savingEmp}
        title={selectedEmployee?.name || selectedEmployee?.email || "Employee rates"}
        maxWidth={560}
        footer={
          <div className="dgv-cost-rates-actions">
            <Button
              type="submit"
              form="employee-rate-form"
              loading={savingEmp}
              disabled={savingEmp}
            >
              Save employee rates
            </Button>
            {selectedEmployee?.hasRateRecord ? (
              <Button
                type="button"
                variant="secondary"
                loading={statusBusy === `emp:${selectedEmployee.email}`}
                disabled={Boolean(statusBusy) || savingEmp}
                onClick={toggleEmpStatus}
              >
                {String(selectedEmployee.status).toUpperCase() === "ACTIVE"
                  ? "Deactivate employee rates"
                  : "Activate employee rates"}
              </Button>
            ) : null}
          </div>
        }
      >
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
        {selectedEmployee ? (
          <>
            <p className="dgv-cost-rates-identity">
              {selectedEmployee.email}
              {selectedEmployee.empId ? ` · ${selectedEmployee.empId}` : ""}
            </p>
            <p style={pageSubtitle}>
              Profile designation (not used for costing):{" "}
              {selectedEmployee.profileDesignation || "—"}
            </p>
            <form
              id="employee-rate-form"
              className="dgv-cost-rates-form"
              onSubmit={saveEmployee}
            >
              <label style={formLabel} htmlFor="emp-des">
                Linked designation
                <select
                  id="emp-des"
                  style={formInput}
                  value={empForm.designationId}
                  onChange={(event) => {
                    setEmpDirty(true);
                    setEmpForm((form) => ({
                      ...form,
                      designationId: event.target.value,
                    }));
                  }}
                  required
                >
                  <option value="">Select designation</option>
                  {designations.map((row) => (
                    <option key={row.designationId} value={row.designationId}>
                      {row.name}
                      {String(row.status).toUpperCase() === "INACTIVE"
                        ? " (inactive)"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label style={formLabel} htmlFor="emp-internal">
                Internal hourly rate (USD)
                <input
                  id="emp-internal"
                  style={formInput}
                  inputMode="decimal"
                  placeholder="Unset"
                  value={empForm.internalHourlyRate}
                  onChange={(event) => {
                    setEmpDirty(true);
                    setEmpForm((form) => ({
                      ...form,
                      internalHourlyRate: event.target.value,
                    }));
                  }}
                />
              </label>
              {!empForm.internalHourlyRate.trim() ? (
                <p className="dgv-cost-rates-hint">
                  {fallbackHint(linkedDesignation, "internal")}
                </p>
              ) : (
                <p className="dgv-cost-rates-hint">
                  Personal internal rate. This overrides the linked designation.
                </p>
              )}
              <label style={formLabel} htmlFor="emp-external">
                External hourly rate (USD)
                <input
                  id="emp-external"
                  style={formInput}
                  inputMode="decimal"
                  placeholder="Unset"
                  value={empForm.externalHourlyRate}
                  onChange={(event) => {
                    setEmpDirty(true);
                    setEmpForm((form) => ({
                      ...form,
                      externalHourlyRate: event.target.value,
                    }));
                  }}
                />
              </label>
              {!empForm.externalHourlyRate.trim() ? (
                <p className="dgv-cost-rates-hint">
                  {fallbackHint(linkedDesignation, "external")}
                </p>
              ) : (
                <p className="dgv-cost-rates-hint">
                  Personal external rate. This overrides the linked designation.
                </p>
              )}
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
            </form>
          </>
        ) : null}
      </Modal>
    </Layout>
  );
}

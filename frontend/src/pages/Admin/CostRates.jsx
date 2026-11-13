import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import Layout from "../../components/Layout";
import CostRatesCosting from "./CostRatesCosting";
import Button from "../../components/ui/Button";
import Modal, { confirmDiscardIfDirty } from "../../components/ui/Modal";
import {
  fetchCostRateDesignations,
  fetchCostRateEmployee,
  fetchCostRateEmployees,
  fetchDepartments,
  saveCostRateEmployee,
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

function assignedCostingOptions(employee, designations) {
  const byId = new Map((designations || []).map((row) => [row.designationId, row]));
  const options = [];
  const seen = new Set();
  for (const link of employee?.departmentDesignations || []) {
    const designationId = String(link?.designationId || "").trim();
    const departmentId = String(link?.departmentId || "").trim();
    if (!designationId || !departmentId || seen.has(designationId)) continue;
    const designation = byId.get(designationId);
    if (!designation || designation.departmentId !== departmentId) continue;
    if (String(designation.status || "").toUpperCase() !== "ACTIVE") continue;
    seen.add(designationId);
    options.push(designation);
  }
  return options;
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
  const [departments, setDepartments] = useState([]);
  const [orgDepartmentId, setOrgDepartmentId] = useState("");
  const [orgTrack, setOrgTrack] = useState("");
  const [legacyReport, setLegacyReport] = useState({
    unmatched: [],
    ambiguous: [],
    pendingMatches: [],
  });
  const [employeeDepartmentId, setEmployeeDepartmentId] = useState("");
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
  const [costingTouched, setCostingTouched] = useState(false);
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
      const [desRes, empRes, departmentRes] = await Promise.all([
        fetchCostRateDesignations(),
        fetchCostRateEmployees(),
        fetchDepartments().catch(() => ({ departments: [] })),
      ]);
      setDesignations(Array.isArray(desRes?.designations) ? desRes.designations : []);
      setLegacyReport({
        unmatched: desRes?.legacyReport?.unmatched || [],
        ambiguous: desRes?.legacyReport?.ambiguous || [],
        pendingMatches: desRes?.legacyReport?.pendingMatches || [],
      });
      setEmployees(Array.isArray(empRes?.employees) ? empRes.employees : []);
      setDepartments(
        Array.isArray(departmentRes?.departments) ? departmentRes.departments : []
      );
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
    return employees.filter((row) => {
      if (employeeDepartmentId) {
        const ids = Array.isArray(row.departmentIds) ? row.departmentIds : [];
        if (!ids.includes(employeeDepartmentId)) return false;
      }
      if (!q) return true;
      const hay = `${row.email} ${row.name || ""} ${row.empId || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [employees, employeeQuery, employeeDepartmentId]);

  const departmentDesignations = useMemo(
    () =>
      designations.filter((row) => row.departmentId === orgDepartmentId),
    [designations, orgDepartmentId]
  );
  const trackOptions = useMemo(() => {
    const seen = new Map();
    departmentDesignations.forEach((row) => {
      const track = row.track || "Ungrouped";
      if (!seen.has(track)) seen.set(track, row.trackSort || 0);
    });
    return [...seen.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([track]) => track);
  }, [departmentDesignations]);
  const visibleDesignations = useMemo(
    () =>
      departmentDesignations
        .filter((row) => (row.track || "Ungrouped") === orgTrack)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)),
    [departmentDesignations, orgTrack]
  );

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
      internalHourlyRate: internal.value,
      externalHourlyRate: external.value,
    };
    try {
      if (!editingDesId) {
        setError("Designations are created on the Department page.");
        return;
      }
      await updateCostRateDesignation(editingDesId, payload);
      setMessage("Designation updated.");
      closeDesModal();
      await load({ silent: true });
    } catch (err) {
      setError(err?.message || "Unable to save designation.");
    } finally {
      setSavingDes(false);
    }
  };

  const selectEmployee = async (row) => {
    setError("");
    setMessage("");
    setPickerOpen(false);
    setEmpDirty(false);
    setCostingTouched(false);
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
      setCostingTouched(false);
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
    const assigned = assignedCostingOptions(selectedEmployee, designations);
    const storedId = String(selectedEmployee?.designationId || "");
    let designationId = empForm.designationId;
    if (!costingTouched && !designationId && assigned.length === 1 && !storedId) {
      designationId = assigned[0].designationId;
    }
    if (!designationId && !costingTouched) {
      setError(
        storedId
          ? "Choose an assigned costing designation or clear it."
          : "Select which assigned designation is used for costing, or clear it."
      );
      return;
    }
    if (
      designationId &&
      !assigned.some((row) => row.designationId === designationId)
    ) {
      setError("Costing designation must be an active designation assigned to this employee.");
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
        designationId,
        internalHourlyRate: internal.value,
        externalHourlyRate: external.value,
      });
      setMessage("Employee rates saved.");
      setEmpDirty(false);
      setCostingTouched(false);
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

  const assignedOptions = assignedCostingOptions(selectedEmployee, designations);
  const linkedDesignation =
    assignedOptions.find((row) => row.designationId === empForm.designationId) ||
    designations.find((row) => row.designationId === empForm.designationId);
  const storedCostingMissing =
    Boolean(selectedEmployee?.designationId) &&
    !assignedOptions.some((row) => row.designationId === selectedEmployee.designationId);
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
        <button
          type="button"
          role="tab"
          className="dgv-cost-rates-tab"
          aria-selected={tab === "costing"}
          onClick={() => setTab("costing")}
        >
          Costing
        </button>
      </div>

      {loading ? <p>Loading cost rates…</p> : null}

      {!loading && tab === "designations" ? (
        <div style={pageCard}>
          <div className="dgv-cost-rates-head">
            <div>
              <h2>Department designations</h2>
              <p className="dgv-cost-rates-note">
                Choose a department, then a track. Rates can be entered only for
                designations that already exist on the Department page.
              </p>
            </div>
          </div>
          <label style={formLabel} htmlFor="org-department">
            Department
            <select
              id="org-department"
              style={formInput}
              value={orgDepartmentId}
              onChange={(event) => {
                setOrgDepartmentId(event.target.value);
                setOrgTrack("");
              }}
            >
              <option value="">Select a department</option>
              {departments.map((row) => (
                <option key={row.departmentId} value={row.departmentId}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label style={formLabel} htmlFor="org-track">
            Track
            <select
              id="org-track"
              style={formInput}
              value={orgTrack}
              onChange={(event) => setOrgTrack(event.target.value)}
              disabled={!orgDepartmentId}
            >
              <option value="">Select a track</option>
              {trackOptions.map((track) => (
                <option key={track} value={track}>
                  {track}
                </option>
              ))}
            </select>
          </label>
          {!orgDepartmentId || !orgTrack ? (
            <p style={pageSubtitle}>
              Select a department and track to see its designations.
            </p>
          ) : visibleDesignations.length === 0 ? (
            <p style={pageSubtitle}>
              This track has no designations. Add them on the Department page.
            </p>
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
                  {visibleDesignations.map((row) => (
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
                        {String(row.status).toUpperCase() === "ACTIVE" ? (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => startEditDes(row)}
                          >
                            Edit rate
                          </Button>
                        ) : (
                          <span className="dgv-cost-rates-note">
                            Retired on the Department page
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {legacyReport.unmatched.length ||
          legacyReport.ambiguous.length ||
          legacyReport.pendingMatches.length ? (
            <div style={{ marginTop: 16 }}>
              <h3>Legacy costing rows</h3>
              <p className="dgv-cost-rates-note">
                These older costing designations are not edited here. A shared
                name is not treated as the same designation. Review each row
                and choose the employee’s assigned designation manually.
              </p>
              <ul>
                {legacyReport.pendingMatches.map((row) => (
                  <li key={row.designationId}>
                    {row.name}: {row.reason || row.action}
                  </li>
                ))}
                {legacyReport.ambiguous.map((row) => (
                  <li key={row.designationId}>
                    {row.name}: {row.reason}
                  </li>
                ))}
                {legacyReport.unmatched.map((row) => (
                  <li key={row.designationId}>
                    {row.name}: {row.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {!loading && tab === "costing" ? (
        <div style={pageCard}>
          <CostRatesCosting />
        </div>
      ) : null}

      {!loading && tab === "employees" ? (
        <div style={pageCard}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Employees</h2>
          <p style={{ ...pageSubtitle, marginTop: 0 }}>
            Choose a department, then search employees in that department.
            Personal rates still override the linked costing designation.
          </p>
          <label style={formLabel} htmlFor="employee-department">
            Department
            <select
              id="employee-department"
              style={formInput}
              value={employeeDepartmentId}
              onChange={(event) => setEmployeeDepartmentId(event.target.value)}
            >
              <option value="">All departments</option>
              {departments.map((row) => (
                <option key={row.departmentId} value={row.departmentId}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
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
        title="Edit designation"
        footer={
          <div className="dgv-cost-rates-actions">
            <Button
              type="submit"
              form="designation-rate-form"
              loading={savingDes}
              disabled={savingDes}
            >
              Save designation
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
              readOnly
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
            <p style={pageSubtitle}>
              Departments:{" "}
              {(selectedEmployee.departmentIds || [])
                .map(
                  (id) =>
                    departments.find((row) => row.departmentId === id)?.name || id
                )
                .join(", ") || "—"}
              {(selectedEmployee.departmentDesignations || []).length
                ? ` · Assigned: ${selectedEmployee.departmentDesignations
                    .map((row) => {
                      const match = designations.find(
                        (item) => item.designationId === row.designationId
                      );
                      const departmentName =
                        departments.find((item) => item.departmentId === row.departmentId)
                          ?.name || row.departmentId;
                      return `${departmentName} · ${match?.track || "Track not set"} · ${
                        match?.name || row.designationId
                      }`;
                    })
                    .join("; ")}`
                : ""}
            </p>
            <form
              id="employee-rate-form"
              className="dgv-cost-rates-form"
              onSubmit={saveEmployee}
            >
              {storedCostingMissing && !costingTouched ? (
                <p className="dgv-cost-rates-hint">
                  The current costing designation is no longer an active assignment.
                  Choose an assigned designation or clear it.
                </p>
              ) : null}
              <label style={formLabel} htmlFor="emp-des">
                Costing designation
                <select
                  id="emp-des"
                  style={formInput}
                  value={
                    assignedOptions.some((row) => row.designationId === empForm.designationId)
                      ? empForm.designationId
                      : empForm.designationId
                        ? "__needs-choice"
                        : ""
                  }
                  onChange={(event) => {
                    if (event.target.value === "__needs-choice") return;
                    setEmpDirty(true);
                    setCostingTouched(true);
                    setEmpForm((form) => ({
                      ...form,
                      designationId: event.target.value,
                    }));
                  }}
                >
                  <option value="">
                    {assignedOptions.length
                      ? "Clear costing designation"
                      : "No assigned designation"}
                  </option>
                  {empForm.designationId &&
                  !assignedOptions.some((row) => row.designationId === empForm.designationId) ? (
                    <option value="__needs-choice">Choose an assigned designation</option>
                  ) : null}
                  {assignedOptions.map((row) => (
                    <option key={row.designationId} value={row.designationId}>
                      {departments.find((item) => item.departmentId === row.departmentId)?.name ||
                        row.departmentId}
                      {" · "}
                      {row.track ? `${row.track} · ` : ""}
                      {row.name}
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

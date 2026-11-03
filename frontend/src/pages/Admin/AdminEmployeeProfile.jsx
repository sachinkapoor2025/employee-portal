import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import {
  fetchUsers,
  fetchSkills,
  fetchUserProfile,
  fetchDepartments,
  fetchDepartmentDesignations,
  fetchEmployeeDepartments,
  saveUserProfile,
  updateUserRole,
  fetchShifts,
  fetchEmployeeShift,
  assignEmployeeShift,
} from "../../services/api";
import { normalizeRole, roleLabel, roleOptionsForActor, canAssignPortalRole, canManageProjectDocuments, resolveActorRoleFromUsers } from "../../constants/roles";
import { getLoggedInEmail, PORTAL_ROLE_KEY } from "../../services/auth";
import { alertSuccess, alertError } from "../../theme";
import { summarizeDepartments } from "../../utils/departmentMembership";

const emptyForm = {
  email: "",
  name: "",
  empId: "",
  department: "",
  departmentIds: [],
  primaryDepartmentId: "",
  departmentDesignations: [],
  costingDesignationId: "",
  designation: "",
  skill: "",
  manager: "",
  groupLead: "",
  phone: "",
  doj: "",
  role: "EMPLOYEE",
  status: "",
};

function displayValue(value) {
  const text = String(value ?? "").trim();
  return text || "—";
}

function shiftLabel(shift) {
  if (!shift?.name) return "";
  const overnight = shift.crossesMidnight ? " · overnight" : "";
  return `${shift.name} (${shift.startTime} – ${shift.endTime}${overnight})`;
}

function profileInitials(name, email) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  if (parts[0]?.length >= 2) return parts[0].slice(0, 2).toUpperCase();
  if (parts[0]) return parts[0][0].toUpperCase();
  const local = String(email || "")
    .split("@")[0]
    .replace(/[^a-zA-Z0-9]/g, "");
  return (local.slice(0, 2) || "?").toUpperCase();
}

function skillLabel(skills, code) {
  const found = (skills || []).find((s) => s.code === code);
  return found?.name || code || "";
}

function designationChoice(links, departmentId) {
  const found = (links || []).find((row) => row.departmentId === departmentId);
  return found?.designationId || "";
}

function activeAssignedPairs(links, designationsByDepartment) {
  const pairs = [];
  const seen = new Set();
  for (const link of links || []) {
    const departmentId = String(link?.departmentId || "").trim();
    const designationId = String(link?.designationId || "").trim();
    if (!departmentId || !designationId || seen.has(designationId)) continue;
    const designation = (designationsByDepartment?.[departmentId] || []).find(
      (row) => row.designationId === designationId
    );
    if (!designation || String(designation.status || "").toUpperCase() !== "ACTIVE") continue;
    if (designation.departmentId && designation.departmentId !== departmentId) continue;
    seen.add(designationId);
    pairs.push({ departmentId, designationId, designation });
  }
  return pairs;
}

function DepartmentMembership({
  editing,
  draft,
  profile,
  departments,
  designationsByDepartment,
  departmentError,
  onToggle,
  onPrimary,
  onDesignation,
  costingDesignationId,
  onCostingDesignation,
  canEditCosting,
}) {
  const source = editing ? draft : profile;
  const summary = summarizeDepartments(source, departments);
  const selected = new Set(summary.memberships.map((row) => row.departmentId));
  const known = new Map((departments || []).map((row) => [row.departmentId, row]));
  for (const row of summary.memberships) {
    if (!known.has(row.departmentId)) known.set(row.departmentId, row);
  }
  const choices = [...known.values()].filter(
    (row) =>
      String(row.status || "").toUpperCase() === "ACTIVE" ||
      selected.has(row.departmentId)
  );

  if (!editing) {
    if (!summary.memberships.length && !summary.legacyUnmatched) {
      return <div className="dgv-profile-value">—</div>;
    }
    return (
      <div className="dgv-profile-value">
        {summary.memberships.map((row) => {
          const designationId = designationChoice(
            source.departmentDesignations,
            row.departmentId
          );
          const options = designationsByDepartment?.[row.departmentId] || [];
          const designation = options.find((item) => item.designationId === designationId);
          return (
            <div key={row.departmentId}>
              {row.name}
              {row.departmentId === summary.primaryDepartmentId ? " · Primary" : ""}
              {String(row.status).toUpperCase() === "ACTIVE" ? "" : " · Inactive"}
              {designationId
                ? ` · ${designation?.track ? `${designation.track} · ` : ""}${
                    designation?.name || designationId
                  }${
                    designation && String(designation.status).toUpperCase() !== "ACTIVE"
                      ? " (inactive designation)"
                      : ""
                  }`
                : ""}
            </div>
          );
        })}
        {summary.legacyUnmatched ? (
          <div>Legacy unmatched: {summary.legacyUnmatched}</div>
        ) : null}
        <div>
          Costing designation:{" "}
          {(() => {
            const pairs = activeAssignedPairs(
              source.departmentDesignations,
              designationsByDepartment
            );
            const current = pairs.find((row) => row.designationId === costingDesignationId);
            if (!current) return costingDesignationId ? "Needs a choice" : "—";
            return `${current.designation.track ? `${current.designation.track} · ` : ""}${
              current.designation.name
            }`;
          })()}
        </div>
      </div>
    );
  }

  return (
    <div>
      {departmentError ? (
        <div className="dgv-profile-value">{departmentError}</div>
      ) : null}
      {choices.length === 0 ? (
        <div className="dgv-profile-value">No departments available.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {choices.map((row) => {
            const checked = selected.has(row.departmentId);
            const inactive = String(row.status || "").toUpperCase() !== "ACTIVE";
            return (
              <div key={row.departmentId}>
                <label style={{ display: "flex", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(row.departmentId)}
                  />
                  <span>
                    {row.name}
                    {inactive ? " (inactive)" : ""}
                  </span>
                </label>
                {checked ? (
                  <DesignationSelect
                    department={row}
                    options={designationsByDepartment?.[row.departmentId] || []}
                    value={designationChoice(source.departmentDesignations, row.departmentId)}
                    onChange={(designationId) => onDesignation(row.departmentId, designationId)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {summary.memberships.length > 1 ? (
        <label style={{ display: "grid", gap: 4, marginTop: 8 }} htmlFor="admin-profile-primary-department">
          Primary department
          <select
            id="admin-profile-primary-department"
            value={summary.primaryDepartmentId}
            onChange={(event) => onPrimary(event.target.value)}
          >
            {summary.memberships.map((row) => (
              <option key={row.departmentId} value={row.departmentId}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {summary.legacyUnmatched ? (
        <div className="dgv-profile-value" style={{ marginTop: 8 }}>
          Legacy unmatched: {summary.legacyUnmatched}
        </div>
      ) : null}
      {canEditCosting ? (
        <CostingDesignationSelect
          links={source.departmentDesignations}
          designationsByDepartment={designationsByDepartment}
          departments={departments}
          value={costingDesignationId}
          onChange={onCostingDesignation}
        />
      ) : null}
    </div>
  );
}

function CostingDesignationSelect({
  links,
  designationsByDepartment,
  departments,
  value,
  onChange,
}) {
  const pairs = activeAssignedPairs(links, designationsByDepartment);
  const names = new Map((departments || []).map((row) => [row.departmentId, row.name]));
  return (
    <label style={{ display: "grid", gap: 4, marginTop: 8 }} htmlFor="admin-profile-costing-designation">
      Costing designation
      <select
        id="admin-profile-costing-designation"
        value={
          pairs.some((row) => row.designationId === value)
            ? value
            : value
              ? "__needs-choice"
              : ""
        }
        onChange={(event) => {
          if (event.target.value === "__needs-choice") return;
          onChange(event.target.value);
        }}
      >
        <option value="">
          {pairs.length ? "Clear costing designation" : "No assigned designation"}
        </option>
        {value && !pairs.some((row) => row.designationId === value) ? (
          <option value="__needs-choice">Choose an assigned designation</option>
        ) : null}
        {pairs.map((row) => (
          <option key={row.designationId} value={row.designationId}>
            {`${names.get(row.departmentId) || row.departmentId} · ${
              row.designation.track ? `${row.designation.track} · ` : ""
            }${row.designation.name}`}
          </option>
        ))}
      </select>
    </label>
  );
}

function DesignationSelect({ department, options, value, onChange }) {
  const visible = options.filter(
    (row) => String(row.status || "").toUpperCase() === "ACTIVE" || row.designationId === value
  );
  return (
    <label style={{ display: "grid", gap: 4, margin: "4px 0 8px 24px" }}>
      Designation for {department.name}
      <select
        aria-label={`Designation for ${department.name}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">
          {visible.length ? "No designation selected" : "No designations defined yet"}
        </option>
        {visible.map((row) => (
          <option key={row.designationId} value={row.designationId}>
            {row.track ? `${row.track} · ` : ""}
            {row.sortOrder ? `${row.sortOrder}. ` : ""}
            {row.name}
            {String(row.status).toUpperCase() === "ACTIVE" ? "" : " (inactive)"}
          </option>
        ))}
      </select>
    </label>
  );
}

function Field({ label, htmlFor, children }) {
  return (
    <div className="dgv-profile-item">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

export default function AdminEmployeeProfile() {
  const navigate = useNavigate();
  const { email: emailParam } = useParams();
  const [searchParams] = useSearchParams();
  const isCreate = !emailParam;
  const lookupEmail = String(emailParam || "")
    .trim()
    .toLowerCase();

  const [loading, setLoading] = useState(!isCreate);
  const [skills, setSkills] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [departmentError, setDepartmentError] = useState("");
  const [membershipKnown, setMembershipKnown] = useState(isCreate);
  const [costingTouched, setCostingTouched] = useState(false);
  const [designationsByDepartment, setDesignationsByDepartment] = useState({});
  const [profile, setProfile] = useState(emptyForm);
  const [draft, setDraft] = useState(emptyForm);
  const [editing, setEditing] = useState(isCreate || searchParams.get("edit") === "1");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [actorRole, setActorRole] = useState(
    typeof localStorage !== "undefined"
      ? localStorage.getItem(PORTAL_ROLE_KEY) || ""
      : ""
  );
  const [assignedShift, setAssignedShift] = useState(null);
  const [shiftOptions, setShiftOptions] = useState([]);
  const [selectedShiftId, setSelectedShiftId] = useState("");
  const [shiftSaving, setShiftSaving] = useState(false);
  const [shiftError, setShiftError] = useState("");
  const [activeTasks, setActiveTasks] = useState([]);
  const [shiftCatalogError, setShiftCatalogError] = useState("");

  const storedPortalRole = () =>
    typeof localStorage !== "undefined"
      ? localStorage.getItem(PORTAL_ROLE_KEY) || ""
      : "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [data, departmentRes] = await Promise.all([
          fetchSkills(),
          fetchDepartments(),
        ]);
        if (cancelled) return;
        setSkills(Array.isArray(data) ? data : []);
        setDepartments(
          Array.isArray(departmentRes?.departments) ? departmentRes.departments : []
        );
        setDepartmentError("");
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setDepartmentError(err?.message || "Unable to load departments.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isCreate) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchUsers();
        if (cancelled) return;
        setActorRole(
          resolveActorRoleFromUsers(
            Array.isArray(list) ? list : [],
            getLoggedInEmail(),
            storedPortalRole()
          )
        );
      } catch {
        /* keep session fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isCreate]);

  const loadEmployee = async () => {
    setLoading(true);
    setError("");
    try {
      const [data, users, membershipResult, shiftResult, catalogResult] = await Promise.all([
        fetchUserProfile(lookupEmail),
        fetchUsers().catch(() => []),
        fetchEmployeeDepartments(lookupEmail)
          .then((res) => ({ ok: true, res }))
          .catch(() => ({ ok: false })),
        fetchEmployeeShift(lookupEmail)
          .then((res) => ({ ok: true, res }))
          .catch((err) => ({ ok: false, err })),
        fetchShifts()
          .then((res) => ({ ok: true, res }))
          .catch((err) => ({ ok: false, err })),
      ]);
      const row = (Array.isArray(users) ? users : []).find(
        (u) => String(u.email || "").toLowerCase() === lookupEmail
      );
      setActorRole(
        resolveActorRoleFromUsers(
          Array.isArray(users) ? users : [],
          getLoggedInEmail(),
          storedPortalRole()
        )
      );
      const next = {
        email: lookupEmail,
        name: data?.name || row?.name || "",
        empId: data?.empId || row?.empId || "",
        department: data?.department || row?.department || "",
        departmentIds: Array.isArray(data?.departmentIds)
          ? data.departmentIds
          : Array.isArray(row?.departmentIds)
            ? row.departmentIds
            : [],
        primaryDepartmentId:
          data?.primaryDepartmentId || row?.primaryDepartmentId || "",
        departmentDesignations: Array.isArray(data?.departmentDesignations)
          ? data.departmentDesignations
          : [],
        costingDesignationId: membershipResult.ok
          ? membershipResult.res?.membership?.costingDesignationId || ""
          : "",
        designation: data?.designation || row?.designation || "",
        skill: data?.skill || row?.skill || "",
        manager: data?.manager || row?.manager || "",
        groupLead: data?.groupLead || row?.groupLead || "",
        phone: data?.phone || row?.phone || "",
        doj: data?.doj || row?.doj || "",
        role: normalizeRole(row?.role || data?.role || "EMPLOYEE"),
        status: row?.status || data?.status || "",
      };
      setProfile(next);
      setDraft(next);
      setCostingTouched(false);
      setMembershipKnown(Array.isArray(data?.departmentIds));
      const current = shiftResult.ok ? shiftResult.res?.shift || null : null;
      setAssignedShift(current);
      const catalog = catalogResult.ok
        ? Array.isArray(catalogResult.res?.shifts)
          ? catalogResult.res.shifts
          : []
        : [];
      const activeOptions = catalog.filter(
        (s) => String(s.status).toUpperCase() === "ACTIVE"
      );
      if (
        current?.shiftId &&
        !activeOptions.some((s) => s.shiftId === current.shiftId)
      ) {
        activeOptions.unshift({
          ...current,
          status: current.status || "INACTIVE",
        });
      }
      setShiftOptions(activeOptions);
      setSelectedShiftId(current?.shiftId || "");
      setActiveTasks([]);
      setShiftError("");
      const loadNotes = [];
      if (!shiftResult.ok) {
        loadNotes.push(
          shiftResult.err?.message || "Unable to load the assigned shift."
        );
      }
      if (!catalogResult.ok) {
        loadNotes.push(
          catalogResult.err?.message || "Unable to load available shifts."
        );
      }
      setShiftCatalogError(loadNotes.join(" "));
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to load profile");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isCreate) loadEmployee();
    // loadEmployee is recreated each render; only refetch when the employee changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupEmail, isCreate]);

  const updateDraft = (key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const toggleDepartment = (departmentId) => {
    setMembershipKnown(true);
    setDraft((prev) => {
      const current = Array.isArray(prev.departmentIds) ? prev.departmentIds : [];
      const next = current.includes(departmentId)
        ? current.filter((id) => id !== departmentId)
        : [...current, departmentId];
      let primary = prev.primaryDepartmentId || "";
      if (!next.includes(primary)) primary = next[0] || "";
      const departmentDesignations = (prev.departmentDesignations || []).filter((row) =>
        next.includes(row.departmentId)
      );
      return {
        ...prev,
        departmentIds: next,
        primaryDepartmentId: primary,
        departmentDesignations,
      };
    });
  };

  const startEdit = () => {
    setDraft(profile);
    setEditing(true);
    setMessage("");
    setError("");
  };

  const cancelEdit = () => {
    if (isCreate) {
      navigate("/admin/employees");
      return;
    }
    setDraft(profile);
    setEditing(false);
    setError("");
  };

  const setCostingDesignation = (designationId) => {
    setCostingTouched(true);
    setDraft((prev) => ({ ...prev, costingDesignationId: designationId }));
  };

  const setDepartmentDesignation = (departmentId, designationId) => {
    setMembershipKnown(true);
    setDraft((prev) => {
      const rest = (prev.departmentDesignations || []).filter(
        (row) => row.departmentId !== departmentId
      );
      return {
        ...prev,
        departmentDesignations: designationId
          ? [...rest, { departmentId, designationId }]
          : rest,
      };
    });
  };

  const selectedDepartmentKey = (editing ? draft.departmentIds : profile.departmentIds || [])
    .join("|");

  useEffect(() => {
    const ids = selectedDepartmentKey ? selectedDepartmentKey.split("|") : [];
    if (!ids.length) {
      setDesignationsByDepartment({});
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const res = await fetchDepartmentDesignations(id);
            return [id, Array.isArray(res?.designations) ? res.designations : []];
          } catch (err) {
            console.error(err);
            return [id, []];
          }
        })
      );
      if (!cancelled) setDesignationsByDepartment(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDepartmentKey]);

  const saveEdit = async () => {
    const email = String(draft.email || profile.email || "")
      .trim()
      .toLowerCase();

    if (!email || !draft.skill) {
      setError("Email and Skill are required");
      return;
    }
    if (!email.endsWith("@mydgv.com")) {
      setError("Only @mydgv.com email addresses are allowed.");
      return;
    }

    const managesAssignments = canManageProjectDocuments(actorRole);
    const assignmentLinks = (draft.departmentDesignations || []).filter((row) =>
      (draft.departmentIds || []).includes(row.departmentId)
    );
    const assignedPairs = activeAssignedPairs(assignmentLinks, designationsByDepartment);
    let costingField;
    if (managesAssignments && (isCreate || membershipKnown)) {
      const current = String(draft.costingDesignationId || "");
      const currentIsAssigned = assignedPairs.some((row) => row.designationId === current);
      if (costingTouched) {
        costingField = { costingDesignationId: current };
      } else if (!current && assignedPairs.length > 1) {
        setError("Select which assigned designation is used for costing, or clear it.");
        return;
      } else if (current && !currentIsAssigned) {
        setError("Choose an assigned costing designation or clear it.");
        return;
      }
    }

    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await saveUserProfile({
        mode: isCreate ? "CREATE" : "EDIT",
        email,
        role: normalizeRole(draft.role),
        profile: {
          email,
          name: draft.name || "",
          empId: draft.empId || "",
          ...(managesAssignments && (isCreate || membershipKnown)
            ? {
                departmentIds: Array.isArray(draft.departmentIds)
                  ? draft.departmentIds
                  : [],
                primaryDepartmentId: draft.primaryDepartmentId || "",
                departmentDesignations: assignmentLinks,
                ...costingField,
              }
            : {}),
          designation: draft.designation || "",
          skill: draft.skill || "",
          manager: draft.manager || "",
          groupLead: draft.groupLead || "",
          phone: draft.phone || "",
          doj: draft.doj || "",
        },
      });

      if (!isCreate) {
        const nextRole = normalizeRole(draft.role);
        if (
          nextRole !== normalizeRole(profile.role) &&
          canAssignPortalRole(actorRole, nextRole)
        ) {
          await updateUserRole(email, nextRole);
        }
      }

      if (result?.temporaryPassword) {
        alert(
          `Employee created successfully.\n\nTemporary password:\n${result.temporaryPassword}\n\nShare this with the employee.`
        );
      } else if (result?.warning) {
        alert(result.warning);
      }

      if (isCreate) {
        navigate(`/admin/employees/${encodeURIComponent(email)}`);
        return;
      }

      setEditing(false);
      await loadEmployee();
      setMessage("Employee updated.");
    } catch (err) {
      console.error(err);
      setError(err?.message || "Failed to save employee.");
    } finally {
      setSaving(false);
    }
  };

  const saveShift = async () => {
    if (!lookupEmail || !selectedShiftId) {
      setShiftError("Select a shift to assign.");
      return;
    }
    setShiftSaving(true);
    setShiftError("");
    setActiveTasks([]);
    setMessage("");
    try {
      const res = await assignEmployeeShift(lookupEmail, { shiftId: selectedShiftId });
      setAssignedShift(res?.shift || null);
      setMessage(
        res?.unchanged
          ? "This employee is already on that shift."
          : "Employee shift updated."
      );
    } catch (err) {
      setShiftError(err?.message || "Unable to assign shift.");
      setActiveTasks(Array.isArray(err?.activeTasks) ? err.activeTasks : []);
    } finally {
      setShiftSaving(false);
    }
  };

  const shown = editing ? draft : profile;
  const email = shown.email || lookupEmail;

  const renderValue = (value) => (
    <div className="dgv-profile-value">{displayValue(value)}</div>
  );

  const renderInput = (key, opts = {}) => (
    <input
      id={`admin-profile-${key}`}
      type={opts.type || "text"}
      disabled={opts.disabled}
      value={draft[key] || ""}
      placeholder={opts.placeholder}
      onChange={(e) => updateDraft(key, e.target.value)}
    />
  );

  if (loading) {
    return (
      <Layout>
        <div className="dgv-profile-page">
          <p className="dgv-profile-loading">Loading employee…</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className={`dgv-profile-page${editing ? " is-editing" : ""}`}>
        <nav className="dgv-profile-crumb">
          <button type="button" onClick={() => navigate("/admin/employees")}>
            ← Employees
          </button>
          <span>→</span>
          <span>{isCreate ? "Add Employee" : "Employee Profile"}</span>
        </nav>

        <div className="dgv-profile-page-header">
          <div>
            <h1>{isCreate ? "Add Employee" : "Employee Profile"}</h1>
            <p>
              {isCreate
                ? "Create a new employee account"
                : editing
                  ? "Editing employee information"
                  : "Employee information and account details"}
            </p>
            {editing && !isCreate ? (
              <span className="dgv-profile-editing-dot">
                <i /> Editing
              </span>
            ) : null}
          </div>
          <div className="dgv-profile-page-actions">
            {editing ? (
              <>
                <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={saveEdit} loading={saving}>
                  Save Changes
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  onClick={() =>
                    navigate(
                      `/admin/employees/${encodeURIComponent(email)}/track`
                    )
                  }
                >
                  Track
                </Button>
                <Button onClick={startEdit}>Edit Employee</Button>
              </>
            )}
          </div>
        </div>

        {message ? (
          <div style={{ ...alertSuccess, marginTop: 0, marginBottom: 16 }}>
            {message}
          </div>
        ) : null}
        {error ? (
          <div style={{ ...alertError, marginTop: 0, marginBottom: 16 }}>
            {error}
          </div>
        ) : null}

        <section className="dgv-profile-card dgv-profile-identity">
          <div className="dgv-profile-avatar-wrap">
            <div className="dgv-profile-avatar" aria-hidden="true">
              <span>{profileInitials(shown.name, email)}</span>
            </div>
          </div>
          <div className="dgv-profile-identity__body">
            <h2>{displayValue(shown.name)}</h2>
            <p className="dgv-profile-role">
              {displayValue(shown.designation)} · Employee ID:{" "}
              {displayValue(shown.empId)}
            </p>
            <p className="dgv-profile-email">{displayValue(email)}</p>
            <p className="dgv-profile-reports">
              Manager: {displayValue(shown.manager)} · Group Lead:{" "}
              {displayValue(shown.groupLead)}
            </p>
          </div>
        </section>

        <section className="dgv-profile-block">
          <h2>Personal Information</h2>
          <p className="dgv-profile-section-desc">
            Basic employee identification and contact details
          </p>
          <div className="dgv-profile-card">
            <div className="dgv-profile-grid">
              <Field label="Full Name" htmlFor={editing ? "admin-profile-name" : undefined}>
                {editing ? renderInput("name") : renderValue(profile.name)}
              </Field>
              <Field label="Employee ID" htmlFor={editing ? "admin-profile-empId" : undefined}>
                {editing ? renderInput("empId", { placeholder: "DGV001" }) : renderValue(profile.empId)}
              </Field>
              <Field label="Email" htmlFor={editing ? "admin-profile-email" : undefined}>
                {editing
                  ? renderInput("email", {
                      disabled: !isCreate,
                      placeholder: "name@mydgv.com",
                    })
                  : renderValue(profile.email)}
              </Field>
              <Field label="Phone" htmlFor={editing ? "admin-profile-phone" : undefined}>
                {editing ? renderInput("phone") : renderValue(profile.phone)}
              </Field>
            </div>
          </div>
        </section>

        <section className="dgv-profile-block">
          <h2>Work Information</h2>
          <p className="dgv-profile-section-desc">
            Role, department, skills and reporting structure
          </p>
          <div className="dgv-profile-card">
            <div className="dgv-profile-grid">
              <Field label="Departments">
                <DepartmentMembership
                  editing={editing}
                  draft={draft}
                  profile={profile}
                  departments={departments}
                  departmentError={departmentError}
                  designationsByDepartment={designationsByDepartment}
                  onToggle={toggleDepartment}
                  onDesignation={setDepartmentDesignation}
                  costingDesignationId={(editing ? draft : profile).costingDesignationId}
                  onCostingDesignation={setCostingDesignation}
                  canEditCosting={canManageProjectDocuments(actorRole)}
                  onPrimary={(departmentId) => {
                    setMembershipKnown(true);
                    updateDraft("primaryDepartmentId", departmentId);
                  }}
                />
              </Field>
              <Field label="Designation" htmlFor={editing ? "admin-profile-designation" : undefined}>
                {editing ? renderInput("designation") : renderValue(profile.designation)}
              </Field>
              <Field label="Skill" htmlFor={editing ? "admin-profile-skill" : undefined}>
                {editing ? (
                  <select
                    id="admin-profile-skill"
                    value={draft.skill || ""}
                    onChange={(e) => updateDraft("skill", e.target.value)}
                  >
                    <option value="">Select Skill</option>
                    {skills.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  renderValue(skillLabel(skills, profile.skill))
                )}
              </Field>
              <Field label="Manager" htmlFor={editing ? "admin-profile-manager" : undefined}>
                {editing ? renderInput("manager") : renderValue(profile.manager)}
              </Field>
              <Field label="Group Lead" htmlFor={editing ? "admin-profile-groupLead" : undefined}>
                {editing ? renderInput("groupLead") : renderValue(profile.groupLead)}
              </Field>
              <Field label="Date of Joining" htmlFor={editing ? "admin-profile-doj" : undefined}>
                {editing ? renderInput("doj", { type: "date" }) : renderValue(profile.doj)}
              </Field>
            </div>
          </div>
        </section>

        {!isCreate ? (
          <section className="dgv-profile-block">
            <h2>Assigned Shift</h2>
            <p className="dgv-profile-section-desc">
              Assign an active company shift. If this employee has open tasks,
              complete or reassign those tasks before changing the shift.
            </p>
            <div className="dgv-profile-card">
              {shiftCatalogError ? (
                <div style={{ ...alertError, marginTop: 0, marginBottom: 16 }}>
                  {shiftCatalogError}
                </div>
              ) : null}
              <div className="dgv-profile-grid">
                <Field label="Current shift">
                  {renderValue(
                    assignedShift ? shiftLabel(assignedShift) : "Not assigned"
                  )}
                </Field>
                <Field label="New shift" htmlFor="admin-profile-shift">
                  <select
                    id="admin-profile-shift"
                    value={selectedShiftId}
                    onChange={(e) => setSelectedShiftId(e.target.value)}
                    disabled={shiftSaving}
                  >
                    <option value="">Select shift</option>
                    {shiftOptions.map((s) => (
                      <option key={s.shiftId} value={s.shiftId}>
                        {shiftLabel(s)}
                        {String(s.status || "").toUpperCase() === "INACTIVE"
                          ? " (inactive)"
                          : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div style={{ marginTop: 12 }}>
                <Button
                  onClick={saveShift}
                  loading={shiftSaving}
                  disabled={
                    !selectedShiftId ||
                    selectedShiftId === assignedShift?.shiftId
                  }
                >
                  Assign Shift
                </Button>
              </div>
              {shiftError || activeTasks.length ? (
                <div style={{ ...alertError, marginTop: 16, marginBottom: 0 }}>
                  <div>
                    {shiftError ||
                      "This employee's shift cannot be changed while they have active tasks."}
                  </div>
                  {activeTasks.length ? (
                    <>
                      <p style={{ margin: "8px 0 6px" }}>
                        Complete or reassign these tasks first:
                      </p>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {activeTasks.map((task) => (
                          <li key={task.taskId}>
                            <Link
                              to={`/admin/tasks/${encodeURIComponent(task.taskId)}`}
                            >
                              {task.title || task.taskId}
                            </Link>
                            {task.status ? ` · ${task.status}` : ""}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        <section className="dgv-profile-block">
          <h2>Account / Access Information</h2>
          <p className="dgv-profile-section-desc">
            Existing administrative controls already available to Admin
          </p>
          <div className="dgv-profile-card">
            <div className="dgv-profile-grid">
              <Field label="Role" htmlFor={editing ? "admin-profile-role" : undefined}>
                {editing ? (
                  <select
                    id="admin-profile-role"
                    value={normalizeRole(draft.role)}
                    onChange={(e) => updateDraft("role", e.target.value)}
                  >
                    {roleOptionsForActor(actorRole, draft.role).map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  renderValue(roleLabel(profile.role))
                )}
              </Field>
              <Field label="Status">
                {renderValue(shown.status)}
              </Field>
            </div>
          </div>
        </section>
      </div>
    </Layout>
  );
}

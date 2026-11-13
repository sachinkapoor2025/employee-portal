import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import {
  fetchUsers,
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
import {
  buildSavedAssignments,
  departmentChoices,
  designationsInTrack,
  tracksInDepartment,
} from "../../utils/departmentAssignment";

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

function assignmentRows(source, departments, designationsByDepartment) {
  const summary = summarizeDepartments(source, departments);
  return summary.memberships.map((row) => {
    const designationId = designationChoice(source.departmentDesignations, row.departmentId);
    const designation = (designationsByDepartment?.[row.departmentId] || []).find(
      (item) => item.designationId === designationId
    );
    const track = String(designation?.track || "").trim();
    const designationName = String(designation?.name || "").trim();
    const activeTracks = tracksInDepartment(designationsByDepartment?.[row.departmentId] || []);
    return {
      departmentId: row.departmentId,
      departmentName: row.name,
      inactiveDepartment: String(row.status || "").toUpperCase() !== "ACTIVE",
      isPrimary: row.departmentId === summary.primaryDepartmentId,
      designationId,
      track,
      designationName,
      inactiveDesignation:
        Boolean(designation) && String(designation.status || "").toUpperCase() !== "ACTIVE",
      inactiveTrack: Boolean(track) && !activeTracks.includes(track),
    };
  });
}

function roleLine(row) {
  if (row.track && row.designationName) return `${row.track} · ${row.designationName}`;
  if (row.designationName) return row.designationName;
  if (row.designationId) return "Saved designation is unavailable";
  return "No designation selected";
}

function emptyAssignment() {
  return {
    departmentId: "",
    track: "",
    designationId: "",
    preservedDepartmentId: "",
    preservedTrack: "",
    preservedDesignationId: "",
  };
}

function describedAssignment(row) {
  const departmentName = `${row.departmentName}${row.inactiveDepartment ? " (inactive)" : ""}`;
  const designationName = row.designationName
    ? `${row.designationName}${row.inactiveDesignation ? " (inactive)" : ""}`
    : roleLine(row);
  return { departmentName, designationName };
}

function AssignmentFacts({ row }) {
  const described = describedAssignment(row);
  return (
    <div className="dgv-assignment-facts">
      <div>
        <div className="dgv-assignment-fact-label">Department</div>
        <div className="dgv-profile-value">{described.departmentName}</div>
      </div>
      <div>
        <div className="dgv-assignment-fact-label">Designation</div>
        <div className="dgv-profile-value">{described.designationName}</div>
      </div>
    </div>
  );
}

function currentDesignationLabel(source, departments, designationsByDepartment) {
  const rows = assignmentRows(source, departments, designationsByDepartment);
  const main = rows.find((row) => row.isPrimary) || rows[0];
  return main?.designationName || "";
}

function AssignmentSelectors({
  idPrefix,
  legend,
  value,
  departments,
  excludedDepartmentIds,
  designationsByDepartment,
  loading,
  onChange,
  onRemove,
}) {
  const catalog = designationsByDepartment?.[value.departmentId] || [];
  const preservedDepartment =
    value.departmentId && value.departmentId === value.preservedDepartmentId;
  const activeTracks = tracksInDepartment(catalog);
  const tracks = tracksInDepartment(catalog, {
    preserveTrack: preservedDepartment ? value.preservedTrack : "",
  });
  const designationOptions = designationsInTrack(catalog, value.track, {
    departmentId: value.departmentId,
    preserveDesignationId:
      preservedDepartment && value.track === value.preservedTrack
        ? value.preservedDesignationId
        : "",
  });
  const options = departmentChoices(departments, excludedDepartmentIds, {
    includeDepartmentId: value.departmentId,
    preserveDepartmentId: value.preservedDepartmentId,
  });

  return (
    <fieldset className="dgv-assignment-fieldset">
      <legend>{legend}</legend>
      <div className="dgv-profile-item">
        <label htmlFor={`${idPrefix}-department`}>Department</label>
        <select
          id={`${idPrefix}-department`}
          value={value.departmentId}
          onChange={(event) => {
            const departmentId = event.target.value;
            if (departmentId && departmentId === value.preservedDepartmentId) {
              onChange({
                ...value,
                departmentId,
                track: value.preservedTrack,
                designationId: value.preservedDesignationId,
              });
              return;
            }
            onChange({
              ...value,
              departmentId,
              track: "",
              designationId: "",
            });
          }}
        >
          <option value="">
            {options.length ? "Select a department" : "No active departments available"}
          </option>
          {options.map((row) => (
            <option key={row.departmentId} value={row.departmentId}>
              {row.name}
              {String(row.status || "").toUpperCase() === "ACTIVE" ? "" : " (inactive)"}
            </option>
          ))}
        </select>
      </div>
      <div className="dgv-profile-item">
        <label htmlFor={`${idPrefix}-track`}>Track</label>
        <select
          id={`${idPrefix}-track`}
          value={value.track}
          disabled={!value.departmentId || loading}
          onChange={(event) => {
            const track = event.target.value;
            const restore =
              value.departmentId === value.preservedDepartmentId &&
              track === value.preservedTrack;
            onChange({
              ...value,
              track,
              designationId: restore ? value.preservedDesignationId : "",
            });
          }}
        >
          <option value="">
            {!value.departmentId
              ? "Select a department first"
              : loading
                ? "Loading tracks…"
                : tracks.length
                  ? "Select a track"
                  : "No tracks available"}
          </option>
          {tracks.map((name) => (
            <option key={name} value={name}>
              {name}
              {activeTracks.includes(name) ? "" : " (inactive)"}
            </option>
          ))}
        </select>
      </div>
      <div className="dgv-profile-item">
        <label htmlFor={`${idPrefix}-designation`}>Designation</label>
        <select
          id={`${idPrefix}-designation`}
          value={value.designationId}
          disabled={!value.track}
          onChange={(event) => onChange({ ...value, designationId: event.target.value })}
        >
          <option value="">
            {value.track
              ? designationOptions.length
                ? "Select a designation"
                : "No designations in this track"
              : "Select a track first"}
          </option>
          {designationOptions.map((row) => (
            <option key={row.designationId} value={row.designationId}>
              {row.name}
              {String(row.status || "").toUpperCase() === "ACTIVE" ? "" : " (inactive)"}
            </option>
          ))}
        </select>
      </div>
      {onRemove ? (
        <button type="button" className="dgv-assignment-action dgv-assignment-action--danger" onClick={onRemove}>
          {`Remove ${legend}`}
        </button>
      ) : null}
    </fieldset>
  );
}

function AssignmentModal({
  open,
  departments,
  designationsByDepartment,
  initialMain,
  initialSubsidiaries,
  onLoad,
  onClose,
  onSubmit,
}) {
  const [main, setMain] = useState(initialMain || emptyAssignment());
  const [subsidiaries, setSubsidiaries] = useState(initialSubsidiaries || []);
  const [loadingIds, setLoadingIds] = useState({});
  const subsidiarySeq = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    setMain(initialMain || emptyAssignment());
    setSubsidiaries(initialSubsidiaries || []);
    return undefined;
  }, [open, initialMain, initialSubsidiaries]);

  const trackFor = useCallback((slot) => {
    if (!slot?.designationId || slot.track) return slot;
    const designation = (designationsByDepartment?.[slot.departmentId] || []).find(
      (row) => row.designationId === slot.designationId
    );
    const track = String(designation?.track || "").trim();
    return track ? { ...slot, track } : slot;
  }, [designationsByDepartment]);

  useEffect(() => {
    if (!open) return undefined;
    setMain((current) => trackFor(current));
    setSubsidiaries((current) => current.map((row) => trackFor(row)));
    return undefined;
  }, [open, trackFor]);

  const watchedIds = [main.departmentId, ...subsidiaries.map((row) => row.departmentId)]
    .map((id) => String(id || "").trim())
    .filter(Boolean)
    .join("|");

  useEffect(() => {
    if (!open || !watchedIds) return undefined;
    let cancelled = false;
    watchedIds.split("|").forEach((id) => {
      if (designationsByDepartment?.[id]) return;
      setLoadingIds((prev) => ({ ...prev, [id]: true }));
      Promise.resolve(onLoad(id))
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoadingIds((prev) => ({ ...prev, [id]: false }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [open, watchedIds, onLoad, designationsByDepartment]);

  const saved = buildSavedAssignments(main, subsidiaries, designationsByDepartment, departments);

  const updateMain = (next) => {
    setMain(next);
    if (!next.departmentId) return;
    setSubsidiaries((prev) =>
      prev.map((row) =>
        row.departmentId === next.departmentId
          ? { ...row, departmentId: "", track: "", designationId: "" }
          : row
      )
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Department Assignment"
      maxWidth={640}
      dirty={Boolean(
        main.departmentId ||
          main.track ||
          main.designationId ||
          subsidiaries.some((row) => row.departmentId || row.track || row.designationId)
      )}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => saved.ok && onSubmit(saved)} disabled={!saved.ok}>
            Save assignments
          </Button>
        </>
      }
    >
      <div className="dgv-assignment-modal-section">
        <AssignmentSelectors
          idPrefix="main-department"
          legend="Main Department"
          value={main}
          departments={departments}
          excludedDepartmentIds={subsidiaries.map((row) => row.departmentId)}
          designationsByDepartment={designationsByDepartment}
          loading={Boolean(loadingIds[main.departmentId])}
          onChange={updateMain}
        />
      </div>
      <div className="dgv-assignment-modal-section">
        <h4 className="dgv-profile-subtitle">Subsidiary Departments</h4>
        <p className="dgv-profile-section-desc">
          Add other departments this employee works in. Each one needs its own track and designation.
        </p>
        {subsidiaries.map((row, index) => (
          <AssignmentSelectors
            key={row.key}
            idPrefix={`subsidiary-${row.key}`}
            legend={`Subsidiary department ${index + 1}`}
            value={row}
            departments={departments}
            excludedDepartmentIds={[
              main.departmentId,
              ...subsidiaries
                .filter((item) => item.key !== row.key)
                .map((item) => item.departmentId),
            ]}
            designationsByDepartment={designationsByDepartment}
            loading={Boolean(loadingIds[row.departmentId])}
            onChange={(next) =>
              setSubsidiaries((prev) =>
                prev.map((item) => (item.key === row.key ? { ...item, ...next } : item))
              )
            }
            onRemove={() =>
              setSubsidiaries((prev) => prev.filter((item) => item.key !== row.key))
            }
          />
        ))}
        <Button
          variant="outline"
          onClick={() => {
            subsidiarySeq.current += 1;
            setSubsidiaries((prev) => [
              ...prev,
              { key: `sub-${subsidiarySeq.current}`, ...emptyAssignment() },
            ]);
          }}
        >
          Add Subsidiary Department
        </Button>
      </div>
    </Modal>
  );
}

function DepartmentMembership({
  editing,
  draft,
  profile,
  departments,
  designationsByDepartment,
  departmentError,
  assignmentModal,
  onOpen,
  onCloseModal,
  onSubmitModal,
  onLoadDesignations,
  costingDesignationId,
  onCostingDesignation,
  canEditCosting,
}) {
  const source = editing ? draft : profile;
  const rows = assignmentRows(source, departments, designationsByDepartment);
  const main = rows.find((row) => row.isPrimary) || rows[0] || null;
  const subsidiaries = main ? rows.filter((row) => row.departmentId !== main.departmentId) : [];

  return (
    <div>
      <div className="dgv-assignment-toolbar">
        <div>
          <div className="dgv-profile-subtitle">Department Assignment</div>
          <p>
            Choose the employee&apos;s main department and any additional departments they work in.
          </p>
        </div>
        {rows.length === 0 ? (
          <Button onClick={onOpen}>Choose Department</Button>
        ) : (
          <Button variant="outline" onClick={onOpen} aria-label="Edit department assignments">
            Edit
          </Button>
        )}
      </div>
      {departmentError ? <div className="dgv-profile-value">{departmentError}</div> : null}
      {main ? (
        <section className="dgv-assignment-summary" aria-label="Main Department">
          <h4 className="dgv-profile-subtitle">Main Department</h4>
          <AssignmentFacts row={main} />
        </section>
      ) : null}
      {subsidiaries.map((row, index) => (
        <section
          key={row.departmentId}
          className="dgv-assignment-summary"
          aria-label={`Subsidiary Department ${index + 1}`}
        >
          <h4 className="dgv-profile-subtitle">Subsidiary Department {index + 1}</h4>
          <AssignmentFacts row={row} />
        </section>
      ))}
      {editing && canEditCosting ? (
        <div className="dgv-assignment-costing">
          <p>
            Costing designation chooses which assigned designation supplies this
            employee&apos;s rates. It does not change the department assignment.
          </p>
          <CostingDesignationSelect
            links={source.departmentDesignations}
            designationsByDepartment={designationsByDepartment}
            departments={departments}
            value={costingDesignationId}
            onChange={onCostingDesignation}
          />
        </div>
      ) : null}
      {!editing ? (
        <div className="dgv-profile-value" style={{ marginTop: 8 }}>
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
      ) : null}
      <AssignmentModal
        open={Boolean(assignmentModal)}
        departments={departments}
        designationsByDepartment={designationsByDepartment}
        initialMain={assignmentModal?.main}
        initialSubsidiaries={assignmentModal?.subsidiaries}
        onLoad={onLoadDesignations}
        onClose={onCloseModal}
        onSubmit={onSubmitModal}
      />
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
    <div className="dgv-profile-item">
      <label htmlFor="admin-profile-costing-designation">Costing designation</label>
      <select
        id="admin-profile-costing-designation"
        className="dgv-select dgv-assignment-costing-select"
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
    </div>
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
  const [assignmentModal, setAssignmentModal] = useState(null);

  const storedPortalRole = () =>
    typeof localStorage !== "undefined"
      ? localStorage.getItem(PORTAL_ROLE_KEY) || ""
      : "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const departmentRes = await fetchDepartments();
        if (cancelled) return;
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
  }, [isCreate]);

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

  const loadDepartmentDesignations = useCallback(async (departmentId) => {
    const id = String(departmentId || "").trim();
    if (!id) return [];
    const res = await fetchDepartmentDesignations(id);
    const list = Array.isArray(res?.designations) ? res.designations : [];
    setDesignationsByDepartment((prev) => ({ ...prev, [id]: list }));
    return list;
  }, []);

  const openAssignmentEditor = () => {
    const source = editing ? draft : profile;
    if (!editing) {
      setDraft(source);
      setEditing(true);
    }
    const rows = assignmentRows(source, departments, designationsByDepartment);
    const mainRow = rows.find((row) => row.isPrimary) || rows[0];
    const subsidiaryRows = mainRow
      ? rows.filter((row) => row.departmentId !== mainRow.departmentId)
      : [];
    setAssignmentModal({
      main: mainRow
        ? {
            departmentId: mainRow.departmentId,
            track: mainRow.track,
            designationId: mainRow.designationId,
            preservedDepartmentId: mainRow.departmentId,
            preservedTrack: mainRow.track,
            preservedDesignationId: mainRow.designationId,
          }
        : emptyAssignment(),
      subsidiaries: subsidiaryRows.map((row, index) => ({
        key: `${row.departmentId}-${index}`,
        departmentId: row.departmentId,
        track: row.track,
        designationId: row.designationId,
        preservedDepartmentId: row.departmentId,
        preservedTrack: row.track,
        preservedDesignationId: row.designationId,
      })),
    });
  };

  const commitAssignmentSet = (saved) => {
    if (!saved?.ok) return;
    setMembershipKnown(true);
    setError("");
    setDraft((prev) => ({
      ...prev,
      departmentIds: saved.departmentIds,
      primaryDepartmentId: saved.primaryDepartmentId,
      departmentDesignations: saved.departmentDesignations,
    }));
    setAssignmentModal(null);
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

  const selectedDepartmentKey = (editing ? draft.departmentIds : profile.departmentIds || [])
    .join("|");

  useEffect(() => {
    const ids = selectedDepartmentKey ? selectedDepartmentKey.split("|") : [];
    if (!ids.length) return undefined;
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
      if (!cancelled) {
        setDesignationsByDepartment((prev) => ({
          ...prev,
          ...Object.fromEntries(entries),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDepartmentKey]);

  const saveEdit = async () => {
    const email = String(draft.email || profile.email || "")
      .trim()
      .toLowerCase();

    if (!email) {
      setError("Email is required");
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
        ...(isCreate ? { role: normalizeRole(draft.role) } : {}),
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
              {currentDesignationLabel(shown, departments, designationsByDepartment) ||
                "No designation"}{" "}
              · Employee ID: {displayValue(shown.empId)}
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
            Department assignments, reporting, and costing designation
          </p>
          <div className="dgv-profile-card">
            <DepartmentMembership
              editing={editing}
              draft={draft}
              profile={profile}
              departments={departments}
              departmentError={departmentError}
              designationsByDepartment={designationsByDepartment}
              assignmentModal={assignmentModal}
              onOpen={openAssignmentEditor}
              onCloseModal={() => setAssignmentModal(null)}
              onSubmitModal={commitAssignmentSet}
              onLoadDesignations={loadDepartmentDesignations}
              costingDesignationId={(editing ? draft : profile).costingDesignationId}
              onCostingDesignation={setCostingDesignation}
              canEditCosting={canManageProjectDocuments(actorRole)}
            />
            <div className="dgv-profile-grid dgv-assignment-fields">
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

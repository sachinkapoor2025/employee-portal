import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import {
  fetchUsers,
  fetchSkills,
  fetchUserProfile,
  saveUserProfile,
  updateUserRole,
} from "../../services/api";
import { ROLE_OPTIONS, normalizeRole, roleLabel } from "../../constants/roles";
import { alertSuccess, alertError } from "../../theme";

const emptyForm = {
  email: "",
  name: "",
  empId: "",
  department: "",
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
  const [profile, setProfile] = useState(emptyForm);
  const [draft, setDraft] = useState(emptyForm);
  const [editing, setEditing] = useState(isCreate || searchParams.get("edit") === "1");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchSkills();
        if (!cancelled) setSkills(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadEmployee = async () => {
    setLoading(true);
    setError("");
    try {
      const [data, users] = await Promise.all([
        fetchUserProfile(lookupEmail),
        fetchUsers().catch(() => []),
      ]);
      const row = (Array.isArray(users) ? users : []).find(
        (u) => String(u.email || "").toLowerCase() === lookupEmail
      );
      const next = {
        email: lookupEmail,
        name: data?.name || row?.name || "",
        empId: data?.empId || row?.empId || "",
        department: data?.department || row?.department || "",
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
          department: draft.department || "",
          designation: draft.designation || "",
          skill: draft.skill || "",
          manager: draft.manager || "",
          groupLead: draft.groupLead || "",
          phone: draft.phone || "",
          doj: draft.doj || "",
        },
      });

      if (!isCreate) {
        await updateUserRole(email, normalizeRole(draft.role));
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
              <Field label="Department" htmlFor={editing ? "admin-profile-department" : undefined}>
                {editing ? renderInput("department") : renderValue(profile.department)}
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
                    {ROLE_OPTIONS.map((r) => (
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

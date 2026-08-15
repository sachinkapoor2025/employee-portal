import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Users, UserCheck, UserX, Shield } from "lucide-react";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import { StatCard } from "../../components/ui/Card";
import {
  fetchUsers,
  fetchSkills,
  fetchUserProfile,
  saveUserProfile,
  updateUserStatus,
  updateUserRole,
  deleteUser,
  resetUserPassword,
} from "../../services/api";
import { getLoggedInEmail } from "../../services/auth";
import { ROLE_OPTIONS, normalizeRole, roleLabel } from "../../constants/roles";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  formLabel,
  formInput,
  formSelect,
} from "../../theme";

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
};

export default function ManageUsers() {
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filterDept, setFilterDept] = useState("");
  const [filterDesignation, setFilterDesignation] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [editMenuEmail, setEditMenuEmail] = useState("");

  const [profileView, setProfileView] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [mode, setMode] = useState("CREATE");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    loadUsers();
    loadSkills();
  }, []);

  useEffect(() => {
    if (!editMenuEmail) return undefined;
    const onDocClick = () => setEditMenuEmail("");
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [editMenuEmail]);

  const loadUsers = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchUsers();
      const list = Array.isArray(data) ? data : [];

      // Live GET /admin/users may only return email/role/status until backend deploy.
      // Merge each employee's saved profile so name, empId, department, etc. show.
      const enriched = await Promise.all(
        list.map(async (u) => {
          const email = String(u.email || "").trim().toLowerCase();
          if (!email) return u;
          try {
            const profile = await fetchUserProfile(email);
            if (!profile || (!profile.name && !profile.empId && !profile.PK)) {
              return { ...u, email };
            }
            return {
              ...u,
              email,
              name: profile.name || u.name || "",
              empId: profile.empId || u.empId || "",
              department: profile.department || u.department || "",
              designation: profile.designation || u.designation || "",
              skill: profile.skill || u.skill || "",
              manager: profile.manager || u.manager || "",
              groupLead: profile.groupLead || u.groupLead || "",
              phone: profile.phone || u.phone || "",
              doj: profile.doj || u.doj || "",
            };
          } catch (err) {
            console.warn("Profile enrich failed for", email, err);
            return { ...u, email };
          }
        })
      );

      setUsers(enriched);
    } catch (err) {
      console.error(err);
      setError(
        "Unable to load employees. Please refresh or sign in again as admin."
      );
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  const loadSkills = async () => {
    try {
      const data = await fetchSkills();
      setSkills(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    }
  };

  const departments = useMemo(() => {
    const set = new Set(
      users.map((u) => u.department).filter((d) => d && String(d).trim())
    );
    return Array.from(set).sort();
  }, [users]);

  const designations = useMemo(() => {
    const set = new Set(
      users.map((u) => u.designation).filter((d) => d && String(d).trim())
    );
    return Array.from(set).sort();
  }, [users]);

  const openProfileView = async (email) => {
    try {
      const profile = await fetchUserProfile(email);
      const row = users.find((u) => u.email === email);
      setProfileView({
        ...profile,
        email,
        role: row?.role,
        status: row?.status,
        department: profile?.department || row?.department,
      });
    } catch (err) {
      alert(err.message || "Failed to load profile");
    }
  };

  const openCreateUser = () => {
    setMode("CREATE");
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEditUser = async (email) => {
    setMode("EDIT");
    const profile = await fetchUserProfile(email);
    const row = users.find((u) => u.email === email);
    setForm({
      email,
      name: profile?.name || "",
      empId: profile?.empId || "",
      department: profile?.department || row?.department || "",
      designation: profile?.designation || "",
      skill: profile?.skill || "",
      manager: profile?.manager || "",
      groupLead: profile?.groupLead || "",
      phone: profile?.phone || "",
      doj: profile?.doj || "",
      role: normalizeRole(row?.role || "EMPLOYEE"),
    });
    setShowModal(true);
  };

  const handleChange = (e) =>
    setForm({ ...form, [e.target.name]: e.target.value });

  const saveProfile = async () => {
    const email = (form.email || "").trim().toLowerCase();

    if (!email || !form.skill) {
      alert("Email and Skill are required");
      return;
    }
    if (!email.endsWith("@mydgv.com")) {
      alert("Only @mydgv.com email addresses are allowed.");
      return;
    }

    setSaving(true);
    try {
      const result = await saveUserProfile({
        mode,
        email,
        role: normalizeRole(form.role),
        profile: {
          email,
          name: form.name || "",
          empId: form.empId || "",
          department: form.department || "",
          designation: form.designation || "",
          skill: form.skill || "",
          manager: form.manager || "",
          groupLead: form.groupLead || "",
          phone: form.phone || "",
          doj: form.doj || "",
        },
      });

      if (mode === "EDIT") {
        await updateUserRole(email, normalizeRole(form.role));
      }

      if (result?.temporaryPassword) {
        alert(
          `Employee created successfully.\n\nTemporary password:\n${result.temporaryPassword}\n\nShare this with the employee.`
        );
      } else if (result?.warning) {
        alert(result.warning);
      }

      // Show saved fields immediately (don't wait only on list API shape)
      setUsers((prev) => {
        const next = {
          email,
          name: form.name || "",
          empId: form.empId || "",
          department: form.department || "",
          designation: form.designation || "",
          skill: form.skill || "",
          manager: form.manager || "",
          groupLead: form.groupLead || "",
          phone: form.phone || "",
          doj: form.doj || "",
          role: normalizeRole(form.role),
          status: "ACTIVE",
        };
        const idx = prev.findIndex(
          (u) => String(u.email).toLowerCase() === email
        );
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = { ...copy[idx], ...next };
          return copy;
        }
        return [...prev, next];
      });

      setShowModal(false);
      await loadUsers();    } catch (err) {
      console.error(err);
      alert(err?.message || "Failed to save employee.");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteUser = async (email) => {
    if (email.toLowerCase() === getLoggedInEmail().toLowerCase()) {
      alert("You cannot delete your own account.");
      return;
    }
    if (
      !window.confirm(
        `Delete ${email}? This removes Cognito login, access, and profile permanently.`
      )
    ) {
      return;
    }
    try {
      await deleteUser(email);
      await loadUsers();
    } catch (err) {
      alert(err.message || "Failed to delete user.");
    }
  };

  const handleResetPassword = async (email) => {
    if (
      !window.confirm(
        `Reset password for ${email}? A temporary password will be shown once.`
      )
    ) {
      return;
    }
    try {
      const result = await resetUserPassword(email);
      alert(
        `Temporary password for ${email}:\n\n${result.temporaryPassword}\n\nShare it securely with the employee.`
      );
    } catch (err) {
      alert(err.message || "Failed to reset password.");
    }
  };

  const currentEmail = getLoggedInEmail().toLowerCase();
  const query = search.trim().toLowerCase();

  const filteredUsers = users.filter((u) => {
    if (filterStatus && u.status !== filterStatus) return false;
    if (filterDept && (u.department || "") !== filterDept) return false;
    if (filterDesignation && (u.designation || "") !== filterDesignation) {
      return false;
    }
    if (!query) return true;
    const hay = [
      u.name,
      u.email,
      u.empId,
      u.department,
      u.designation,
      u.role,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(query);
  });

  const summaryCards = useMemo(() => {
    const active = users.filter((u) => u.status === "ACTIVE").length;
    const blocked = users.filter(
      (u) => u.status === "BLOCKED" || u.status === "PENDING"
    ).length;
    const admins = users.filter((u) => {
      const r = normalizeRole(u.role);
      return r === "SUPER_ADMIN" || r === "ADMIN" || r === "MANAGER";
    }).length;
    return [
      {
        label: "Total Employees",
        value: users.length,
        icon: <Users size={20} />,
      },
      {
        label: "Active",
        value: active,
        icon: <UserCheck size={20} />,
      },
      {
        label: "Inactive",
        value: blocked,
        icon: <UserX size={20} />,
      },
      {
        label: "Admins",
        value: admins,
        icon: <Shield size={20} />,
      },
    ];
  }, [users]);

  const overviewDate = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Employees</h2>
        <p style={pageSubtitle}>Overview for {overviewDate}</p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 16,
            margin: "8px 0 24px",
          }}
        >
          {summaryCards.map((c) => (
            <StatCard
              key={c.label}
              label={c.label}
              value={c.value}
              icon={c.icon}
            />
          ))}
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 24,
          }}
        >
          <Button type="button" onClick={openCreateUser}>
            + Add Employee
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setFilterStatus("")}
          >
            All Employees
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setFilterStatus("ACTIVE")}
          >
            Active
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setFilterStatus("BLOCKED")}
          >
            Inactive
          </Button>
        </div>

        <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Users size={18} color="var(--dgv-accent)" />
          Employee List
        </h3>

        {error ? (
          <div className="dgv-alert dgv-alert--error" style={{ marginTop: 12 }}>
            {error}
          </div>
        ) : null}

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading employees…</p>
        ) : users.length === 0 ? (
          <p style={{ color: colors.textMuted }}>
            No employees yet. Click &quot;+ Add Employee&quot; to create the first
            account.
          </p>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 10,
                margin: "12px 0 16px",
              }}
            >
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email, ID…"
                style={formInput}
                aria-label="Search employees"
              />
              <select
                value={filterDept}
                onChange={(e) => setFilterDept(e.target.value)}
                style={formSelect}
                aria-label="Filter by department"
              >
                <option value="">All departments</option>
                {departments.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <select
                value={filterDesignation}
                onChange={(e) => setFilterDesignation(e.target.value)}
                style={formSelect}
                aria-label="Filter by designation"
              >
                <option value="">All designations</option>
                {designations.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                style={formSelect}
                aria-label="Filter by status"
              >
                <option value="">All statuses</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="BLOCKED">BLOCKED</option>
                <option value="PENDING">PENDING</option>
              </select>
            </div>

            {filteredUsers.length === 0 ? (
              <p style={{ color: colors.textMuted }}>No employees found.</p>
            ) : (
              <div className="dgv-table-wrap">
                <p
                  style={{
                    margin: "0 0 8px",
                    fontSize: 12,
                    color: colors.textMuted,
                  }}
                >
                  <strong>Edit</strong> menu se profile, activate/deactivate,
                  reset password aur delete. <strong>Track</strong> se employee
                  tracking khulega.
                </p>
                <table className="dgv-table dgv-employees-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Name</th>
                      <th>Employee ID</th>
                      <th>Department</th>
                      <th>Designation</th>
                      <th>Status</th>
                      <th>Joining Date</th>
                      <th>Role</th>
                      <th className="dgv-employees-table__actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((u) => {
                      const menuOpen = editMenuEmail === u.email;
                      return (
                      <tr key={u.email}>
                        <td>
                          <button
                            type="button"
                            onClick={() => openEditUser(u.email)}
                            style={{
                              background: "none",
                              border: "none",
                              padding: 0,
                              color: "var(--dgv-accent)",
                              fontWeight: 600,
                              cursor: "pointer",
                              textAlign: "left",
                            }}
                            title="Edit employee"
                          >
                            {u.email}
                          </button>
                        </td>
                        <td style={{ fontWeight: 600 }}>{u.name || "—"}</td>
                        <td>{u.empId || "—"}</td>
                        <td>{u.department || "—"}</td>
                        <td>{u.designation || "—"}</td>
                        <td>
                          <span
                            className={`dgv-badge ${
                              u.status === "ACTIVE"
                                ? "dgv-badge--success"
                                : "dgv-badge--danger"
                            }`}
                          >
                            {u.status}
                          </span>
                        </td>
                        <td>{u.doj || "—"}</td>
                        <td>
                          <select
                            value={normalizeRole(u.role)}
                            style={{
                              padding: "6px 8px",
                              borderRadius: 6,
                              border: `1px solid ${colors.border}`,
                              background: "var(--dgv-surface-solid)",
                              color: "var(--dgv-text)",
                              maxWidth: 130,
                            }}
                            onChange={(e) =>
                              updateUserRole(u.email, e.target.value)
                                .then(loadUsers)
                                .catch((err) =>
                                  alert(err.message || "Role update failed")
                                )
                            }
                          >
                            {ROLE_OPTIONS.map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="dgv-employees-table__actions">
                          <div className="dgv-employees-table__action-btns">
                            <div
                              className="dgv-employees-edit-menu"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Button
                                type="button"
                                variant="primary"
                                style={{ padding: "6px 12px", fontSize: 12 }}
                                aria-expanded={menuOpen}
                                aria-haspopup="menu"
                                onClick={() =>
                                  setEditMenuEmail(menuOpen ? "" : u.email)
                                }
                              >
                                Edit ▾
                              </Button>
                              {menuOpen ? (
                                <div
                                  className="dgv-employees-edit-menu__dropdown"
                                  role="menu"
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setEditMenuEmail("");
                                      openEditUser(u.email);
                                    }}
                                  >
                                    Edit profile
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setEditMenuEmail("");
                                      openProfileView(u.email);
                                    }}
                                  >
                                    View
                                  </button>
                                  {u.status === "ACTIVE" ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setEditMenuEmail("");
                                        updateUserStatus(
                                          u.email,
                                          "deactivate"
                                        ).then(loadUsers);
                                      }}
                                    >
                                      Deactivate
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setEditMenuEmail("");
                                        updateUserStatus(
                                          u.email,
                                          "activate"
                                        ).then(loadUsers);
                                      }}
                                    >
                                      Activate
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setEditMenuEmail("");
                                      handleResetPassword(u.email);
                                    }}
                                  >
                                    Reset password
                                  </button>
                                  {u.email.toLowerCase() !== currentEmail ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="is-danger"
                                      onClick={() => {
                                        setEditMenuEmail("");
                                        handleDeleteUser(u.email);
                                      }}
                                    >
                                      Delete
                                    </button>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                            <Button
                              type="button"
                              variant="secondary"
                              style={{ padding: "6px 12px", fontSize: 12 }}
                              onClick={() =>
                                navigate(
                                  `/admin/employees/${encodeURIComponent(u.email)}/track`
                                )
                              }
                            >
                              Track
                            </Button>
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {profileView ? (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginTop: 0 }}>Employee Profile</h3>
            <ProfileRow label="Name" value={profileView.name} />
            <ProfileRow label="Employee ID" value={profileView.empId} />
            <ProfileRow label="Email" value={profileView.email} />
            <ProfileRow label="Department" value={profileView.department} />
            <ProfileRow label="Designation" value={profileView.designation} />
            <ProfileRow label="Skill" value={profileView.skill} />
            <ProfileRow label="Manager" value={profileView.manager} />
            <ProfileRow label="Group Lead" value={profileView.groupLead} />
            <ProfileRow label="Phone" value={profileView.phone} />
            <ProfileRow label="Date of Joining" value={profileView.doj} />
            <ProfileRow label="Role" value={roleLabel(profileView.role)} />
            <ProfileRow label="Status" value={profileView.status} />
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 16,
              }}
            >
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  setProfileView(null);
                  navigate(
                    `/admin/employees/${encodeURIComponent(profileView.email)}/track`
                  );
                }}
              >
                Track
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setProfileView(null)}
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {showModal ? (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 560, width: "100%" }}>
            <h3 style={{ marginTop: 0 }}>
              {mode === "CREATE" ? "Add Employee" : "Edit Employee"}
            </h3>

            <label style={formLabel}>Email</label>
            <input
              name="email"
              disabled={mode === "EDIT"}
              value={form.email}
              onChange={handleChange}
              style={formInput}
              placeholder="name@mydgv.com"
            />

            <label style={formLabel}>Full Name</label>
            <input
              name="name"
              value={form.name}
              onChange={handleChange}
              style={formInput}
            />

            <label style={formLabel}>Employee ID</label>
            <input
              name="empId"
              value={form.empId}
              onChange={handleChange}
              style={formInput}
              placeholder="DGV001"
            />

            <label style={formLabel}>Department</label>
            <input
              name="department"
              value={form.department}
              onChange={handleChange}
              style={formInput}
            />

            <label style={formLabel}>Designation</label>
            <input
              name="designation"
              value={form.designation}
              onChange={handleChange}
              style={formInput}
            />

            <label style={formLabel}>Skill</label>
            <select
              name="skill"
              value={form.skill}
              onChange={handleChange}
              style={formSelect}
            >
              <option value="">Select Skill</option>
              {skills.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>

            <label style={formLabel}>Role</label>
            <select
              name="role"
              value={form.role}
              onChange={handleChange}
              style={formSelect}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>

            <label style={formLabel}>Manager</label>
            <input
              name="manager"
              value={form.manager}
              onChange={handleChange}
              style={formInput}
            />

            <label style={formLabel}>Group Lead</label>
            <input
              name="groupLead"
              value={form.groupLead}
              onChange={handleChange}
              style={formInput}
            />

            <label style={formLabel}>Phone</label>
            <input
              name="phone"
              value={form.phone}
              onChange={handleChange}
              style={formInput}
            />

            <label style={formLabel}>Date of Joining</label>
            <input
              type="date"
              name="doj"
              value={form.doj}
              onChange={handleChange}
              style={formInput}
            />

            <div style={{ textAlign: "right", marginTop: 12 }}>
              <Button
                type="button"
                variant="outline"
                style={{ marginRight: 8 }}
                onClick={() => setShowModal(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="success"
                loading={saving}
                disabled={saving}
                onClick={saveProfile}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Layout>
  );
}

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
  padding: 16,
};

const modalStyle = {
  background: "var(--dgv-card)",
  color: "var(--dgv-text)",
  padding: 24,
  borderRadius: 12,
  maxHeight: "90vh",
  overflowY: "auto",
  border: "1px solid var(--dgv-border)",
  boxShadow: "var(--dgv-shadow-lg)",
};

const ProfileRow = ({ label, value }) => (
  <p style={{ margin: "6px 0", fontSize: 14 }}>
    <b>{label}:</b> {value || "—"}
  </p>
);

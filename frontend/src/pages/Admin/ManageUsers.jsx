import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import {
  fetchUsers,
  fetchSkills,
  fetchUserProfile,
  saveUserProfile,
  updateUserStatus,
  updateUserRole,
  deleteUser,
} from "../../services/api";
import { getLoggedInEmail } from "../../services/auth";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  formLabel,
  formInput,
  formSelect,
  buttonPrimary,
} from "../../theme";

export default function ManageUsers() {
  const [users, setUsers] = useState([]);
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const [profileView, setProfileView] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [mode, setMode] = useState("CREATE");
  const [saving, setSaving] = useState(false);

  const emptyForm = {
    email: "",
    name: "",
    empId: "",
    designation: "",
    skill: "",
    manager: "",
    groupLead: "",
    phone: "",
    doj: "",
  };

  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    loadUsers();
    loadSkills();
  }, []);

  const loadUsers = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchUsers();
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setError("Unable to load users. Please refresh or sign in again as admin.");
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

  const openProfileView = async (email) => {
    const profile = await fetchUserProfile(email);
    setProfileView(profile);
  };

  const openCreateUser = () => {
    setMode("CREATE");
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEditUser = async (email) => {
    setMode("EDIT");
    const profile = await fetchUserProfile(email);

    setForm({
      email,
      name: profile?.name || "",
      empId: profile?.empId || "",
      designation: profile?.designation || "",
      skill: profile?.skill || "",
      manager: profile?.manager || "",
      groupLead: profile?.groupLead || "",
      phone: profile?.phone || "",
      doj: profile?.doj || "",
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
        role: "USER",
        profile: { ...form, email },
      });

      if (result?.temporaryPassword) {
        alert(
          `User created successfully.\n\nTemporary password:\n${result.temporaryPassword}\n\nShare this with the employee (no invite email is sent).`
        );
      } else if (result?.warning) {
        alert(result.warning);
      }

      setShowModal(false);
      await loadUsers();
    } catch (err) {
      console.error(err);
      alert(err?.message || "Failed to save user. Please try again.");
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
        `Delete ${email}? This removes Cognito login, access record, and profile permanently.`
      )
    ) {
      return;
    }

    try {
      await deleteUser(email);
      await loadUsers();
    } catch (err) {
      console.error(err);
      alert("Failed to delete user.");
    }
  };

  const currentEmail = getLoggedInEmail().toLowerCase();

  const query = search.trim().toLowerCase();
  const filteredUsers = !query
    ? users
    : users.filter((u) => {
        const name = String(u.name || u.email || "").toLowerCase();
        const role = String(u.role || "").toLowerCase();
        return name.includes(query) || role.includes(query);
      });

  return (
    <Layout>
      <div style={pageCard}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={pageTitle}>Manage Users</h2>
            <p style={pageSubtitle}>
              Create employees, view profiles, and manage access status.
            </p>
          </div>
          <button onClick={openCreateUser} style={buttonPrimary}>
            + Create User
          </button>
        </div>

        {error && (
          <div style={{ padding: 12, background: "var(--dgv-danger-bg)", color: colors.error, borderRadius: 8, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading users...</p>
        ) : users.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "40px 20px",
              background: colors.background,
              borderRadius: 12,
              border: `1px dashed ${colors.border}`,
            }}
          >
            <p style={{ margin: 0, fontWeight: 600 }}>No users found yet</p>
            <p style={{ color: colors.textMuted, fontSize: 14 }}>
              Click &quot;Create User&quot; to add your first employee.
            </p>
          </div>
        ) : (
          <>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by Employee Name or Role"
              style={formInput}
              aria-label="Search by Employee Name or Role"
            />

            {filteredUsers.length === 0 ? (
              <p style={{ color: colors.textMuted, margin: "8px 0 0" }}>
                No employees found.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                  <thead>
                    <tr style={{ background: colors.primary, color: colors.white }}>
                      <th style={{ padding: 12, textAlign: "left" }}>Email</th>
                      <th style={{ padding: 12, textAlign: "left" }}>Role</th>
                      <th style={{ padding: 12, textAlign: "left" }}>Status</th>
                      <th style={{ padding: 12, textAlign: "left" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((u) => (
                      <tr key={u.email} style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <td style={{ padding: 12 }}>
                          <span
                            style={{ color: colors.primary, cursor: "pointer", fontWeight: 500 }}
                            onClick={() => openProfileView(u.email)}
                          >
                            {u.email}
                          </span>
                        </td>

                        <td style={{ padding: 12 }}>
                          <select
                            value={u.role}
                            style={{ padding: "6px 8px", borderRadius: 6, border: `1px solid ${colors.border}` }}
                            onChange={(e) =>
                              updateUserRole(u.email, e.target.value).then(loadUsers)
                            }
                          >
                            <option value="USER">USER</option>
                            <option value="ADMIN">ADMIN</option>
                          </select>
                        </td>

                        <td style={{ padding: 12 }}>
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

                        <td style={{ padding: 12 }}>
                          {u.status === "ACTIVE" ? (
                            <>
                              <button
                                type="button"
                                className="dgv-btn dgv-btn--danger"
                                style={{ padding: "6px 12px", marginRight: 6 }}
                                onClick={() =>
                                  updateUserStatus(u.email, "block").then(loadUsers)
                                }
                              >
                                Block
                              </button>
                              <button
                                style={{ ...buttonPrimary, padding: "6px 12px", marginRight: 6 }}
                                onClick={() => openEditUser(u.email)}
                              >
                                Edit Profile
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="dgv-btn dgv-btn--success"
                              style={{ padding: "6px 12px", marginRight: 6 }}
                              onClick={() =>
                                updateUserStatus(u.email, "activate").then(loadUsers)
                              }
                            >
                              Activate
                            </button>
                          )}
                          {u.email.toLowerCase() !== currentEmail && (
                            <button
                              type="button"
                              className="dgv-btn dgv-btn--danger"
                              style={{ padding: "6px 12px" }}
                              onClick={() => handleDeleteUser(u.email)}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {profileView && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginTop: 0 }}>User Profile</h3>
            <ProfileRow label="Name" value={profileView.name} />
            <ProfileRow label="Employee ID" value={profileView.empId} />
            <ProfileRow label="Email" value={profileView.email} />
            <ProfileRow label="Designation" value={profileView.designation} />
            <ProfileRow label="Skill" value={profileView.skill} />
            <ProfileRow label="Manager" value={profileView.manager} />
            <ProfileRow label="Group Lead" value={profileView.groupLead} />
            <ProfileRow label="Phone" value={profileView.phone} />
            <ProfileRow label="Date of Joining" value={profileView.doj} />
            <div style={{ textAlign: "right", marginTop: 16 }}>
              <button style={buttonPrimary} onClick={() => setProfileView(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 520, width: "100%" }}>
            <h3 style={{ marginTop: 0 }}>{mode === "CREATE" ? "Create User" : "Edit User"}</h3>

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
            <input name="name" value={form.name} onChange={handleChange} style={formInput} />

            <label style={formLabel}>Employee ID</label>
            <input name="empId" value={form.empId} onChange={handleChange} style={formInput} />

            <label style={formLabel}>Designation</label>
            <input name="designation" value={form.designation} onChange={handleChange} style={formInput} />

            <label style={formLabel}>Skill</label>
            <select name="skill" value={form.skill} onChange={handleChange} style={formSelect}>
              <option value="">Select Skill</option>
              {skills.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>

            <label style={formLabel}>Manager</label>
            <input name="manager" value={form.manager} onChange={handleChange} style={formInput} />

            <label style={formLabel}>Group Lead</label>
            <input name="groupLead" value={form.groupLead} onChange={handleChange} style={formInput} />

            <label style={formLabel}>Phone</label>
            <input name="phone" value={form.phone} onChange={handleChange} style={formInput} />

            <label style={formLabel}>Date of Joining</label>
            <input type="date" name="doj" value={form.doj} onChange={handleChange} style={formInput} />

            <div style={{ textAlign: "right" }}>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  background: "transparent",
                  border: `1px solid ${colors.border}`,
                  padding: "8px 16px",
                  borderRadius: 6,
                  cursor: "pointer",
                  marginRight: 8,
                }}
              >
                Cancel
              </button>
              <button
                onClick={saveProfile}
                disabled={saving}
                style={{ ...buttonPrimary, background: colors.success }}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
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

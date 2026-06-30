import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import {
  fetchUsers,
  fetchSkills,
  fetchUserProfile,
  saveUserProfile,
  updateUserStatus,
  updateUserRole,
} from "../../services/api";

export default function ManageUsers() {
  const [users, setUsers] = useState([]);
  const [skills, setSkills] = useState([]);

  const [profileView, setProfileView] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [mode, setMode] = useState("CREATE");
  const [saving, setSaving] = useState(false);

  /* ✅ DESIGNATION ADDED */
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

  /* ================= FETCH ================= */

  useEffect(() => {
    loadUsers();
    loadSkills();
  }, []);

  const loadUsers = async () => {
    const data = await fetchUsers();
    setUsers(data);
  };

  const loadSkills = async () => {
    const data = await fetchSkills();
    setSkills(data);
  };

  /* ================= VIEW PROFILE ================= */

  const openProfileView = async (email) => {
    const profile = await fetchUserProfile(email);
    setProfileView(profile);
  };

  /* ================= CREATE / EDIT ================= */

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
      designation: profile?.designation || "", // ✅ FIX
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
    if (!form.email || !form.skill) {
      alert("Email and Skill are required");
      return;
    }

    setSaving(true);

    await saveUserProfile({
      mode,
      email: form.email,
      profile: form, // ✅ designation included
    });

    setSaving(false);
    setShowModal(false);
    loadUsers();
  };

  /* ================= UI ================= */

  return (
    <Layout>
      <div style={{ background: "#fff", padding: 24, borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h2>Manage Users</h2>
          <button
            onClick={openCreateUser}
            style={{
              background: "#1976d2",
              color: "#fff",
              padding: "10px 18px",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            + Create User
          </button>
        </div>

        {/* ================= TABLE ================= */}
        <table
          style={{
            width: "100%",
            marginTop: 16,
            borderCollapse: "collapse",
          }}
        >
          <thead>
            <tr style={{ background: "#1976d2", color: "#fff" }}>
              <th style={{ padding: 10 }}>Email</th>
              <th style={{ padding: 10 }}>Role</th>
              <th style={{ padding: 10 }}>Status</th>
              <th style={{ padding: 10 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.email} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 10 }}>
                  <span
                    style={{
                      color: "#1976d2",
                      cursor: "pointer",
                      fontWeight: 500,
                    }}
                    onClick={() => openProfileView(u.email)}
                  >
                    {u.email}
                  </span>
                </td>

                <td style={{ padding: 10 }}>
                  <select
                    value={u.role}
                    onChange={(e) =>
                      updateUserRole(u.email, e.target.value).then(loadUsers)
                    }
                  >
                    <option value="USER">USER</option>
                    <option value="ADMIN">ADMIN</option>
                  </select>
                </td>

                <td style={{ padding: 10 }}>{u.status}</td>

                <td style={{ padding: 10 }}>
                  {u.status === "ACTIVE" ? (
                    <>
                      <button
                        style={{
                          background: "#f44336",
                          color: "#fff",
                          border: "none",
                          padding: "6px 12px",
                          borderRadius: 6,
                          marginRight: 6,
                        }}
                        onClick={() =>
                          updateUserStatus(u.email, "block").then(loadUsers)
                        }
                      >
                        Block
                      </button>

                      <button
                        style={{
                          background: "#1976d2",
                          color: "#fff",
                          border: "none",
                          padding: "6px 12px",
                          borderRadius: 6,
                        }}
                        onClick={() => openEditUser(u.email)}
                      >
                        Edit Profile
                      </button>
                    </>
                  ) : (
                    <button
                      style={{
                        background: "#1976d2",
                        color: "#fff",
                        border: "none",
                        padding: "6px 12px",
                        borderRadius: 6,
                      }}
                      onClick={() =>
                        updateUserStatus(u.email, "activate").then(loadUsers)
                      }
                    >
                      Activate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ================= PROFILE VIEW POPUP ================= */}
      {profileView && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2000,
          }}
        >
          <div
            style={{
              background: "#fff",
              width: 500,
              padding: 20,
              borderRadius: 12,
            }}
          >
            <h3>User Profile</h3>
            <p>
              <b>Name:</b> {profileView.name}
            </p>
            <p>
              <b>Employee ID:</b> {profileView.empId}
            </p>
            <p>
              <b>Email:</b> {profileView.email}
            </p>
            <p>
              <b>Designation:</b> {profileView.designation}
            </p>{" "}
            {/* ✅ FIX */}
            <p>
              <b>Skill:</b> {profileView.skill}
            </p>
            <p>
              <b>Manager:</b> {profileView.manager}
            </p>
            <p>
              <b>Group Lead:</b> {profileView.groupLead}
            </p>
            <p>
              <b>Phone:</b> {profileView.phone}
            </p>
            <p>
              <b>Date of Joining:</b> {profileView.doj}
            </p>
            <div style={{ textAlign: "right" }}>
              <button onClick={() => setProfileView(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ================= CREATE / EDIT MODAL ================= */}
      {showModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2000,
          }}
        >
          <div
            style={{
              background: "#fff",
              width: 520,
              borderRadius: 12,
              padding: 20,
            }}
          >
            <h3>{mode === "CREATE" ? "Create User" : "Edit User"}</h3>

            <label>Email</label>
            <input
              name="email"
              disabled={mode === "EDIT"}
              value={form.email}
              onChange={handleChange}
              style={{ width: "100%", marginBottom: 10 }}
            />

            <label>Full Name</label>
            <input
              name="name"
              value={form.name}
              onChange={handleChange}
              style={{ width: "100%", marginBottom: 10 }}
            />

            <label>Employee ID</label>
            <input
              name="empId"
              value={form.empId}
              onChange={handleChange}
              style={{ width: "100%", marginBottom: 10 }}
            />

            {/* ✅ DESIGNATION FIELD */}
            <label>Designation</label>
            <input
              name="designation"
              value={form.designation}
              onChange={handleChange}
              style={{ width: "100%", marginBottom: 10 }}
            />

            <label>Skill</label>
            <select
              name="skill"
              value={form.skill}
              onChange={handleChange}
              style={{ width: "100%", marginBottom: 10 }}
            >
              <option value="">Select Skill</option>
              {skills.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>

            <label>Manager</label>
            <input
              name="manager"
              value={form.manager}
              onChange={handleChange}
              style={{ width: "100%", marginBottom: 10 }}
            />

            <label>Group Lead</label>
            <input
              name="groupLead"
              value={form.groupLead}
              onChange={handleChange}
              style={{ width: "100%", marginBottom: 10 }}
            />

            <label>Phone</label>
            <input
              name="phone"
              value={form.phone}
              onChange={handleChange}
              style={{ width: "100%", marginBottom: 10 }}
            />

            <label>Date of Joining</label>
            <input
              type="date"
              name="doj"
              value={form.doj}
              onChange={handleChange}
              style={{ width: "100%", marginBottom: 16 }}
            />

            <div style={{ textAlign: "right" }}>
              <button onClick={() => setShowModal(false)}>Cancel</button>
              <button
                onClick={saveProfile}
                disabled={saving}
                style={{
                  marginLeft: 8,
                  background: "#4caf50",
                  color: "#fff",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: 6,
                }}
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

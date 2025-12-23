import { useEffect, useState } from "react";
import Layout from "../../components/Layout";

export default function ManageUsers() {
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    const token = localStorage.getItem("token");

    try {
      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/admin/users`,
        {
          headers: {
            Authorization: `Bearer ${token}` // ✅ FIX
          }
        }
      );

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setError("Unauthorized. Admin access required.");
          return;
        }
        throw new Error(`Failed with status ${res.status}`);
      }

      const data = await res.json();
      setUsers(data);
    } catch (err) {
      console.error("Error fetching users:", err);
      setError("Failed to load users");
    }
  };

  const updateUser = async (email, action, role, status) => {
    const token = localStorage.getItem("token");

    try {
      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/admin/users`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}` // ✅ CORRECT
          },
          body: JSON.stringify({ email, action, role, status })
        }
      );

      if (!res.ok) {
        throw new Error(`Update failed with status ${res.status}`);
      }

      await fetchUsers(); // refresh list
    } catch (err) {
      console.error("Error updating user:", err);
      alert("Failed to update user");
    }
  };

  const styles = {
    container: {
      backgroundColor: "rgba(255,255,255,0.9)",
      padding: "24px",
      borderRadius: "12px"
    },
    table: { width: "100%", borderCollapse: "collapse" },
    th: {
      border: "1px solid #ddd",
      padding: "8px",
      backgroundColor: "#f2f2f2",
      textAlign: "left"
    },
    td: { border: "1px solid #ddd", padding: "8px" },
    button: {
      padding: "6px 12px",
      margin: "2px",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer"
    },
    approve: { backgroundColor: "#4caf50", color: "white" },
    reject: { backgroundColor: "#f44336", color: "white" },
    block: { backgroundColor: "#ff9800", color: "white" },
    activate: { backgroundColor: "#2196f3", color: "white" },
    select: { padding: "4px" },
    error: { color: "red", marginBottom: "12px" }
  };

  return (
    <Layout>
      <div style={styles.container}>
        <h2>Manage Users</h2>

        {error && <p style={styles.error}>{error}</p>}

        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Email</th>
              <th style={styles.th}>Role</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Created At</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.email}>
                <td style={styles.td}>{user.email}</td>

                <td style={styles.td}>
                  <select
                    value={user.role}
                    onChange={(e) =>
                      updateUser(
                        user.email,
                        "changeRole",
                        e.target.value
                      )
                    }
                    style={styles.select}
                  >
                    <option value="USER">USER</option>
                    <option value="ADMIN">ADMIN</option>
                  </select>
                </td>

                <td style={styles.td}>{user.status}</td>

                <td style={styles.td}>
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>

                <td style={styles.td}>
                  {user.status === "PENDING" && (
                    <>
                      <button
                        style={{ ...styles.button, ...styles.approve }}
                        onClick={() =>
                          updateUser(user.email, "approve")
                        }
                      >
                        Approve
                      </button>

                      <button
                        style={{ ...styles.button, ...styles.reject }}
                        onClick={() =>
                          updateUser(user.email, "reject")
                        }
                      >
                        Reject
                      </button>
                    </>
                  )}

                  {user.status === "ACTIVE" && (
                    <button
                      style={{ ...styles.button, ...styles.block }}
                      onClick={() =>
                        updateUser(user.email, "block")
                      }
                    >
                      Block
                    </button>
                  )}

                  {user.status === "BLOCKED" && (
                    <button
                      style={{ ...styles.button, ...styles.activate }}
                      onClick={() =>
                        updateUser(user.email, "activate")
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
    </Layout>
  );
}

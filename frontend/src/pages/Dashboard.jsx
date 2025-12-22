import { Link } from "react-router-dom";
import { getRole, logout } from "../services/auth";
import Layout from "../components/Layout";

export default function Dashboard() {
  const role = getRole();

  const styles = {
    overlay: {
      backgroundColor: "rgba(255,255,255,0.9)",
      padding: "24px",
      borderRadius: "12px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start"
    },

    left: {
      width: "25%"
    },

    center: {
      width: "20%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center"
    },

    right: {
      width: "25%",
      textAlign: "right"
    },

    title: {
      fontSize: "32px",
      fontWeight: "bold",
      marginBottom: "20px"
    },

    button: {
      display: "block",
      width: "220px",
      marginBottom: "12px",
      backgroundColor: "#1976d2",
      color: "white",
      border: "none",
      padding: "14px",
      borderRadius: "8px",
      fontSize: "16px",
      cursor: "pointer",
      textDecoration: "none",
      textAlign: "center"
    },

    lightGreen: { backgroundColor: "#81c784" },
    bloodRed: { backgroundColor: "#b71c1c" },
    darkGreen: { backgroundColor: "#1b5e20" },

    searchBox: {
      marginTop: "20px"
    },

    searchInput: {
      width: "200px",
      padding: "14px",
      fontSize: "16px",
      borderRadius: "8px",
      border: "1px solid #ccc"
    },

    chatbox: {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      width: "300px",
      height: "360px",
      background: "white",
      borderRadius: "10px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      padding: "12px"
    }
  };

  return (
    <Layout>
      <div style={styles.overlay}>
        {/* LEFT SIDE */}
        <div style={styles.left}>
          <div style={styles.title}>Dashboard</div>

          <Link to="/attendance" style={styles.button}>Attendance</Link>
          <Link to="/training" style={styles.button}>Training</Link>
          <Link to="/work" style={styles.button}>Work</Link>
          <Link to="/performance" style={styles.button}>Performance</Link>
          <Link to="/expertise" style={styles.button}>Expertise</Link>

          {role === "Admin" && (
            <>
              <h3>Admin Panel</h3>
              <Link to="/admin/users" style={styles.button}>Manage Users</Link>
              <Link to="/admin/tasks" style={styles.button}>Manage Tasks</Link>
              <Link to="/admin/resignations" style={styles.button}>Resignations</Link>
            </>
          )}
        </div>

        {/* CENTER */}
        <div style={styles.center}>
          <div style={styles.searchBox}>
            <input style={styles.searchInput} placeholder="Search..." />
          </div>
        </div>

        {/* RIGHT SIDE */}
        <div style={styles.right}>
          <Link to="/profile" style={{ ...styles.button, ...styles.lightGreen }}>
            Profile
          </Link>

          <Link to="/payroll" style={{ ...styles.button, ...styles.lightGreen }}>
            Payroll
          </Link>

          <Link to="/exit" style={{ ...styles.button, ...styles.bloodRed }}>
            Exit the Firm
          </Link>

          <button
            style={{ ...styles.button, ...styles.darkGreen, marginTop: "30px" }}
            onClick={logout}
          >
            Logout
          </button>
        </div>
      </div>

      {/* CHATBOX */}
      <div style={styles.chatbox}>
        <strong>DGV Assistant 🤖</strong>
        <textarea
          placeholder="Ask me anything..."
          style={{ width: "100%", height: "240px", marginTop: "10px" }}
        />
        <button style={{ ...styles.button, width: "100%" }}>Ask</button>
      </div>
    </Layout>
  );
}

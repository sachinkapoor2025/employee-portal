import { getRole, logout } from "../services/auth";

export default function Dashboard() {
  const role = getRole();

  const go = (path) => {
    window.location.href = path;
  };

  const styles = {
    page: {
      minHeight: "100vh",
      padding: "20px",
      fontFamily: "Arial, sans-serif",
      backgroundImage: "url('/images/company.jpg')",
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat"
    },

    overlay: {
      backgroundColor: "rgba(255,255,255,0.9)",
      padding: "24px",
      borderRadius: "12px",
      display: "flex",
      justifyContent: "space-between"
    },

    left: {
      width: "55%"
    },

    right: {
      width: "35%",
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
      cursor: "pointer"
    },

    lightGreen: { backgroundColor: "#81c784" },
    bloodRed: { backgroundColor: "#b71c1c" },
    darkGreen: { backgroundColor: "#1b5e20" },

    searchBox: {
      margin: "30px 0"
    },

    searchInput: {
      width: "100%",
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
    <div style={styles.page}>
      <div style={styles.overlay}>

        {/* LEFT SIDE */}
        <div style={styles.left}>
          <div style={styles.title}>Dashboard</div>

          <button style={styles.button} onClick={() => go("/attendance")}>Attendance</button>
          <button style={styles.button} onClick={() => go("/training")}>Training</button>
          <button style={styles.button} onClick={() => go("/work")}>Work</button>
          <button style={styles.button} onClick={() => go("/performance")}>Performance</button>
          <button style={styles.button} onClick={() => go("/expertise")}>Expertise</button>

          <div style={styles.searchBox}>
            <input style={styles.searchInput} placeholder="Search..." />
          </div>

          {role === "Admin" && (
            <>
              <h3>Admin Panel</h3>
              <button style={styles.button} onClick={() => go("/admin/users")}>Manage Users</button>
              <button style={styles.button} onClick={() => go("/admin/tasks")}>Manage Tasks</button>
              <button style={styles.button} onClick={() => go("/admin/resignations")}>Resignations</button>
            </>
          )}
        </div>

        {/* RIGHT SIDE */}
        <div style={styles.right}>
          <button style={{ ...styles.button, ...styles.lightGreen }} onClick={() => go("/profile")}>
            Profile
          </button>

          <button style={{ ...styles.button, ...styles.lightGreen }} onClick={() => go("/payroll")}>
            Payroll
          </button>

          <button style={{ ...styles.button, ...styles.bloodRed }} onClick={() => go("/exit")}>
            Exit the Firm
          </button>

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

    </div>
  );
}

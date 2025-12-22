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
      backgroundColor: "rgba(255, 255, 255, 0.9)",
      padding: "20px",
      borderRadius: "12px"
    },

    header: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center"
    },

    title: {
      fontSize: "32px",
      fontWeight: "bold"
    },

    topMenu: {
      display: "flex",
      gap: "14px",
      marginTop: "30px",
      flexWrap: "wrap"
    },

    button: {
      backgroundColor: "#1976d2",
      color: "white",
      border: "none",
      padding: "14px 22px",
      borderRadius: "8px",
      fontSize: "16px",
      cursor: "pointer"
    },

    lightGreen: {
      backgroundColor: "#81c784"
    },

    bloodRed: {
      backgroundColor: "#b71c1c"
    },

    darkGreen: {
      backgroundColor: "#1b5e20"
    },

    searchBox: {
      margin: "40px 0",
      display: "flex",
      justifyContent: "center"
    },

    searchInput: {
      width: "50%",
      padding: "14px",
      fontSize: "16px",
      borderRadius: "8px",
      border: "1px solid #ccc"
    },

    section: {
      marginTop: "30px"
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.overlay}>

        {/* HEADER */}
        <div style={styles.header}>
          <div style={styles.title}>Dashboard</div>
          <button
            style={{ ...styles.button, ...styles.darkGreen }}
            onClick={logout}
          >
            Logout
          </button>
        </div>

        {/* TOP MENU */}
        <div style={styles.topMenu}>
          <button style={styles.button} onClick={() => go("/attendance")}>Attendance</button>
          <button style={styles.button} onClick={() => go("/training")}>Training</button>
          <button style={styles.button} onClick={() => go("/work")}>Work</button>
          <button style={styles.button} onClick={() => go("/performance")}>Performance</button>
          <button style={styles.button} onClick={() => go("/expertise")}>Expertise</button>
        </div>

        {/* SEARCH */}
        <div style={styles.searchBox}>
          <input
            style={styles.searchInput}
            placeholder="Search..."
          />
        </div>

        {/* BOTTOM ACTIONS */}
        <div style={styles.topMenu}>
          <button
            style={{ ...styles.button, ...styles.lightGreen }}
            onClick={() => go("/profile")}
          >
            Profile
          </button>

          <button
            style={{ ...styles.button, ...styles.lightGreen }}
            onClick={() => go("/payroll")}
          >
            Payroll
          </button>

          <button
            style={{ ...styles.button, ...styles.bloodRed }}
            onClick={() => go("/exit")}
          >
            Exit
          </button>
        </div>

        {/* ADMIN SECTION */}
        {role === "Admin" && (
          <div style={styles.section}>
            <h3>Admin Panel</h3>

            <div style={styles.topMenu}>
              <button style={styles.button} onClick={() => go("/admin/users")}>
                Manage Users
              </button>

              <button style={styles.button} onClick={() => go("/admin/tasks")}>
                Manage Tasks
              </button>

              <button style={styles.button} onClick={() => go("/admin/resignations")}>
                Resignations
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

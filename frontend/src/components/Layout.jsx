import { useNavigate } from "react-router-dom";
import { logout } from "../services/auth";

export default function Layout({ children }) {
  const navigate = useNavigate();
  const role = localStorage.getItem("role") || "USER";

  const styles = {
    page: {
      minHeight: "100vh",
      padding: "20px",
      fontFamily: "Arial, sans-serif",
      backgroundImage: "url('/images/dgv_bg.png')",
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      backgroundAttachment: "fixed"
    },
    nav: {
      backgroundColor: "rgba(255,255,255,0.9)",
      padding: "10px",
      borderRadius: "8px",
      marginBottom: "20px",
      textAlign: "center"
    },
    navButton: {
      display: "inline-block",
      margin: "0 5px",
      backgroundColor: "#1976d2",
      color: "white",
      border: "none",
      padding: "10px 15px",
      borderRadius: "8px",
      fontSize: "14px",
      cursor: "pointer",
      textDecoration: "none",
      textAlign: "center"
    }
  };

  return (
    <div style={styles.page}>
      <nav style={styles.nav}>
        <button style={styles.navButton} onClick={() => navigate("/")}>Dashboard</button>
        <button style={styles.navButton} onClick={() => navigate("/attendance")}>Attendance</button>
        <button style={styles.navButton} onClick={() => navigate("/training")}>Training</button>
        <button style={styles.navButton} onClick={() => navigate("/work")}>Work</button>
        <button style={styles.navButton} onClick={() => navigate("/performance")}>Performance</button>
        <button style={styles.navButton} onClick={() => navigate("/expertise")}>Expertise</button>
        <button style={styles.navButton} onClick={() => navigate("/profile")}>Profile</button>
        <button style={styles.navButton} onClick={() => navigate("/payroll")}>Payroll</button>
        <button style={styles.navButton} onClick={() => navigate("/exit")}>Exit the Firm</button>
        {role === 'ADMIN' && (
          <>
            <button style={styles.navButton} onClick={() => navigate("/admin/users")}>Manage Users</button>
          </>
        )}
        <button style={styles.navButton} onClick={logout}>Logout</button>
      </nav>
      {children}
    </div>
  );
}

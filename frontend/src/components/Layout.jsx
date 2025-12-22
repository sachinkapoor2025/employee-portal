import { Link } from "react-router-dom";

export default function Layout({ children }) {
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
    navLink: {
      margin: "0 10px",
      color: "#1976d2",
      textDecoration: "none"
    }
  };

  return (
    <div style={styles.page}>
      <nav style={styles.nav}>
        <Link to="/" style={styles.navLink}>Dashboard</Link>
        <Link to="/attendance" style={styles.navLink}>Attendance</Link>
        <Link to="/training" style={styles.navLink}>Training</Link>
        <Link to="/work" style={styles.navLink}>Work</Link>
        <Link to="/performance" style={styles.navLink}>Performance</Link>
        <Link to="/expertise" style={styles.navLink}>Expertise</Link>
        <Link to="/profile" style={styles.navLink}>Profile</Link>
        <Link to="/payroll" style={styles.navLink}>Payroll</Link>
        <Link to="/exit" style={styles.navLink}>Exit</Link>
      </nav>
      {children}
    </div>
  );
}

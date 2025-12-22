import { getRole, logout } from "../services/auth";

export default function Dashboard() {
  const role = getRole();

  const go = (path) => {
    window.location.href = path;
  };

  const buttonStyle = {
    padding: "10px 16px",
    margin: "6px",
    backgroundColor: "#1976d2",
    color: "white",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer"
  };

  const dangerButton = {
    ...buttonStyle,
    backgroundColor: "#d32f2f"
  };

  return (
    <div style={{ padding: "20px" }}>
      <h2>Dashboard</h2>

      {/* Employee Actions */}
      <div>
        <button style={buttonStyle} onClick={() => go("/attendance")}>Attendance</button>
        <button style={buttonStyle} onClick={() => go("/training")}>Training</button>
        <button style={buttonStyle} onClick={() => go("/work")}>Work</button>
        <button style={buttonStyle} onClick={() => go("/performance")}>Performance</button>
        <button style={buttonStyle} onClick={() => go("/expertise")}>Expertise</button>
        <button style={buttonStyle} onClick={() => go("/profile")}>Profile</button>
        <button style={buttonStyle} onClick={() => go("/payroll")}>Payroll</button>
        <button style={buttonStyle} onClick={() => go("/exit")}>Exit</button>
      </div>

      {/* Admin Section */}
      {role === "Admin" && (
        <>
          <h3 style={{ marginTop: "20px" }}>Admin Panel</h3>
          <button style={buttonStyle} onClick={() => go("/admin/users")}>Manage Users</button>
          <button style={buttonStyle} onClick={() => go("/admin/tasks")}>Manage Tasks</button>
          <button style={buttonStyle} onClick={() => go("/admin/resignations")}>Resignations</button>
        </>
      )}

      {/* Logout */}
      <div style={{ marginTop: "30px" }}>
        <button style={dangerButton} onClick={logout}>Logout</button>
      </div>
    </div>
  );
}

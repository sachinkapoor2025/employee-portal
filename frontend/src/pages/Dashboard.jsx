import { useNavigate } from "react-router-dom";
import { getRole, logout } from "../services/auth";

export default function Dashboard() {
  const navigate = useNavigate();
  const role = getRole();

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
        <button style={buttonStyle} onClick={() => navigate("/attendance")}>
          Attendance
        </button>

        <button style={buttonStyle} onClick={() => navigate("/training")}>
          Training
        </button>

        <button style={buttonStyle} onClick={() => navigate("/work")}>
          Work
        </button>

        <button style={buttonStyle} onClick={() => navigate("/performance")}>
          Performance
        </button>

        <button style={buttonStyle} onClick={() => navigate("/expertise")}>
          Expertise
        </button>

        <button style={buttonStyle} onClick={() => navigate("/profile")}>
          Profile
        </button>

        <button style={buttonStyle} onClick={() => navigate("/payroll")}>
          Payroll
        </button>

        <button style={buttonStyle} onClick={() => navigate("/exit")}>
          Exit
        </button>
      </div>

      {/* Admin Section */}
      {role === "Admin" && (
        <>
          <h3 style={{ marginTop: "20px" }}>Admin Panel</h3>

          <button style={buttonStyle} onClick={() => navigate("/admin/users")}>
            Manage Users
          </button>

          <button style={buttonStyle} onClick={() => navigate("/admin/tasks")}>
            Manage Tasks
          </button>

          <button style={buttonStyle} onClick={() => navigate("/admin/resignations")}>
            Resignations
          </button>
        </>
      )}

      {/* Logout */}
      <div style={{ marginTop: "30px" }}>
        <button style={dangerButton} onClick={logout}>
          Logout
        </button>
      </div>
    </div>
  );
}

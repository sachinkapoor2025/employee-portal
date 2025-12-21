import { getRole, logout } from "../services/auth";

export default function Dashboard() {
  const role = getRole();

  return (
    <div>
      <h2>Dashboard</h2>

      <a href="/attendance">Attendance</a><br />
      <a href="/training">Training</a><br />

      {role === "Admin" && (
        <>
          <h3>Admin</h3>
          <a href="/admin/users">Manage Users</a>
        </>
      )}

      <br />
      <button onClick={logout}>Logout</button>
    </div>
  );
}

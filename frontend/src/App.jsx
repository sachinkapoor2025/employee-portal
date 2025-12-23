import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Callback from "./pages/Callback";
import Dashboard from "./pages/Dashboard";
import Attendance from "./pages/Attendance";
import Training from "./pages/Training";
import Work from "./pages/Work";
import Performance from "./pages/Performance";
import Expertise from "./pages/Expertise";
import Profile from "./pages/Profile";
import Payroll from "./pages/Payroll";
import Exit from "./pages/Exit";
import ManageUsers from "./pages/Admin/ManageUsers";
import ManageTasks from "./pages/Admin/ManageTasks";
import Resignations from "./pages/Admin/Resignations";
import RequestAccess from "./pages/RequestAccess";
import Blocked from "./pages/Blocked";

export default function App() {
  const token = localStorage.getItem("token");
  const role = localStorage.getItem("role");

  return (
    <Router>
      <Routes>
        {/* Public */}
        <Route path="/callback" element={<Callback />} />
        <Route path="/request-access" element={<RequestAccess />} />
        <Route path="/blocked" element={<Blocked />} />

        {/* Authenticated */}
        {token ? (
          <>
            <Route path="/" element={<Dashboard />} />
            <Route path="/attendance" element={<Attendance />} />
            <Route path="/training" element={<Training />} />
            <Route path="/work" element={<Work />} />
            <Route path="/performance" element={<Performance />} />
            <Route path="/expertise" element={<Expertise />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/payroll" element={<Payroll />} />
            <Route path="/exit" element={<Exit />} />

            {role === "ADMIN" && (
              <>
                <Route path="/admin/users" element={<ManageUsers />} />
                <Route path="/admin/tasks" element={<ManageTasks />} />
                <Route path="/admin/resignations" element={<Resignations />} />
              </>
            )}
          </>
        ) : (
          <Route path="*" element={<Login />} />
        )}
      </Routes>
    </Router>
  );
}

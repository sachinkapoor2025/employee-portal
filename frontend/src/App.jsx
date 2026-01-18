import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";

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
import RequestAccess from "./pages/RequestAccess";
import Blocked from "./pages/Blocked";

// ADMIN
import ManageUsers from "./pages/Admin/ManageUsers";
import ManageTasks from "./pages/Admin/ManageTasks";
import Resignations from "./pages/Admin/Resignations";
import AddTraining from "./pages/Admin/AddTraining";

export default function App() {
  const token = localStorage.getItem("token");
  const role = localStorage.getItem("role");

  return (
    <Router>
      <Routes>
        {/* PUBLIC */}
        <Route path="/login" element={<Login />} />
        <Route path="/callback" element={<Callback />} />
        <Route path="/request-access" element={<RequestAccess />} />
        <Route path="/blocked" element={<Blocked />} />

        {!token && <Route path="*" element={<Navigate to="/login" />} />}

        {token && (role === "USER" || role === "ADMIN") && (
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
          </>
        )}

        {token && role === "ADMIN" && (
          <>
            <Route path="/admin/users" element={<ManageUsers />} />
            <Route path="/admin/tasks" element={<ManageTasks />} />
            <Route path="/admin/resignations" element={<Resignations />} />
            <Route path="/admin/add-training" element={<AddTraining />} />
          </>
        )}

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}

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

export default function App() {
  const token = localStorage.getItem("token");
  const role = localStorage.getItem("role");

  return (
    <Router>
      <Routes>
        {/* Public */}
        <Route path="/login" element={<Login />} />
        <Route path="/callback" element={<Callback />} />
        <Route path="/request-access" element={<RequestAccess />} />

        {/* Not logged in */}
        {!token && <Route path="*" element={<Navigate to="/login" />} />}

        {/* USER ROUTES */}
        {token && role === "USER" && (
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

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}

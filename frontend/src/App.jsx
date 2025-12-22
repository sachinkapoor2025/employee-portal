import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import Login from "./pages/Login";
import Callback from "./pages/Callback";
import Dashboard from "./pages/Dashboard";
import Attendance from "./pages/Attendance";
import Training from "./pages/Training";
import Work from "./pages/Work";
import Performance from "./pages/Performance";
import Profile from "./pages/Profile";
import Payroll from "./pages/Payroll";
import Expertise from "./pages/Expertise";

const isAuthenticated = () => {
  return !!localStorage.getItem("token");
};

const PrivateRoute = ({ children }) => {
  return isAuthenticated() ? children : <Navigate to="/" replace />;
};

export default function App() {
  return (
    <BrowserRouter>
      <Routes>

        {/* Public */}
        <Route path="/" element={<Login />} />
        <Route path="/callback" element={<Callback />} />

        {/* Protected */}
        <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
        <Route path="/attendance" element={<PrivateRoute><Attendance /></PrivateRoute>} />
        <Route path="/training" element={<PrivateRoute><Training /></PrivateRoute>} />
        <Route path="/work" element={<PrivateRoute><Work /></PrivateRoute>} />
        <Route path="/performance" element={<PrivateRoute><Performance /></PrivateRoute>} />
        <Route path="/profile" element={<PrivateRoute><Profile /></PrivateRoute>} />
        <Route path="/payroll" element={<PrivateRoute><Payroll /></PrivateRoute>} />
        <Route path="/expertise" element={<PrivateRoute><Expertise /></PrivateRoute>} />

        {/* Default */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />

      </Routes>
    </BrowserRouter>
  );
}

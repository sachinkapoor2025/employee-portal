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

import ManageUsers from "./pages/Admin/ManageUsers";
import ManageTasks from "./pages/Admin/ManageTasks";
import Resignations from "./pages/Admin/Resignations";
import AddTraining from "./pages/Admin/AddTraining";
import AdminDashboard from "./pages/Admin/AdminDashboard";
import TeamActivity from "./pages/Admin/TeamActivity";
import LeaveManagement from "./pages/Admin/LeaveManagement";
import AdminAnnouncements from "./pages/Admin/AdminAnnouncements";
import Leave from "./pages/Leave";
import Downloads from "./pages/Downloads";
import ConsentGate from "./components/ConsentGate";
import ActivityTracker from "./components/ActivityTracker";

function getAuth() {
  return {
    token: localStorage.getItem("token"),
    role: localStorage.getItem("role"),
  };
}

function RequireAuth({ children, adminOnly = false }) {
  const { token, role } = getAuth();

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  if (!role) {
    return <Navigate to="/request-access" replace />;
  }

  if (adminOnly && role !== "ADMIN") {
    return <Navigate to="/" replace />;
  }

  return (
    <ConsentGate>
      {children}
    </ConsentGate>
  );
}

function HomeRedirect() {
  const { token, role } = getAuth();

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  if (!role) {
    return <Navigate to="/request-access" replace />;
  }

  if (role === "ADMIN") {
    return <Navigate to="/admin/dashboard" replace />;
  }

  return <Dashboard />;
}

export default function App() {
  return (
    <Router>
      <ActivityTracker />
      <Routes>
        {/* Public */}
        <Route path="/login" element={<Login />} />
        <Route path="/callback" element={<Callback />} />
        <Route path="/request-access" element={<RequestAccess />} />
        <Route path="/blocked" element={<Blocked />} />

        {/* Home */}
        <Route path="/" element={<HomeRedirect />} />

        {/* Employee */}
        <Route
          path="/attendance"
          element={
            <RequireAuth>
              <Attendance />
            </RequireAuth>
          }
        />
        <Route
          path="/training"
          element={
            <RequireAuth>
              <Training />
            </RequireAuth>
          }
        />
        <Route
          path="/work"
          element={
            <RequireAuth>
              <Work />
            </RequireAuth>
          }
        />
        <Route
          path="/performance"
          element={
            <RequireAuth>
              <Performance />
            </RequireAuth>
          }
        />
        <Route
          path="/expertise"
          element={
            <RequireAuth>
              <Expertise />
            </RequireAuth>
          }
        />
        <Route
          path="/profile"
          element={
            <RequireAuth>
              <Profile />
            </RequireAuth>
          }
        />
        <Route
          path="/payroll"
          element={
            <RequireAuth>
              <Payroll />
            </RequireAuth>
          }
        />
        <Route
          path="/exit"
          element={
            <RequireAuth>
              <Exit />
            </RequireAuth>
          }
        />

        <Route
          path="/leave"
          element={
            <RequireAuth>
              <Leave />
            </RequireAuth>
          }
        />
        <Route
          path="/downloads"
          element={
            <RequireAuth>
              <Downloads />
            </RequireAuth>
          }
        />

        {/* Admin */}
        <Route
          path="/admin/dashboard"
          element={
            <RequireAuth adminOnly>
              <AdminDashboard />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/activity"
          element={
            <RequireAuth adminOnly>
              <TeamActivity />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/leave"
          element={
            <RequireAuth adminOnly>
              <LeaveManagement />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/announcements"
          element={
            <RequireAuth adminOnly>
              <AdminAnnouncements />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/users"
          element={
            <RequireAuth adminOnly>
              <ManageUsers />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/tasks"
          element={
            <RequireAuth adminOnly>
              <ManageTasks />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/resignations"
          element={
            <RequireAuth adminOnly>
              <Resignations />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/add-training"
          element={
            <RequireAuth adminOnly>
              <AddTraining />
            </RequireAuth>
          }
        />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

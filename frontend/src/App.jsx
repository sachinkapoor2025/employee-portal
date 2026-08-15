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
import Documents from "./pages/Documents";
import Meetings from "./pages/Meetings";
import AdminMeetings from "./pages/Admin/Meetings";
import AdminDocuments from "./pages/Admin/Documents";
import Payroll from "./pages/Payroll";
import Exit from "./pages/Exit";
import RequestAccess from "./pages/RequestAccess";
import Blocked from "./pages/Blocked";

import ManageUsers from "./pages/Admin/ManageUsers";
import ManageTasks from "./pages/Admin/ManageTasks";
import TaskDetails from "./pages/Admin/TaskDetails";
import Resignations from "./pages/Admin/Resignations";
import AddTraining from "./pages/Admin/AddTraining";
import AdminDashboard from "./pages/Admin/AdminDashboard";
import TeamActivity from "./pages/Admin/TeamActivity";
import LeaveManagement from "./pages/Admin/LeaveManagement";
import AdminAnnouncements from "./pages/Admin/AdminAnnouncements";
import AttendanceActivity from "./pages/Admin/AttendanceActivity";
import EmployeeTracking from "./pages/Admin/EmployeeTracking";
import EmployeeTrackingHub from "./pages/Admin/EmployeeTrackingHub";
import ComingSoon from "./pages/Admin/ComingSoon";
import Leave from "./pages/Leave";
import SoftwareCenter from "./pages/SoftwareCenter";
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
          path="/documents"
          element={
            <RequireAuth>
              <Documents />
            </RequireAuth>
          }
        />
        <Route
          path="/meetings"
          element={
            <RequireAuth>
              <Meetings />
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
          path="/software-center"
          element={
            <RequireAuth>
              <SoftwareCenter />
            </RequireAuth>
          }
        />
        <Route path="/downloads" element={<Navigate to="/software-center" replace />} />

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
          path="/admin/attendance-activity"
          element={
            <RequireAuth adminOnly>
              <AttendanceActivity />
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
          element={<Navigate to="/admin/employees" replace />}
        />
        <Route
          path="/admin/employees"
          element={
            <RequireAuth adminOnly>
              <ManageUsers />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/employees/:email/track"
          element={
            <RequireAuth adminOnly>
              <EmployeeTracking />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/employee-tracking"
          element={
            <RequireAuth adminOnly>
              <EmployeeTrackingHub />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/documents"
          element={
            <RequireAuth adminOnly>
              <AdminDocuments />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/meetings"
          element={
            <RequireAuth adminOnly>
              <AdminMeetings />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/reports"
          element={
            <RequireAuth adminOnly>
              <ComingSoon title="Reports" phase="Phase 5" />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/performance"
          element={<Navigate to="/admin/dashboard" replace />}
        />
        <Route
          path="/admin/admin-management"
          element={
            <RequireAuth adminOnly>
              <ComingSoon title="Admin Management" phase="Phase 5" />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/audit-logs"
          element={
            <RequireAuth adminOnly>
              <ComingSoon title="Audit Logs" phase="Phase 5" />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <RequireAuth adminOnly>
              <ComingSoon title="Settings" phase="Phase 5" />
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
          path="/admin/tasks/:taskId"
          element={
            <RequireAuth adminOnly>
              <TaskDetails />
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

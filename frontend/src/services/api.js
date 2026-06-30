const API =
  process.env.REACT_APP_API_URL ||
  "https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod";

export const api = async (path, method = "GET", body) => {
  const token = localStorage.getItem("token");
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : method === "POST" || method === "PUT" ? "{}" : null,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("API error:", res.status, text);
    throw new Error("API request failed");
  }

  return res.json();
};

/* ================= SKILLS & TRAINING ================= */

export const fetchSkills = () => api("/skills", "GET");
export const fetchUserTrainings = () => api("/getUserTrainingList", "POST", {});
export const fetchTrainingVideoUrl = (video_s3_key) =>
  api("/getTrainingVideoUrl", "POST", { video_s3_key });
export const getTrainingUploadUrl = (fileName, skill) =>
  api("/getTrainingUploadUrl", "POST", { fileName, skill });
export const addTrainingMaterial = (data) =>
  api("/addTrainingMaterial", "POST", data);

/* ================= USERS (ADMIN) ================= */

export const fetchUsers = () => api("/admin/users", "GET");
export const fetchUserProfile = (email) =>
  api(
    email
      ? `/admin/getUserProfile?email=${encodeURIComponent(email)}`
      : "/admin/getUserProfile",
    "GET"
  );
export const saveUserProfile = (payload) =>
  api("/admin/save-user-profile", "POST", payload);
export const updateUserRole = (email, role) =>
  api("/admin/users", "POST", { email, action: "changeRole", role });
export const updateUserStatus = (email, action) =>
  api("/admin/users", "POST", { email, action });

/* ================= PROFILE IMAGE ================= */

export const getProfileImageUploadUrl = (file, email) =>
  api("/getProfileImageUploadUrl", "POST", {
    fileName: file.name,
    contentType: file.type,
    email,
  });

/* ================= ACTIVITY ================= */

export const logActivity = (payload) => api("/activity", "POST", payload);
export const fetchMyActivityToday = (date) =>
  api(`/activity/today${date ? `?date=${date}` : ""}`, "GET");
export const fetchAdminActivity = (date) =>
  api(`/admin/activity${date ? `?date=${date}` : ""}`, "GET");
export const fetchAdminDashboard = () => api("/admin/dashboard", "GET");

/* ================= PROJECTS & TASKS ================= */

export const fetchProjects = () => api("/projects", "GET");
export const createProject = (data) => api("/projects", "POST", data);
export const fetchTasks = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return api(`/tasks${qs ? `?${qs}` : ""}`, "GET");
};
export const createTask = (data) => api("/tasks", "POST", data);
export const updateTask = (data) => api("/tasks", "PUT", data);
export const logTimeEntry = (data) => api("/time-entries", "POST", data);
export const fetchTimeEntries = (email) =>
  api(`/time-entries${email ? `?email=${encodeURIComponent(email)}` : ""}`, "GET");

/* ================= LEAVE ================= */

export const fetchMyLeave = () => api("/leave", "GET");
export const fetchAllLeave = () => api("/leave?all=true", "GET");
export const applyLeave = (data) => api("/leave", "POST", data);
export const reviewLeave = (leaveId, status) =>
  api("/leave", "PUT", { leaveId, status });

/* ================= ANNOUNCEMENTS ================= */

export const fetchAnnouncements = () => api("/announcements", "GET");
export const createAnnouncement = (data) =>
  api("/admin/announcements", "POST", data);
export const deleteAnnouncement = (announceId) =>
  api("/admin/announcements", "DELETE", { announceId });

/* ================= CONSENT & DOWNLOADS ================= */

export const fetchConsent = () => api("/consent", "GET");
export const acceptConsent = () => api("/consent", "POST", {});
export const fetchAgentDownload = () => api("/downloads/agent", "GET");

/* ================= ATTENDANCE ================= */

export const fetchAttendance = (startDate, endDate) =>
  api(`/attendance?startDate=${startDate}&endDate=${endDate}`, "GET");
export const saveAttendance = (records) =>
  api("/attendance", "POST", records);

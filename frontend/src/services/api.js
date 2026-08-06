const API =
  process.env.REACT_APP_API_URL ||
  "https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod";

function parseJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/** Returns true if JWT is missing or past exp (with 30s skew). */
export function isTokenExpired(token = localStorage.getItem("token")) {
  if (!token) return true;
  const payload = parseJwtPayload(token);
  if (!payload?.exp) return false;
  return Date.now() >= payload.exp * 1000 - 30_000;
}

function clearSessionAndRedirectToLogin() {
  try {
    localStorage.removeItem("token");
    localStorage.removeItem("role");
    localStorage.removeItem("actualRole");
  } catch {
    /* ignore */
  }
  if (!window.location.pathname.startsWith("/login")) {
    window.location.replace("/login");
  }
}

export const api = async (path, method = "GET", body) => {
  const token = localStorage.getItem("token");
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Session expired — stop calling APIs and send user to login
  if (token && isTokenExpired(token)) {
    clearSessionAndRedirectToLogin();
    throw new Error("Session expired. Please sign in again.");
  }

  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body:
        body !== undefined
          ? JSON.stringify(body)
          : method === "POST" || method === "PUT"
            ? "{}"
            : null,
    });
  } catch (networkErr) {
    // Browser reports CORS/network/offline as TypeError: Failed to fetch
    const err = new Error(
      "Unable to reach the server. Check your connection and try again."
    );
    err.cause = networkErr;
    err.isNetworkError = true;
    console.warn("API network error:", path, networkErr);
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    clearSessionAndRedirectToLogin();
    throw new Error("Session expired. Please sign in again.");
  }

  if (!res.ok) {
    const text = await res.text();
    console.error("API error:", res.status, text);
    let message = "API request failed";
    try {
      const data = JSON.parse(text);
      if (typeof data === "string" && data.trim()) message = data;
      else if (data?.error) message = data.error;
      else if (data?.message) message = data.message;
    } catch {
      if (text?.trim()) message = text.trim();
    }
    throw new Error(message);
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

export const deleteUser = (email) =>
  api("/admin/users", "POST", { email, action: "delete" });

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
/* ================= SOFTWARE CENTER ================= */

export const fetchSoftware = () => api("/software", "GET");
export const fetchAdminSoftware = () => api("/admin/software", "GET");
export const createSoftware = (data) => api("/admin/software", "POST", data);
export const updateSoftware = (data) => api("/admin/software", "PUT", data);
export const deleteSoftware = (softwareId) =>
  api("/admin/software", "DELETE", { softwareId });
export const getSoftwareUploadUrl = (fileName, softwareId) =>
  api("/admin/software/upload-url", "POST", { fileName, softwareId });

/* ================= ATTENDANCE ================= */

export const fetchAttendance = (startDate, endDate) =>
  api(`/attendance?startDate=${startDate}&endDate=${endDate}`, "GET");
export const saveAttendance = (records) =>
  api("/attendance", "POST", records);

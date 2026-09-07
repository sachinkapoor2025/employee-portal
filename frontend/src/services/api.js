import {
  isMeetingAnnouncement,
  parseMeetingAnnouncement,
  serializeMeetingAnnouncement,
  withComputedMeeting,
  toIsoDate,
  padTime,
  combineIstIso,
  displayNameFromEmail,
} from "../utils/meetings";

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

/** Same as api(), but 401/403 do not clear the session (for optional fallbacks). */
export const apiOptional = async (path, method = "GET", body) => {
  const token = localStorage.getItem("token");
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  if (token && isTokenExpired(token)) {
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
    const err = new Error(
      "Unable to reach the server. Check your connection and try again."
    );
    err.cause = networkErr;
    err.isNetworkError = true;
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
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

export const resetUserPassword = (email) =>
  api("/admin/users", "POST", { email, action: "resetPassword" });

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
export const fetchAdminActivity = (date, email) => {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  if (email) qs.set("email", email);
  const query = qs.toString();
  return api(`/admin/activity${query ? `?${query}` : ""}`, "GET");
};
export const fetchAdminDashboard = () => api("/admin/dashboard", "GET");

/* ================= PROJECTS & TASKS ================= */

export const fetchProjects = () => api("/projects", "GET");
export const createProject = (data) => api("/projects", "POST", data);
export const fetchTasks = async (params = {}) => {
  const data = await fetchTaskList(params);
  return data.tasks;
};

export const fetchTaskList = async (params = {}) => {
  const clean = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    clean[key] = value;
  });
  const qs = new URLSearchParams(clean).toString();
  const data = await api(`/tasks${qs ? `?${qs}` : ""}`, "GET");
  if (Array.isArray(data)) {
    return { tasks: data, zoneCounts: null };
  }
  return {
    tasks: Array.isArray(data?.tasks) ? data.tasks : [],
    zoneCounts: data?.zoneCounts || null,
  };
};
export const createTask = (data) => api("/tasks", "POST", data);
export const updateTask = (data) => api("/tasks", "PUT", data);
export const archiveTask = (taskId) =>
  api("/tasks", "DELETE", { taskId });

export const fetchTaskById = async (taskId) => {
  try {
    return await api(`/tasks/${encodeURIComponent(taskId)}`, "GET");
  } catch (err) {
    // Older/live API may not expose GET /tasks/{id} yet — fall back to list.
    const list = await fetchTasks({});
    const found = (Array.isArray(list) ? list : []).find(
      (t) => String(t.taskId) === String(taskId)
    );
    if (!found) throw err;
    return found;
  }
};

export const fetchTaskComments = (taskId) =>
  api(`/tasks/${encodeURIComponent(taskId)}/comments`, "GET");
export const postTaskComment = (taskId, text) =>
  api(`/tasks/${encodeURIComponent(taskId)}/comments`, "POST", { text });
export const fetchTaskActivity = (taskId) =>
  api(`/tasks/${encodeURIComponent(taskId)}/activity`, "GET");
export const fetchTaskAttachments = (taskId) =>
  api(`/tasks/${encodeURIComponent(taskId)}/attachments`, "GET");
export const getTaskAttachmentUploadUrl = (taskId, fileName, contentType, fileSize) =>
  api(`/tasks/${encodeURIComponent(taskId)}/attachment-upload-url`, "POST", {
    fileName,
    contentType,
    fileSize,
  });
export const registerTaskAttachment = (taskId, payload) =>
  api(`/tasks/${encodeURIComponent(taskId)}/attachments`, "POST", payload);
export const getTaskAttachmentDownloadUrl = (taskId, payload) =>
  api(
    `/tasks/${encodeURIComponent(taskId)}/attachment-download-url`,
    "POST",
    payload
  );
export const logTimeEntry = (data) => api("/time-entries", "POST", data);
export const fetchTimeEntries = (email) =>
  api(`/time-entries${email ? `?email=${encodeURIComponent(email)}` : ""}`, "GET");

/* ================= LEAVE ================= */

export const fetchMyLeave = () => api("/leave", "GET");
export const fetchAllLeave = () => api("/leave?all=true", "GET");
export const fetchLeaveNotifications = () =>
  api("/leave?notifications=true", "GET");
export const markNotificationRead = (sk) =>
  api("/leave", "PUT", { action: "readNotification", sk });
export const applyLeave = (data) => api("/leave", "POST", data);
export const reviewLeave = (leaveId, status, rejectionReason) =>
  api("/leave", "PUT", { leaveId, status, rejectionReason });

/* ================= RESIGNATION ================= */

function asResignationList(value, email, name) {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const id =
        row.resignationId ||
        String(row.SK || "").replace(/^RESIGNATION#/i, "") ||
        "";
      if (!id && !row.createdAt) return null;
      return {
        resignationId: id || row.createdAt,
        email: String(row.email || email || "").toLowerCase(),
        name: row.name || name || "",
        lastWorkingDay: row.lastWorkingDay || "",
        reason: row.reason || "",
        status: row.status || "SUBMITTED",
        createdAt: row.createdAt || null,
        reviewedAt: row.reviewedAt || null,
        reviewedBy: row.reviewedBy || null,
      };
    })
    .filter(Boolean);
}

function mergeResignations(...lists) {
  const byId = new Map();
  lists.flat().forEach((row) => {
    if (!row) return;
    const key = String(row.resignationId || `${row.email}-${row.createdAt}`);
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, row);
      return;
    }
    const prevTime = String(prev.reviewedAt || prev.createdAt || "");
    const nextTime = String(row.reviewedAt || row.createdAt || "");
    if (nextTime.localeCompare(prevTime) >= 0) byId.set(key, { ...prev, ...row });
  });
  return Array.from(byId.values()).sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
}

function profileWithoutMeta(profile) {
  const next = { ...(profile || {}) };
  delete next.PK;
  delete next.SK;
  delete next.profileImageUrl;
  delete next.imageStorageUrl;
  return next;
}

async function resignationsFromProfile(email) {
  const me = currentEmail();
  const profile = await fetchUserProfile(
    email && email !== me ? email : undefined
  );
  return asResignationList(
    profile?.resignations,
    profile?.email || email || me,
    profile?.name
  );
}

async function saveResignationsOnProfile(email, resignations, extraProfile = {}) {
  const me = currentEmail();
  const profile = await fetchUserProfile(
    email && email !== me ? email : undefined
  );
  await saveUserProfile({
    mode: "EDIT",
    email,
    profile: {
      ...profileWithoutMeta(profile),
      ...extraProfile,
      email,
      resignations,
    },
  });
  return resignations;
}

export const fetchMyResignations = async () => {
  const email = currentEmail();
  let fromApi = [];
  try {
    const rows = await apiOptional("/resignation", "GET");
    if (Array.isArray(rows)) fromApi = asResignationList(rows, email);
  } catch {
    fromApi = [];
  }
  let fromProfile = [];
  try {
    fromProfile = await resignationsFromProfile(email);
  } catch {
    fromProfile = [];
  }
  return mergeResignations(fromApi, fromProfile);
};

export const fetchAllResignations = async () => {
  let fromApi = [];
  try {
    const rows = await apiOptional("/resignation?all=true", "GET");
    if (Array.isArray(rows)) fromApi = asResignationList(rows);
  } catch {
    fromApi = [];
  }

  let fromProfiles = [];
  try {
    const users = await fetchUsers();
    const list = Array.isArray(users) ? users : [];
    const nested = await Promise.all(
      list.map(async (u) => {
        const email = String(u.email || "").toLowerCase();
        if (!email) return [];
        try {
          const profile = await fetchUserProfile(email);
          return asResignationList(
            profile?.resignations,
            email,
            profile?.name || u.name
          );
        } catch {
          return [];
        }
      })
    );
    fromProfiles = nested.flat();
  } catch {
    fromProfiles = [];
  }

  return mergeResignations(fromApi, fromProfiles);
};

export const submitResignation = async (data) => {
  const email = currentEmail();
  const lastWorkingDay = String(data?.lastWorkingDay || "").trim();
  const reason = String(data?.reason || "").trim();
  if (!lastWorkingDay || !reason) {
    throw new Error("lastWorkingDay and reason are required");
  }

  let apiRow = null;
  try {
    const res = await apiOptional("/resignation", "POST", {
      lastWorkingDay,
      reason,
    });
    apiRow = res?.resignation || null;
  } catch {
    apiRow = null;
  }

  const profile = await fetchUserProfile().catch(() => ({}));
  const existing = asResignationList(profile?.resignations, email, profile?.name);
  const item = {
    resignationId:
      apiRow?.resignationId ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    email,
    name: profile?.name || email.split("@")[0],
    lastWorkingDay,
    reason,
    status: "SUBMITTED",
    createdAt: new Date().toISOString(),
  };
  await saveResignationsOnProfile(email, [item, ...existing], {
    name: profile?.name || "",
  });
  return item;
};

export const reviewResignation = async (resignationId, status, email) => {
  const nextStatus = String(status || "").toUpperCase();
  try {
    await apiOptional("/resignation", "PUT", {
      resignationId,
      status: nextStatus,
      email,
    });
  } catch {
    /* live API may not support PUT yet */
  }

  const target = String(email || "").toLowerCase();
  if (!target) return;
  const profile = await fetchUserProfile(target);
  const existing = asResignationList(
    profile?.resignations,
    target,
    profile?.name
  );
  const reviewedAt = new Date().toISOString();
  const reviewedBy = currentEmail();
  const next = existing.map((row) =>
    row.resignationId === resignationId
      ? { ...row, status: nextStatus, reviewedAt, reviewedBy }
      : row
  );
  await saveResignationsOnProfile(target, next, { name: profile?.name || "" });
};

/* ================= ANNOUNCEMENTS ================= */

function filterPortalAnnouncements(items) {
  return (Array.isArray(items) ? items : []).filter(
    (a) => !isMeetingAnnouncement(a)
  );
}

export const fetchAnnouncements = async () => {
  const items = await api("/announcements", "GET");
  return filterPortalAnnouncements(items);
};

/**
 * Admin history. Uses apiOptional because GET /admin/announcements is a
 * newer method: API Gateway 403 (missing route) or "Admin required" must
 * not clear the session the way api() does for 401/403.
 */
export const fetchAnnouncementHistory = async () => {
  try {
    const items = await apiOptional("/admin/announcements", "GET");
    return filterPortalAnnouncements(items);
  } catch {
    return fetchAnnouncements();
  }
};
export const createAnnouncement = (data) =>
  api("/admin/announcements", "POST", data);
export const updateAnnouncement = (data) =>
  apiOptional("/admin/announcements", "PUT", data);
export const deleteAnnouncement = (announceId) =>
  api("/admin/announcements", "DELETE", { announceId });

/* ================= MEETINGS ================= */

function currentEmail() {
  const token = localStorage.getItem("token");
  const payload = parseJwtPayload(token);
  return String(
    payload?.email || payload?.["cognito:username"] || payload?.username || ""
  ).toLowerCase();
}

async function listStoredMeetings() {
  const items = await api("/announcements", "GET");
  return (Array.isArray(items) ? items : [])
    .map(parseMeetingAnnouncement)
    .filter(Boolean)
    .sort((a, b) =>
      String(a.startDateTime || "").localeCompare(String(b.startDateTime || ""))
    );
}

async function findStoredMeeting(meetingId) {
  const rows = await listStoredMeetings();
  return rows.find((m) => m.meetingId === meetingId) || null;
}

function buildMeetingRecord(data, existing) {
  const date = toIsoDate(data.date);
  const startTime = padTime(data.startTime);
  const endTime = padTime(data.endTime) || "";
  const startDateTime = combineIstIso(date, startTime);
  const endDateTime = combineIstIso(date, endTime);
  const names = data.participantNames || {};
  const emails = (data.participantEmails || []).map((e) =>
    String(e || "").trim().toLowerCase()
  );
  const prevByEmail = new Map(
    (existing?.participants || []).map((p) => [
      String(p.employeeId || "").toLowerCase(),
      p,
    ])
  );
  const now = new Date().toISOString();
  const participants = emails.map((email) => {
    const prev = prevByEmail.get(email);
    return {
      employeeId: email,
      employeeName: prev?.employeeName || names[email] || displayNameFromEmail(email),
      invitedAt: prev?.invitedAt || now,
      joinTime: prev?.joinTime || null,
      leaveTime: prev?.leaveTime || null,
      attendanceStatus: prev?.attendanceStatus || "INVITED",
    };
  });
  return withComputedMeeting({
    meetingId: existing?.meetingId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`),
    title: String(data.title || "").trim(),
    description: String(data.description || "").trim(),
    meetingType: data.meetingType || "ZOOM",
    meetingLink: String(data.meetingLink || "").trim(),
    date,
    startTime,
    endTime,
    startDateTime,
    endDateTime,
    createdBy: existing?.createdBy || currentEmail(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    status: existing?.status === "CANCELLED" ? "CANCELLED" : "SCHEDULED",
    cancelledAt: existing?.cancelledAt || null,
    participants,
    participantCount: participants.length,
  });
}

async function saveStoredMeeting(meeting, previousAnnounceId) {
  const created = await createAnnouncement(serializeMeetingAnnouncement(meeting));
  if (previousAnnounceId) {
    try {
      await deleteAnnouncement(previousAnnounceId);
    } catch {
      /* keep the new copy even if old delete fails */
    }
  }
  return parseMeetingAnnouncement(created) || withComputedMeeting({
    ...meeting,
    announceId: created?.announceId,
  });
}

export const fetchMyMeetings = async () => {
  const email = currentEmail();
  const rows = await listStoredMeetings();
  return rows.filter((m) =>
    (m.participants || []).some(
      (p) => String(p.employeeId || "").toLowerCase() === email
    )
  );
};

export const fetchMyMeeting = async (meetingId) => {
  const rows = await fetchMyMeetings();
  const meeting = rows.find((m) => m.meetingId === meetingId);
  if (!meeting) throw new Error("Meeting not found.");
  return meeting;
};

export const fetchAdminMeetings = () => listStoredMeetings();

export const fetchAdminMeeting = async (meetingId) => {
  const meeting = await findStoredMeeting(meetingId);
  if (!meeting) throw new Error("Meeting not found.");
  return meeting;
};

export const createMeeting = async (data) => {
  const meeting = buildMeetingRecord(data);
  if (!meeting.date) throw new Error("Date is required.");
  if (!meeting.startTime) throw new Error("Start time is required.");
  if (!meeting.endTime) throw new Error("Start time is required.");
  return saveStoredMeeting(meeting);
};

export const updateMeeting = async (data) => {
  const existing = await findStoredMeeting(data.meetingId);
  if (!existing) throw new Error("Meeting not found.");
  const meeting = buildMeetingRecord(data, existing);
  return saveStoredMeeting(meeting, existing.announceId);
};

export const cancelMeeting = async (meetingId) => {
  const existing = await findStoredMeeting(meetingId);
  if (!existing) throw new Error("Meeting not found.");
  const now = new Date().toISOString();
  const meeting = withComputedMeeting({
    ...existing,
    status: "CANCELLED",
    cancelledAt: now,
    updatedAt: now,
  });
  return saveStoredMeeting(meeting, existing.announceId);
};

export const joinMeeting = async (meetingId) => {
  const meeting = await fetchMyMeeting(meetingId);
  if (meeting.status === "CANCELLED") {
    throw new Error("This meeting has been cancelled.");
  }
  if (meeting.status === "COMPLETED") {
    throw new Error("This meeting has already ended.");
  }
  if (!meeting.meetingLink) {
    throw new Error("Meeting link is not available.");
  }
  return {
    ok: true,
    meetingLink: meeting.meetingLink,
    joinTime: new Date().toISOString(),
    attendanceStatus: "JOINED",
  };
};

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

export const fetchAttendance = (startDate, endDate, email) => {
  const qs = new URLSearchParams({ startDate, endDate });
  if (email) qs.set("email", email);
  return api(`/attendance?${qs.toString()}`, "GET");
};
export const saveAttendance = (records) =>
  api("/attendance", "POST", records);

/** Browser-time check-in persisted on today's attendance record */
export const attendanceCheckIn = ({ date, checkInTime }) =>
  api("/attendance", "POST", { action: "checkIn", date, checkInTime });

/** Browser-time check-out persisted on today's attendance record */
export const attendanceCheckOut = ({ date, checkOutTime }) =>
  api("/attendance", "POST", { action: "checkOut", date, checkOutTime });

/** Admin: all employees' check-in / check-out activity */
export const fetchAttendanceActivity = (params = {}) => {
  const qs = new URLSearchParams();
  if (params.date) qs.set("date", params.date);
  if (params.status) qs.set("status", params.status);
  if (params.search) qs.set("search", params.search);
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));
  const query = qs.toString();
  return api(`/admin/attendance-activity${query ? `?${query}` : ""}`, "GET");
};

/* ================= DOCUMENTS ================= */

export const fetchMyDocuments = () => api("/documents", "GET");
export const fetchAllDocuments = () => api("/admin/documents", "GET");
export const fetchEmployeeDocuments = (email) =>
  api(`/documents?email=${encodeURIComponent(email)}`, "GET");
export const fetchDocumentTypes = () => api("/documents/types", "GET");
export const updateDocumentTypes = (types) =>
  api("/documents/types", "PUT", { types });
export const getDocumentUploadUrl = (payload) =>
  api("/documents/upload-url", "POST", payload);
export const registerDocument = (payload) => api("/documents", "POST", payload);
export const getDocumentViewUrl = (documentId, disposition) =>
  api("/documents/view-url", "POST", { documentId, disposition });
export const reviewDocument = (documentId, status, rejectionReason) =>
  api("/documents", "PUT", { documentId, status, rejectionReason });
export const fetchDocumentHistory = (documentType, email) => {
  const qs = new URLSearchParams({ history: "true", documentType });
  if (email) qs.set("email", email);
  return api(`/documents?${qs.toString()}`, "GET");
};

function projectFolderPath(projectId, folderId, suffix = "") {
  const base =
    !folderId || folderId === "root"
      ? `/documents/projects/${encodeURIComponent(projectId)}`
      : `/documents/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`;
  return `${base}${suffix}`;
}

export const fetchDocumentProjects = () => api("/documents/projects", "GET");
export const createDocumentProject = (name) =>
  api("/documents/projects", "POST", { name });
export const renameDocumentProject = (projectId, name) =>
  api(`/documents/projects/${encodeURIComponent(projectId)}`, "PATCH", { name });
export const deleteDocumentProject = (projectId) =>
  api(`/documents/projects/${encodeURIComponent(projectId)}`, "DELETE");
export const fetchDocumentProjectFolder = (projectId, folderId) =>
  api(projectFolderPath(projectId, folderId, folderId && folderId !== "root" ? "" : "/folders"), "GET");
export const createDocumentProjectSubfolder = (projectId, folderId, name) =>
  api(projectFolderPath(projectId, folderId, "/subfolders"), "POST", { name });
export const uploadDocumentProjectFiles = (projectId, folderId, payload) =>
  api(projectFolderPath(projectId, folderId, "/files"), "POST", payload);
export const renameDocumentProjectFolder = (projectId, folderId, name) =>
  api(
    `/documents/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
    "PATCH",
    { name }
  );
export const deleteDocumentProjectFolder = (projectId, folderId) =>
  api(
    `/documents/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
    "DELETE"
  );
export const renameDocumentProjectFile = (projectId, folderId, fileId, name) =>
  api(`${projectFolderPath(projectId, folderId)}/files/${encodeURIComponent(fileId)}`, "PATCH", {
    name,
  });
export const deleteDocumentProjectFile = (projectId, folderId, fileId) =>
  api(`${projectFolderPath(projectId, folderId)}/files/${encodeURIComponent(fileId)}`, "DELETE");
export const getDocumentProjectDownloadUrl = (projectId, folderId, fileId) =>
  api(
    `${projectFolderPath(projectId, folderId)}/files/${encodeURIComponent(fileId)}/download-url`,
    "POST",
    {}
  );

function personalFolderPath(email, folderId, suffix = "") {
  const owner = String(email || "").trim().toLowerCase();
  const base = owner
    ? `/documents/personal/${encodeURIComponent(owner)}`
    : `/documents/personal`;
  if (!folderId || folderId === "root") return `${base}${suffix}`;
  return `${base}/folders/${encodeURIComponent(folderId)}${suffix}`;
}

export const fetchDocumentPersonalFolder = (email, folderId) =>
  api(personalFolderPath(email, folderId), "GET");
export const createDocumentPersonalSubfolder = (email, folderId, name) =>
  api(personalFolderPath(email, folderId, "/subfolders"), "POST", { name });
export const uploadDocumentPersonalFiles = (email, folderId, payload) =>
  api(personalFolderPath(email, folderId, "/files"), "POST", payload);
export const renameDocumentPersonalFolder = (email, folderId, name) =>
  api(
    `/documents/personal/${encodeURIComponent(email)}/folders/${encodeURIComponent(folderId)}`,
    "PATCH",
    { name }
  );
export const deleteDocumentPersonalFolder = (email, folderId) =>
  api(
    `/documents/personal/${encodeURIComponent(email)}/folders/${encodeURIComponent(folderId)}`,
    "DELETE"
  );
export const renameDocumentPersonalFile = (email, folderId, fileId, name) =>
  api(`${personalFolderPath(email, folderId)}/files/${encodeURIComponent(fileId)}`, "PATCH", {
    name,
  });
export const deleteDocumentPersonalFile = (email, folderId, fileId) =>
  api(`${personalFolderPath(email, folderId)}/files/${encodeURIComponent(fileId)}`, "DELETE");
export const getDocumentPersonalDownloadUrl = (email, folderId, fileId) =>
  api(
    `${personalFolderPath(email, folderId)}/files/${encodeURIComponent(fileId)}/download-url`,
    "POST",
    {}
  );

export const fetchDocumentNotificationFeed = () =>
  apiOptional("/documents/notifications/feed", "GET");
export const markDocumentNotificationsSeen = (lastSeenAt) =>
  apiOptional("/documents/notifications/mark-seen", "POST", {
    lastSeenAt: lastSeenAt || new Date().toISOString(),
  });

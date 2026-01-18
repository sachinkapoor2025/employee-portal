const API = process.env.REACT_APP_API_URL;

/* ================= CORE ================= */

export const api = async (path, method = "GET", body) => {
  const token = localStorage.getItem("token");

  const headers = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("API error:", res.status, text);
    throw new Error("API request failed");
  }

  return res.json();
};

/* ================= SKILLS ================= */

export const fetchSkills = () => api("/skills", "GET");

/* ================= TRAINING ================= */

export const fetchUserTrainings = () => api("/getUserTrainingList", "POST");

export const fetchTrainingVideoUrl = (video_s3_key) =>
  api("/getTrainingVideoUrl", "POST", { video_s3_key });

export const getTrainingUploadUrl = (fileName, skill) =>
  api("/getTrainingUploadUrl", "POST", { fileName, skill });

export const addTrainingMaterial = (data) =>
  api("/addTrainingMaterial", "POST", data);

/* ================= USERS (ADMIN) ================= */

export const fetchUsers = () => api("/admin/users", "GET");

/* admin OR self profile
   - email present → admin viewing someone
   - email absent → logged-in user */
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
  api("/admin/users", "POST", {
    email,
    action: "changeRole",
    role,
  });

export const updateUserStatus = (email, action) =>
  api("/admin/users", "POST", {
    email,
    action, // "block" | "activate"
  });

/* ================= PROFILE IMAGE ================= */

/*
  Backend must:
  - generate presigned PUT URL
  - return { uploadUrl, imageUrl }
*/
export const getProfileImageUploadUrl = (file, email) =>
  api("/getProfileImageUploadUrl", "POST", {
    fileName: file.name,
    contentType: file.type,
    email,
  });

const domain =
  process.env.REACT_APP_COGNITO_DOMAIN ||
  "https://mydgv-portal-auth.auth.ap-south-1.amazoncognito.com";
const clientId =
  process.env.REACT_APP_COGNITO_CLIENT_ID || "5q797v9k55ad1q36mol3glhecf";
const redirectUri = `${window.location.origin}/callback`;

const apiUrl =
  process.env.REACT_APP_API_URL ||
  "https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod";

function parseEmailFromToken(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded.email || decoded["cognito:username"] || "";
  } catch {
    return "";
  }
}

export function getLoggedInEmail() {
  const token = localStorage.getItem("token");
  return token ? parseEmailFromToken(token) : "";
}

export async function checkAccess() {
  const token = localStorage.getItem("token");
  if (!token) {
    return { access: "NONE" };
  }

  const res = await fetch(`${apiUrl}/access`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Access check failed (${res.status})`);
  }

  return res.json();
}

export function applyAccessRedirect(data) {
  if (data.access === "ADMIN") {
    localStorage.setItem("role", "ADMIN");
    window.location.replace("/admin/users");
    return true;
  }

  if (data.access === "USER") {
    localStorage.setItem("role", "USER");
    window.location.replace("/");
    return true;
  }

  if (data.access === "BLOCKED") {
    localStorage.clear();
    window.location.replace("/blocked");
    return true;
  }

  if (data.access === "PENDING") {
    localStorage.removeItem("role");
    window.location.replace("/request-access?status=pending");
    return true;
  }

  localStorage.removeItem("role");
  return false;
}

// ===============================
// LOGIN
// ===============================
export const login = () => {
  window.location.href =
    `${domain}/login` +
    `?client_id=${clientId}` +
    `&response_type=token` +
    `&scope=email+openid` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
};

// ===============================
// CALLBACK
// ===============================
export const handleCallback = async () => {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);

  const error = params.get("error_description") || params.get("error");
  if (error) {
    console.error("Cognito error:", error);
    localStorage.clear();
    window.location.replace("/login");
    return;
  }

  const idToken = params.get("id_token");

  if (!idToken) {
    localStorage.clear();
    window.location.replace("/login");
    return;
  }

  localStorage.setItem("id_token", idToken);
  localStorage.setItem("token", idToken);

  try {
    const data = await checkAccess();
    if (!applyAccessRedirect(data)) {
      window.location.replace("/request-access");
    }
  } catch (err) {
    console.error("Access check failed", err);
    window.location.replace("/login");
  }
};

// ===============================
// REQUEST ACCESS
// ===============================
export const requestAccess = async () => {
  const token = localStorage.getItem("token");
  if (!token) {
    throw new Error("Not signed in");
  }

  const res = await fetch(`${apiUrl}/request-access`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || data.message || "Request failed");
  }

  if (data.access === "USER" || data.access === "ADMIN") {
    applyAccessRedirect(data);
    return data;
  }

  return data;
};

// ===============================
// LOGOUT
// ===============================
export const logout = () => {
  localStorage.clear();

  window.location.href =
    `${domain}/logout` +
    `?client_id=${clientId}` +
    `&logout_uri=${encodeURIComponent(window.location.origin)}`;
};

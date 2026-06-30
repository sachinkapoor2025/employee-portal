const domain =
  process.env.REACT_APP_COGNITO_DOMAIN ||
  "https://mydgv-portal-auth.auth.ap-south-1.amazoncognito.com";
const clientId =
  process.env.REACT_APP_COGNITO_CLIENT_ID || "5q797v9k55ad1q36mol3glhecf";
const redirectUri = `${window.location.origin}/callback`;

const apiUrl =
  process.env.REACT_APP_API_URL ||
  "https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod";

export const PORTAL_INTENT_KEY = "portalIntent";
export const ACTUAL_ROLE_KEY = "actualRole";

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

export function canAccessAdmin() {
  return localStorage.getItem(ACTUAL_ROLE_KEY) === "ADMIN";
}

export function getViewRole() {
  return localStorage.getItem("role") || "USER";
}

export function switchPortalView(view) {
  if (view === "admin") {
    if (!canAccessAdmin()) return false;
    localStorage.setItem("role", "ADMIN");
    return true;
  }
  localStorage.setItem("role", "USER");
  return true;
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
  const intent = sessionStorage.getItem(PORTAL_INTENT_KEY) || "employee";
  sessionStorage.removeItem(PORTAL_INTENT_KEY);

  if (data.access === "ADMIN") {
    localStorage.setItem(ACTUAL_ROLE_KEY, "ADMIN");

    if (intent === "admin") {
      localStorage.setItem("role", "ADMIN");
      window.location.replace("/admin/users");
      return true;
    }

    localStorage.setItem("role", "USER");
    window.location.replace("/");
    return true;
  }

  if (data.access === "USER") {
    localStorage.setItem(ACTUAL_ROLE_KEY, "USER");

    if (intent === "admin") {
      window.location.replace("/login?adminDenied=1");
      return true;
    }

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

  if (data.access === "DENIED") {
    localStorage.clear();
    window.location.replace("/login?domainDenied=1");
    return true;
  }

  localStorage.removeItem("role");
  return false;
}

// employee | admin
export const login = (intent = "employee") => {
  sessionStorage.setItem(PORTAL_INTENT_KEY, intent);
  window.location.href =
    `${domain}/login` +
    `?client_id=${clientId}` +
    `&response_type=token` +
    `&scope=email+openid` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
};

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

export const logout = () => {
  localStorage.clear();
  sessionStorage.clear();

  window.location.href =
    `${domain}/logout` +
    `?client_id=${clientId}` +
    `&logout_uri=${encodeURIComponent(window.location.origin)}`;
};

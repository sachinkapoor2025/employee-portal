import { getApiBaseUrl, LOCAL_API_REQUIRED_MESSAGE } from "./api";

const domain =
  process.env.REACT_APP_COGNITO_DOMAIN ||
  "https://mydgv-portal-auth.auth.ap-south-1.amazoncognito.com";
const clientId =
  process.env.REACT_APP_COGNITO_CLIENT_ID || "5q797v9k55ad1q36mol3glhecf";
const redirectUri = `${window.location.origin}/callback`;

function requireApiBase() {
  const base = getApiBaseUrl();
  if (!base) {
    throw new Error(LOCAL_API_REQUIRED_MESSAGE);
  }
  return base;
}

export const PORTAL_INTENT_KEY = "portalIntent";
export const ACTUAL_ROLE_KEY = "actualRole";
/** Granular role: SUPER_ADMIN | ADMIN | MANAGER | EMPLOYEE */
export const PORTAL_ROLE_KEY = "portalRole";

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

export function getLoggedInDisplayName() {
  try {
    const token = localStorage.getItem("token");
    if (!token) return "";
    const payload = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
    );
    const combined = `${payload.given_name || ""} ${payload.family_name || ""}`.trim();
    if (combined) return combined;
    const name = String(payload.name || "").trim();
    if (name && !name.includes("@")) return name;
  } catch {
    /* ignore */
  }
  return "";
}

export function canAccessAdmin() {
  const portalRole = localStorage.getItem(PORTAL_ROLE_KEY);
  if (
    portalRole === "SUPER_ADMIN" ||
    portalRole === "ADMIN" ||
    portalRole === "MANAGER"
  ) {
    return true;
  }
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

  const base = requireApiBase();
  const res = await fetch(`${base}/access`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (res.status === 401) {
    localStorage.clear();
    throw new Error("Session expired. Please sign in again.");
  }

  if (!res.ok) {
    throw new Error(`Access check failed (${res.status})`);
  }

  const contentType = res.headers?.get?.("content-type") || "";
  if (contentType.includes("text/html")) {
    throw new Error("Access check did not reach the API.");
  }

  try {
    return await res.json();
  } catch {
    throw new Error("Access check did not reach the API.");
  }
}

export function applyAccessRedirect(data) {
  const intent = sessionStorage.getItem(PORTAL_INTENT_KEY) || "employee";
  sessionStorage.removeItem(PORTAL_INTENT_KEY);

  if (data.access === "ADMIN") {
    localStorage.setItem(ACTUAL_ROLE_KEY, "ADMIN");
    if (data.role) localStorage.setItem(PORTAL_ROLE_KEY, data.role);

    if (intent === "admin") {
      localStorage.setItem("role", "ADMIN");
      import("./activityTracker").then(({ trackLogin }) => trackLogin());
      window.location.replace("/admin/dashboard");
      return true;
    }

    localStorage.setItem("role", "USER");
    import("./activityTracker").then(({ trackLogin }) => trackLogin());
    window.location.replace("/");
    return true;
  }

  if (data.access === "USER") {
    localStorage.setItem(ACTUAL_ROLE_KEY, "USER");
    localStorage.setItem(PORTAL_ROLE_KEY, data.role || "EMPLOYEE");

    if (intent === "admin") {
      window.location.replace("/login?adminDenied=1");
      return true;
    }

    localStorage.setItem("role", "USER");
    import("./activityTracker").then(({ trackLogin }) => trackLogin());
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

  const res = await fetch(`${requireApiBase()}/request-access`, {
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

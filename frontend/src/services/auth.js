// ===============================
// Cognito Hosted UI Configuration
// ===============================
const domain =
  "https://employee-portal-auth.auth.ap-south-1.amazoncognito.com";

const clientId = "2o013hc1m4tqrflvt257tmkmhf";

const redirectUri = `${window.location.origin}/callback`;

// ===============================
// Login
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
// Cognito Callback Handler
// ===============================
export const handleCallback = async () => {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const token = params.get("access_token");

  if (!token) {
    console.error("No access token found in callback");
    window.location.replace("/login");
    return;
  }

  // Store token immediately
  localStorage.setItem("token", token);

  try {
    console.log("Checking access via backend...");

    const res = await fetch(
      `${process.env.REACT_APP_API_URL}/access`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!res.ok) {
      throw new Error(`Access API failed: ${res.status}`);
    }

    const data = await res.json();
    console.log("Access response:", data);

    /**
     * BACKEND IS THE SINGLE SOURCE OF TRUTH
     *
     * Expected responses:
     *  - { access: "ADMIN" }
     *  - { access: "USER" }
     *  - { access: "DENIED" }  -> email NOT in DynamoDB
     *  - { access: "BLOCKED" }
     */

    if (data.access === "ADMIN") {
      localStorage.setItem("role", "ADMIN");
      window.location.replace("/admin/users");
      return;
    }

    if (data.access === "USER") {
      localStorage.setItem("role", "USER");
      window.location.replace("/");
      return;
    }

    if (data.access === "DENIED") {
      // 🚨 ONLY when email DOES NOT EXIST
      window.location.replace("/request-access");
      return;
    }

    if (data.access === "BLOCKED") {
      window.location.replace("/blocked");
      return;
    }

    // Fallback (should never happen)
    console.warn("Unknown access state:", data);
    window.location.replace("/blocked");

  } catch (error) {
    console.error("Access check failed:", error);
    window.location.replace("/blocked");
  }
};

// ===============================
// Logout
// ===============================
export const logout = () => {
  localStorage.clear();

  window.location.href =
    `${domain}/logout` +
    `?client_id=${clientId}` +
    `&logout_uri=${encodeURIComponent(window.location.origin)}`;
};

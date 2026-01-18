const domain = "https://employee-portal-auth.auth.ap-south-1.amazoncognito.com";
const clientId = "2o013hc1m4tqrflvt257tmkmhf";
const redirectUri = `${window.location.origin}/callback`;

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
  const idToken = params.get("id_token");

  if (!idToken) {
    window.location.replace("/login");
    return;
  }

  localStorage.setItem("token", idToken);

  try {
    const res = await fetch(`${process.env.REACT_APP_API_URL}/access`, {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    const data = await res.json();

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

    if (data.access === "BLOCKED") {
      localStorage.clear();
      window.location.replace("/blocked");
      return;
    }

    // DENIED / PENDING
    localStorage.removeItem("role");
    window.location.replace("/request-access");
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

  const res = await fetch(`${process.env.REACT_APP_API_URL}/request-access`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error("Request failed");
  }
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

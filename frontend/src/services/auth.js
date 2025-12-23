const domain = "https://employee-portal-auth.auth.ap-south-1.amazoncognito.com";
const clientId = "2o013hc1m4tqrflvt257tmkmhf";
const redirectUri = window.location.origin + "/callback";

export const login = () => {
  window.location.href =
    `${domain}/login?client_id=${clientId}` +
    `&response_type=token` +
    `&scope=email+openid` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
};

export const handleCallback = async () => {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const token = params.get("access_token");

  if (!token) {
    window.location.replace("/login");
    return;
  }

  localStorage.setItem("token", token);

  try {
    const res = await fetch(
      `${process.env.REACT_APP_API_URL}/access`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!res.ok) {
      throw new Error("Access API failed");
    }

    const data = await res.json();

    // 🔥 SINGLE SOURCE OF TRUTH
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
      window.location.replace("/request-access");
      return;
    }

    window.location.replace("/blocked");

  } catch (err) {
    console.error("Access check failed:", err);
    window.location.replace("/blocked");
  }
};

export const logout = () => {
  localStorage.clear();
  window.location.href =
    `${domain}/logout?client_id=${clientId}` +
    `&logout_uri=${encodeURIComponent(window.location.origin)}`;
};

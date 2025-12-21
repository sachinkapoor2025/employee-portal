const domain = "https://YOUR_COGNITO_DOMAIN.auth.us-east-1.amazoncognito.com";
const clientId = "YOUR_APP_CLIENT_ID";
const redirectUri = window.location.origin + "/callback";

export const login = () => {
  window.location.href =
    `${domain}/login?client_id=${clientId}&response_type=token&scope=email+openid&redirect_uri=${redirectUri}`;
};

export const handleCallback = () => {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const token = params.get("id_token");
  if (token) {
    localStorage.setItem("token", token);
    window.location.href = "/";
  }
};

export const logout = () => {
  localStorage.clear();
  window.location.href =
    `${domain}/logout?client_id=${clientId}&logout_uri=${window.location.origin}`;
};

export const getRole = () => {
  const token = localStorage.getItem("token");
  if (!token) return null;
  const payload = JSON.parse(atob(token.split(".")[1]));
  return payload["cognito:groups"]?.[0] || "Employee";
};

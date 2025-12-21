// Cognito Hosted UI domain (from CloudFormation Outputs)
const domain = "https://employee-portal-auth.auth.ap-south-1.amazoncognito.com";

// Cognito App Client ID (from CloudFormation Outputs)
const clientId = "2o013hc1m4tqrflvt257tmkmhf";

// Redirect back to app after login
const redirectUri = window.location.origin + "/callback";

export const login = () => {
  window.location.href =
    `${domain}/login?client_id=${clientId}` +
    `&response_type=token` +
    `&scope=email+openid` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
};

export const handleCallback = () => {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);

  // Cognito returns id_token for Hosted UI implicit flow
  const token = params.get("id_token");

  if (token) {
    localStorage.setItem("token", token);
    window.location.href = "/";
  }
};

export const logout = () => {
  localStorage.clear();
  window.location.href =
    `${domain}/logout?client_id=${clientId}` +
    `&logout_uri=${encodeURIComponent(window.location.origin)}`;
};

export const getRole = () => {
  const token = localStorage.getItem("token");
  if (!token) return null;

  const payload = JSON.parse(atob(token.split(".")[1]));
  return payload["cognito:groups"]?.[0] || "Employee";
};

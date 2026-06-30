const ALLOWED_DOMAIN = "@mydgv.com";

function parseGroups(claims) {
  const raw = claims["cognito:groups"];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    return raw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return [];
}

exports.isAllowedEmail = (email) => {
  if (!email || typeof email !== "string") return false;
  return email.toLowerCase().endsWith(ALLOWED_DOMAIN);
};

exports.getUser = (event) => {
  const claims = event.requestContext?.authorizer?.claims || {};
  const email = (
    claims.email ||
    claims["cognito:username"] ||
    claims.username ||
    ""
  ).toLowerCase();
  const groups = parseGroups(claims);

  return {
    email,
    groups,
    isAdmin: groups.includes("Admin"),
  };
};

exports.ALLOWED_DOMAIN = ALLOWED_DOMAIN;

exports.getUser = (event) => {
  const claims = event.requestContext.authorizer?.claims || {};
  return {
    email: claims.email,
    role: claims["cognito:groups"]?.[0] || "Employee"
  };
};

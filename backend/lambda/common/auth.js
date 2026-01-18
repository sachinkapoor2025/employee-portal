exports.getUser = (event) => {
  const claims = event.requestContext.authorizer?.claims || {};
  return {
    email: claims.email || claims['cognito:username'] || claims.username,
    role: claims["cognito:groups"]?.[0] || "Employee"
  };
};

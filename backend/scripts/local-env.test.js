"use strict";

const assert = require("assert");
const { decodeJwtClaims, mintLocalJwt, toApiGatewayEvent } = require("./local-env");

{
  const token = mintLocalJwt({
    email: "Admin@MyDGV.com",
    "cognito:groups": ["Admin"],
  });
  const claims = decodeJwtClaims(`Bearer ${token}`);
  assert.strictEqual(claims.email, "Admin@MyDGV.com");
  assert.deepStrictEqual(claims["cognito:groups"], ["Admin"]);
}

{
  const req = { method: "POST", headers: { authorization: `Bearer ${mintLocalJwt({ email: "a@mydgv.com" })}` } };
  const url = new URL("http://127.0.0.1:3001/projects/abc-1?status=ALL");
  const event = toApiGatewayEvent(req, url, JSON.stringify({ name: "X" }));
  assert.strictEqual(event.httpMethod, "POST");
  assert.strictEqual(event.path, "/projects/abc-1");
  assert.strictEqual(event.pathParameters.projectId, "abc-1");
  assert.strictEqual(event.queryStringParameters.status, "ALL");
  assert.strictEqual(event.requestContext.authorizer.claims.email, "a@mydgv.com");
}

{
  assert.deepStrictEqual(decodeJwtClaims(""), {});
  assert.deepStrictEqual(decodeJwtClaims("Bearer not-a-jwt"), {});
}

console.log("local-env tests passed");

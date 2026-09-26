"use strict";

const LOCAL_TABLES = {
  WORK_TABLE: "dgv-local-WorkTasks",
  USER_ACCESS_TABLE: "dgv-local-UserAccess",
  USER_PROFILE_TABLE: "dgv-local-UserProfile",
};

function applyLocalAwsEnv() {
  process.env.AWS_REGION = process.env.AWS_REGION || "ap-south-1";
  process.env.AWS_DEFAULT_REGION = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION;
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "local";
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "local";
  process.env.AWS_EC2_METADATA_DISABLED = "true";
  process.env.AWS_ENDPOINT_URL =
    process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:8000";
  process.env.PROJECT_ACL_RESTRICTED_CREATE =
    process.env.PROJECT_ACL_RESTRICTED_CREATE || "true";
  process.env.WORK_TABLE = process.env.WORK_TABLE || LOCAL_TABLES.WORK_TABLE;
  process.env.USER_ACCESS_TABLE =
    process.env.USER_ACCESS_TABLE || LOCAL_TABLES.USER_ACCESS_TABLE;
  process.env.USER_PROFILE_TABLE =
    process.env.USER_PROFILE_TABLE || LOCAL_TABLES.USER_PROFILE_TABLE;
  process.env.LOCAL_API_PORT = process.env.LOCAL_API_PORT || "3001";
}

function patchDynamoDBClient() {
  const dynamodb = require("@aws-sdk/client-dynamodb");
  if (dynamodb.DynamoDBClient.__dgvLocalPatched) return dynamodb.DynamoDBClient;
  const Original = dynamodb.DynamoDBClient;
  class LocalDynamoDBClient extends Original {
    constructor(config = {}) {
      super({
        ...config,
        region: config.region || process.env.AWS_REGION,
        endpoint: process.env.AWS_ENDPOINT_URL,
        tls: false,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      });
    }
  }
  LocalDynamoDBClient.__dgvLocalPatched = true;
  dynamodb.DynamoDBClient = LocalDynamoDBClient;
  return LocalDynamoDBClient;
}

function decodeJwtClaims(authorization) {
  const token = String(authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) return {};
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function mintLocalJwt(claims = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" })
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.`;
}

function toApiGatewayEvent(req, url, rawBody) {
  const path = url.pathname;
  const query = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const projectMatch = path.match(/^\/projects\/([^/]+)(?:\/.*)?$/);
  const claims = decodeJwtClaims(req.headers.authorization);
  return {
    httpMethod: req.method,
    path,
    resource: path,
    headers: req.headers,
    queryStringParameters: Object.keys(query).length ? query : null,
    pathParameters: projectMatch ? { projectId: decodeURIComponent(projectMatch[1]) } : null,
    body: rawBody || null,
    requestContext: {
      authorizer: {
        claims,
      },
    },
  };
}

module.exports = {
  LOCAL_TABLES,
  applyLocalAwsEnv,
  patchDynamoDBClient,
  decodeJwtClaims,
  mintLocalJwt,
  toApiGatewayEvent,
};

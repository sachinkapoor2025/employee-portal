"use strict";

const http = require("http");
const { URL } = require("url");
const {
  applyLocalAwsEnv,
  patchDynamoDBClient,
  toApiGatewayEvent,
  LOCAL_TABLES,
} = require("./local-env");

applyLocalAwsEnv();
process.env.AWS_ENDPOINT_URL = "";
const useMemory = String(process.env.LOCAL_DDB || "memory").toLowerCase() !== "dynamodb-local";
if (useMemory) {
  require("./memory-ddb").installMemoryDynamoDB();
} else {
  patchDynamoDBClient();
}

const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
} = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const projects = require("../lambda/projects/handler");
const admin = require("../lambda/admin/handler");
const access = require("../lambda/access/handler");

const PORT = Number(process.env.LOCAL_API_PORT || 3001);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
};

function pkTable(name) {
  return {
    TableName: name,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "PK", AttributeType: "S" },
      { AttributeName: "SK", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
  };
}

async function ensureTable(raw, name) {
  try {
    await raw.send(new DescribeTableCommand({ TableName: name }));
  } catch (err) {
    if (String(err?.name || "") !== "ResourceNotFoundException") throw err;
    await raw.send(new CreateTableCommand(pkTable(name)));
  }
}

async function seed(doc) {
  const now = new Date().toISOString();
  const users = [
    {
      email: "admin@mydgv.com",
      role: "ADMIN",
      status: "ACTIVE",
      name: "Local Admin",
    },
    {
      email: "rahul@mydgv.com",
      role: "EMPLOYEE",
      status: "ACTIVE",
      name: "Rahul Test",
    },
    {
      email: "ria@mydgv.com",
      role: "EMPLOYEE",
      status: "ACTIVE",
      name: "Ria Test",
    },
    {
      email: "blocked@mydgv.com",
      role: "EMPLOYEE",
      status: "BLOCKED",
      name: "Blocked Test",
    },
  ];
  const extra = String(process.env.LOCAL_ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
  if (extra && extra.endsWith("@mydgv.com") && !users.some((u) => u.email === extra)) {
    users.push({
      email: extra,
      role: "ADMIN",
      status: "ACTIVE",
      name: "Local Cognito Admin",
    });
  }
  for (const user of users) {
    await doc.send(
      new PutCommand({
        TableName: process.env.USER_ACCESS_TABLE,
        Item: {
          PK: user.email,
          SK: user.email,
          email: user.email,
          role: user.role,
          status: user.status,
          createdAt: now,
        },
      })
    );
    await doc.send(
      new PutCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Item: {
          PK: `USER#${user.email}`,
          SK: "PROFILE",
          email: user.email,
          name: user.name,
        },
      })
    );
  }
}

function route(event) {
  const path = event.path || "";
  if (path === "/access" || path === "/request-access") {
    return access.handler(event);
  }
  if (path === "/admin/users" || path.startsWith("/admin/users/")) {
    return admin.handler(event);
  }
  if (path === "/projects" || path.startsWith("/projects/")) {
    return projects.handler(event);
  }
  return Promise.resolve({
    statusCode: 404,
    headers: CORS,
    body: JSON.stringify({ error: "Not found on local API" }),
  });
}

function send(res, status, headers, body) {
  const next = { ...CORS, ...(headers || {}) };
  res.writeHead(status, next);
  res.end(body == null ? "" : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function boot() {
  const raw = new (require("@aws-sdk/client-dynamodb").DynamoDBClient)({
    region: process.env.AWS_REGION,
  });
  try {
    await raw.send(new ListTablesCommand({}));
  } catch (err) {
    throw new Error(
      `Local DynamoDB is not reachable. Default is in-memory. For DynamoDB Local: node scripts/local-ddb.js (${err.message})`
    );
  }
  await ensureTable(raw, LOCAL_TABLES.WORK_TABLE);
  await ensureTable(raw, LOCAL_TABLES.USER_ACCESS_TABLE);
  await ensureTable(raw, LOCAL_TABLES.USER_PROFILE_TABLE);
  const doc = DynamoDBDocumentClient.from(raw);
  await seed(doc);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        send(res, 204, CORS, "");
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const rawBody = await readBody(req);
      const event = toApiGatewayEvent(req, url, rawBody);
      const result = await route(event);
      const headers = result.headers || {};
      send(
        res,
        result.statusCode || 200,
        headers,
        typeof result.body === "string"
          ? result.body
          : JSON.stringify(result.body || {})
      );
    } catch (err) {
      console.error("Local API error:", err);
      send(res, 500, CORS, JSON.stringify({ error: "Internal server error" }));
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Local DGV API http://127.0.0.1:${PORT}`);
    console.log(`PROJECT_ACL_RESTRICTED_CREATE=${process.env.PROJECT_ACL_RESTRICTED_CREATE}`);
    console.log(`WORK_TABLE=${process.env.WORK_TABLE}`);
    console.log(`LOCAL_DDB=${useMemory ? "memory" : process.env.AWS_ENDPOINT_URL}`);
    console.log("Not connected to production DynamoDB or production API Gateway.");
  });
}

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});

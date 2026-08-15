const { getUser, isAllowedEmail } = require("../common/auth");
const {
  normalizeRole,
  accessGateForRole,
  isAdminPortalRole,
} = require("../common/roles");
const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({
  region: process.env.AWS_REGION,
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json",
};

function resolveAccess(user, record) {
  if (!isAllowedEmail(user.email)) {
    return { access: "DENIED", role: null };
  }

  if (!record) {
    const role = user.isAdmin ? "ADMIN" : "EMPLOYEE";
    return { access: accessGateForRole(role), role };
  }

  const status = record.status?.S;
  if (status === "PENDING") {
    return { access: "PENDING", role: normalizeRole(record.role?.S) };
  }
  if (status !== "ACTIVE") {
    return { access: "BLOCKED", role: normalizeRole(record.role?.S) };
  }

  let role = normalizeRole(record.role?.S || (user.isAdmin ? "ADMIN" : "EMPLOYEE"));
  if (user.isAdmin && !isAdminPortalRole(role)) {
    role = "ADMIN";
  }
  if (!user.isAdmin && isAdminPortalRole(role)) {
    role = "EMPLOYEE";
  }

  return { access: accessGateForRole(role), role };
}

exports.handler = async (event) => {
  const user = getUser(event);
  const email = user.email;

  if (!email) {
    return serverError();
  }

  if (!isAllowedEmail(email)) {
    return ok({
      access: "DENIED",
      message: "Only @mydgv.com accounts are allowed",
    });
  }

  const tableName = process.env.USER_ACCESS_TABLE;

  if (event.httpMethod === "GET") {
    try {
      const result = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { PK: { S: email }, SK: { S: email } },
        })
      );

      if (!result.Item) {
        const resolved = resolveAccess(user, null);
        if (resolved.access === "DENIED") return ok({ access: "DENIED" });

        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              PK: { S: email },
              SK: { S: email },
              email: { S: email },
              role: { S: resolved.role },
              status: { S: "ACTIVE" },
              createdAt: { S: new Date().toISOString() },
            },
            ConditionExpression: "attribute_not_exists(PK)",
          })
        );

        return ok(resolved);
      }

      return ok(resolveAccess(user, result.Item));
    } catch (error) {
      console.error("Access check failed:", error);
      return serverError();
    }
  }

  if (event.httpMethod === "POST") {
    try {
      const existing = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { PK: { S: email }, SK: { S: email } },
        })
      );

      if (existing.Item) {
        const resolved = resolveAccess(user, existing.Item);

        if (resolved.access === "USER" || resolved.access === "ADMIN") {
          return ok({
            message: "You already have access. Redirecting to portal.",
            ...resolved,
          });
        }

        if (resolved.access === "PENDING") {
          return ok({
            message: "Your access request is already pending approval.",
            access: "PENDING",
            role: resolved.role,
          });
        }

        await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: { PK: { S: email }, SK: { S: email } },
            UpdateExpression:
              "SET #status = :status, #role = :role, updatedAt = :updatedAt",
            ExpressionAttributeNames: { "#status": "status", "#role": "role" },
            ExpressionAttributeValues: {
              ":status": { S: "PENDING" },
              ":role": { S: "EMPLOYEE" },
              ":updatedAt": { S: new Date().toISOString() },
            },
          })
        );

        return ok({
          message: "Access request submitted",
          access: "PENDING",
          role: "EMPLOYEE",
        });
      }

      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            PK: { S: email },
            SK: { S: email },
            email: { S: email },
            role: { S: "EMPLOYEE" },
            status: { S: "PENDING" },
            createdAt: { S: new Date().toISOString() },
          },
        })
      );

      return ok({
        message: "Access request submitted",
        access: "PENDING",
        role: "EMPLOYEE",
      });
    } catch (error) {
      console.error("Request access failed:", error);
      return serverError();
    }
  }

  return {
    statusCode: 405,
    headers: corsHeaders,
    body: JSON.stringify({ error: "Method not allowed" }),
  };
};

function ok(body) {
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify(body),
  };
}

function serverError() {
  return {
    statusCode: 500,
    headers: corsHeaders,
    body: JSON.stringify({ error: "Internal server error" }),
  };
}

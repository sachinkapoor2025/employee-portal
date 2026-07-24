const { getUser, isAllowedEmail } = require("../common/auth");
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
    return "DENIED";
  }

  if (!record) {
    return user.isAdmin ? "ADMIN" : "USER";
  }

  const status = record.status?.S;
  if (status === "PENDING") return "PENDING";
  if (status !== "ACTIVE") return "BLOCKED";

  return user.isAdmin ? "ADMIN" : "USER";
}

exports.handler = async (event) => {
  console.log("Incoming event:", JSON.stringify(event));

  const user = getUser(event);
  const email = user.email;

  if (!email) {
    console.error("Email missing from token");
    return serverError();
  }

  if (!isAllowedEmail(email)) {
    console.warn("Blocked non-company email:", email);
    return ok({ access: "DENIED", message: "Only @mydgv.com accounts are allowed" });
  }

  console.log("Authenticated email:", email, "groups:", user.groups);

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
        const access = resolveAccess(user, null);
        if (access === "DENIED") return ok({ access: "DENIED" });

        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              PK: { S: email },
              SK: { S: email },
              email: { S: email },
              role: { S: user.isAdmin ? "ADMIN" : "USER" },
              status: { S: "ACTIVE" },
              createdAt: { S: new Date().toISOString() },
            },
            ConditionExpression: "attribute_not_exists(PK)",
          })
        );

        return ok({ access });
      }

      const access = resolveAccess(user, result.Item);
      return ok({ access });
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
        const access = resolveAccess(user, existing.Item);

        if (access === "USER" || access === "ADMIN") {
          return ok({
            message: "You already have access. Redirecting to portal.",
            access,
          });
        }

        if (access === "PENDING") {
          return ok({
            message: "Your access request is already pending approval.",
            access: "PENDING",
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
              ":role": { S: "USER" },
              ":updatedAt": { S: new Date().toISOString() },
            },
          })
        );

        return ok({ message: "Access request submitted", access: "PENDING" });
      }

      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            PK: { S: email },
            SK: { S: email },
            email: { S: email },
            role: { S: "USER" },
            status: { S: "PENDING" },
            createdAt: { S: new Date().toISOString() },
          },
        })
      );

      return ok({ message: "Access request submitted", access: "PENDING" });
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

const ok = (body) => ({
  statusCode: 200,
  headers: corsHeaders,
  body: JSON.stringify(body),
});

const serverError = () => ({
  statusCode: 500,
  headers: corsHeaders,
  body: JSON.stringify({ error: "Internal server error" }),
});

const { getUser } = require("../common/auth");
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

exports.handler = async (event) => {
  console.log("Incoming event:", JSON.stringify(event));

  const user = getUser(event);
  const email = user.email;

  if (!email) {
    console.error("Email missing from token");
    return serverError();
  }

  console.log("Authenticated email:", email);

  const tableName = process.env.USER_ACCESS_TABLE;

  if (event.httpMethod === "GET") {
    try {
      const result = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            PK: { S: email },
            SK: { S: email },
          },
        })
      );

      console.log("DynamoDB GET result:", result);

      if (!result.Item) {
        console.log("No access record found, auto-creating for new user");

        try {
          await client.send(
            new PutItemCommand({
              TableName: tableName,
              Item: {
                PK: { S: email },
                SK: { S: email },
                email: { S: email },
                role: { S: "USER" },
                status: { S: "ACTIVE" },
                createdAt: { S: new Date().toISOString() },
              },
              ConditionExpression: "attribute_not_exists(PK)",
            })
          );

          console.log("Auto-created access record for:", email);
          return ok({ access: "USER" });
        } catch (error) {
          console.error("Failed to auto-create access record:", error);
          return serverError();
        }
      }

      const status = result.Item.status?.S;
      const role = result.Item.role?.S;

      console.log("Resolved access:", { email, role, status });

      if (status === "PENDING") {
        return ok({ access: "PENDING" });
      }

      if (status !== "ACTIVE") {
        return ok({ access: "BLOCKED" });
      }

      if (role === "ADMIN" || role === "USER") {
        return ok({ access: role });
      }

      console.warn("Invalid role detected:", role);
      return ok({ access: "DENIED" });
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
          Key: {
            PK: { S: email },
            SK: { S: email },
          },
        })
      );

      if (existing.Item) {
        const status = existing.Item.status?.S;
        const role = existing.Item.role?.S;

        if (status === "ACTIVE" && (role === "USER" || role === "ADMIN")) {
          return ok({
            message: "You already have access. Redirecting to portal.",
            access: role,
          });
        }

        if (status === "PENDING") {
          return ok({
            message: "Your access request is already pending approval.",
            access: "PENDING",
          });
        }

        await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: {
              PK: { S: email },
              SK: { S: email },
            },
            UpdateExpression:
              "SET #status = :status, #role = :role, updatedAt = :updatedAt",
            ExpressionAttributeNames: {
              "#status": "status",
              "#role": "role",
            },
            ExpressionAttributeValues: {
              ":status": { S: "PENDING" },
              ":role": { S: "USER" },
              ":updatedAt": { S: new Date().toISOString() },
            },
          })
        );

        return ok({
          message: "Access request submitted",
          access: "PENDING",
        });
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

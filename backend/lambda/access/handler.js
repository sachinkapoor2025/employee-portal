const { getUser } = require("../common/auth");
const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({
  region: process.env.AWS_REGION,
});

/**
 * =================================================
 * Lambda Handler
 * =================================================
 */
exports.handler = async (event) => {
  console.log("Incoming event:", JSON.stringify(event));

  // 🔐 IDENTITY ONLY — NO ROLE FROM TOKEN
  const user = getUser(event);
  const email = user.email;

  if (!email) {
    console.error("Email missing from token");
    return serverError();
  }

  console.log("Authenticated email:", email);

  const tableName = process.env.USER_ACCESS_TABLE;

  /**
   * =================================================
   * GET /access
   * =================================================
   */
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

      // ❌ No record → Request Access page
      if (!result.Item) {
        return ok({ access: "DENIED" });
      }

      const status = result.Item.status?.S;
      const role = result.Item.role?.S;

      console.log("Resolved access:", { email, role, status });

      // 🚫 User exists but not active
      if (status !== "ACTIVE") {
        return ok({ access: "BLOCKED" });
      }

      // ✅ EXPLICIT ALLOW ONLY
      if (role === "ADMIN" || role === "USER") {
        return ok({ access: role });
      }

      // ❌ Any unexpected role value
      console.warn("Invalid role detected:", role);
      return ok({ access: "DENIED" });
    } catch (error) {
      console.error("Access check failed:", error);
      return serverError();
    }
  }

  /**
   * =================================================
   * POST /request-access
   * =================================================
   */
  if (event.httpMethod === "POST") {
    try {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            PK: { S: email },
            SK: { S: email },
            email: { S: email },
            role: { S: "USER" }, // default
            status: { S: "PENDING" }, // pending approval
            createdAt: { S: new Date().toISOString() },
          },
          ConditionExpression: "attribute_not_exists(PK)",
        })
      );

      return ok({ message: "Access request submitted" });
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") {
        return ok({ message: "Access request already exists" });
      }

      console.error("Request access failed:", error);
      return serverError();
    }
  }

  return {
    statusCode: 405,
    body: JSON.stringify({ error: "Method not allowed" }),
  };
};

/**
 * =================================================
 * Helpers
 * =================================================
 */
const ok = (body) => ({
  statusCode: 200,
  body: JSON.stringify(body),
});

const serverError = () => ({
  statusCode: 500,
  body: JSON.stringify({ error: "Internal server error" }),
});

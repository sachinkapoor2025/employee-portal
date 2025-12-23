const { getUser } = require("../common/auth");
const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand
} = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({
  region: process.env.AWS_REGION
});

exports.handler = async (event) => {
  console.log("Incoming event:", JSON.stringify(event));

  const user = getUser(event);
  console.log("Authenticated user:", user);

  const tableName = process.env.USER_ACCESS_TABLE;

  /**
   * =================================================
   * GET /access
   * Called immediately after Cognito login
   * =================================================
   */
  if (event.httpMethod === "GET") {
    const params = {
      TableName: tableName,
      Key: {
        PK: { S: user.email },
        SK: { S: user.email }
      }
    };

    try {
      const result = await client.send(new GetItemCommand(params));
      console.log("DynamoDB GET result:", result);

      // ❌ No record → request access page
      if (!result.Item) {
        return {
          statusCode: 200,
          body: JSON.stringify({ access: "DENIED" })
        };
      }

      const status = result.Item.status.S;
      const role = result.Item.role.S;

      // ✅ Approved user
      if (status === "ACTIVE") {
        return {
          statusCode: 200,
          body: JSON.stringify({ access: role }) // USER or ADMIN
        };
      }

      // 🚫 Blocked or Pending
      return {
        statusCode: 200,
        body: JSON.stringify({ access: "DENIED" })
      };

    } catch (error) {
      console.error("Error checking access:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ access: "DENIED" })
      };
    }
  }

  /**
   * =================================================
   * POST /request-access
   * Create access request ONLY if not exists
   * =================================================
   */
  if (event.httpMethod === "POST") {
    const params = {
      TableName: tableName,
      Item: {
        PK: { S: user.email },
        SK: { S: user.email },
        email: { S: user.email },
        role: { S: "USER" },        // default role
        status: { S: "PENDING" },   // pending approval
        createdAt: { S: new Date().toISOString() }
      },
      // ⛔ Prevent overwriting existing requests
      ConditionExpression: "attribute_not_exists(PK)"
    };

    try {
      await client.send(new PutItemCommand(params));
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Access request submitted"
        })
      };

    } catch (error) {
      // ✅ User already requested access
      if (error.name === "ConditionalCheckFailedException") {
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Access request already exists"
          })
        };
      }

      console.error("Error requesting access:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Internal server error" })
      };
    }
  }

  /**
   * =================================================
   * Unsupported method
   * =================================================
   */
  return {
    statusCode: 405,
    body: JSON.stringify({ error: "Method not allowed" })
  };
};

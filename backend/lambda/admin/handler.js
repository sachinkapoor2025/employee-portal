const { getUser } = require("../common/auth");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json",
};

async function scanAllUsers(tableName) {
  const items = [];
  let lastKey;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  const adminUser = getUser(event);
  const tableName = process.env.USER_ACCESS_TABLE;

  if (!adminUser.isAdmin) {
    return {
      statusCode: 403,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Admin access required" }),
    };
  }

  if (event.httpMethod === "GET") {
    try {
      const items = await scanAllUsers(tableName);
      const users = items
        .map((item) => ({
          email: item.email || item.PK,
          role: item.role || "USER",
          status: item.status || "UNKNOWN",
          createdAt: item.createdAt || "",
        }))
        .filter((u) => u.email && u.email.includes("@"))
        .sort((a, b) => a.email.localeCompare(b.email));

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(users),
      };
    } catch (error) {
      console.error("Error fetching users:", error);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Internal server error" }),
      };
    }
  }

  if (event.httpMethod === "POST") {
    const { email, action, role } = JSON.parse(event.body || "{}");

    const updates = {};
    if (action === "approve" || action === "activate") updates.status = "ACTIVE";
    else if (action === "reject" || action === "block") updates.status = "BLOCKED";
    else if (action === "changeRole" && role) updates.role = role;

    if (!email || Object.keys(updates).length === 0) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Invalid request" }),
      };
    }

    const setParts = [];
    const names = {};
    const values = {};
    Object.entries(updates).forEach(([key, value], i) => {
      setParts.push(`#f${i} = :v${i}`);
      names[`#f${i}`] = key;
      values[`:v${i}`] = value;
    });

    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: email, SK: email },
          UpdateExpression: `SET ${setParts.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        })
      );

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ message: "User updated" }),
      };
    } catch (error) {
      console.error("Error updating user:", error);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Internal server error" }),
      };
    }
  }

  return {
    statusCode: 405,
    headers: corsHeaders,
    body: JSON.stringify({ error: "Method not allowed" }),
  };
};

const { getUser } = require("../common/auth");
const { DynamoDBClient, ScanCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  const adminUser = getUser(event);
  const tableName = process.env.USER_ACCESS_TABLE;

  if (event.httpMethod === 'GET') {
    // Get all users
    const params = {
      TableName: tableName
    };

    try {
      const result = await client.send(new ScanCommand(params));
      const users = result.Items.map(item => ({
        email: item.email.S,
        role: item.role.S,
        status: item.status.S,
        createdAt: item.createdAt.S
      }));

      return {
        statusCode: 200,
        body: JSON.stringify(users)
      };
    } catch (error) {
      console.error("Error fetching users:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Internal server error" })
      };
    }
  } else if (event.httpMethod === 'POST') {
    const { email, action, role, status } = JSON.parse(event.body);

    const updateExpression = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};

    if (action === 'approve') {
      updateExpression.push("#status = :status");
      expressionAttributeNames["#status"] = "status";
      expressionAttributeValues[":status"] = { S: "ACTIVE" };
    } else if (action === 'reject') {
      updateExpression.push("#status = :status");
      expressionAttributeNames["#status"] = "status";
      expressionAttributeValues[":status"] = { S: "BLOCKED" };
    } else if (action === 'changeRole') {
      updateExpression.push("#role = :role");
      expressionAttributeNames["#role"] = "role";
      expressionAttributeValues[":role"] = { S: role };
    } else if (action === 'block') {
      updateExpression.push("#status = :status");
      expressionAttributeNames["#status"] = "status";
      expressionAttributeValues[":status"] = { S: "BLOCKED" };
    } else if (action === 'activate') {
      updateExpression.push("#status = :status");
      expressionAttributeNames["#status"] = "status";
      expressionAttributeValues[":status"] = { S: "ACTIVE" };
    }

    const params = {
      TableName: tableName,
      Key: {
        PK: { S: email },
        SK: { S: email }
      },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ExpressionAttributeNames: expressionAttributeNames
    };

    try {
      await client.send(new UpdateItemCommand(params));
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "User updated" })
      };
    } catch (error) {
      console.error("Error updating user:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Internal server error" })
      };
    }
  }

  return {
    statusCode: 405,
    body: JSON.stringify({ error: "Method not allowed" })
  };
};

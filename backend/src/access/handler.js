const { getUser } = require("../common/auth");
const { DynamoDBClient, GetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  const user = getUser(event);
  const tableName = process.env.USER_ACCESS_TABLE;

  if (event.httpMethod === 'GET') {
    // Check user access
    const params = {
      TableName: tableName,
      Key: {
        PK: { S: user.email },
        SK: { S: user.email } // assuming SK is also email for simplicity
      }
    };

    try {
      const result = await client.send(new GetItemCommand(params));
      if (result.Item) {
        const status = result.Item.status.S;
        const role = result.Item.role.S;
        return {
          statusCode: 200,
          body: JSON.stringify({ exists: true, status, role })
        };
      } else {
        return {
          statusCode: 200,
          body: JSON.stringify({ exists: false })
        };
      }
    } catch (error) {
      console.error("Error checking access:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Internal server error" })
      };
    }
  } else if (event.httpMethod === 'POST') {
    // Request access
    const params = {
      TableName: tableName,
      Item: {
        PK: { S: user.email },
        SK: { S: user.email },
        email: { S: user.email },
        role: { S: "USER" }, // default
        status: { S: "PENDING" },
        createdAt: { S: new Date().toISOString() }
      }
    };

    try {
      await client.send(new PutItemCommand(params));
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Access request submitted" })
      };
    } catch (error) {
      console.error("Error requesting access:", error);
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

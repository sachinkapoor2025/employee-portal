import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    const claims =
      event.requestContext?.authorizer?.claims ||
      event.requestContext?.authorizer?.jwt?.claims;

    const email = claims?.email || "unknown";

    const params = {
      TableName: process.env.RESIGNATIONS_TABLE,
      Item: {
        PK: { S: `USER#${email}` },
        SK: { S: `RESIGNATION#${Date.now()}` },
        email: { S: email },
        lastWorkingDay: { S: body.lastWorkingDay },
        reason: { S: body.reason },
        status: { S: "SUBMITTED" },
        createdAt: { S: new Date().toISOString() },
      },
    };

    await client.send(new PutItemCommand(params));

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
      },
      body: JSON.stringify({ message: "Resignation submitted successfully" }),
    };
  } catch (err) {
    console.error("Lambda error:", err);

    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

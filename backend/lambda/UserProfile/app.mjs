import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

export const handler = async (event) => {
  console.log("EVENT:", JSON.stringify(event));

  try {
    // admin case → ?email=
    let email = event.queryStringParameters?.email;

    // user self profile → from cognito
    if (!email) {
      email = event.requestContext?.authorizer?.claims?.email;
    }

    if (!email) {
      return response(400, { message: "Email is required" });
    }

    const result = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: {
          PK: `USER#${email}`,
          SK: "PROFILE",
        },
      })
    );

    return response(200, result.Item || {});
  } catch (err) {
    console.error("GetUserProfile error:", err);
    return response(500, { message: "Failed to fetch profile" });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
  },
  body: JSON.stringify(body),
});

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({ region: "ap-south-1" });
const ddb = DynamoDBDocumentClient.from(client);

export const handler = async (event) => {
  try {
    console.log("EVENT:", JSON.stringify(event));

    // 1️⃣ Get user email from Cognito
    const email = event?.requestContext?.authorizer?.claims?.email;

    if (!email) {
      return response(401, { message: "Unauthorized" });
    }

    // 2️⃣ Fetch user profile to get skill
    const userRes = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: {
          PK: `USER#${email}`,
          SK: "PROFILE",
        },
      })
    );

    if (!userRes.Item || !userRes.Item.skill) {
      console.error("User skill not found");
      return response(404, { message: "User skill not found" });
    }

    const userSkill = userRes.Item.skill;
    console.log("User skill:", userSkill);

    // 3️⃣ Scan training materials by skill
    const trainingRes = await ddb.send(
      new ScanCommand({
        TableName: process.env.TRAINING_TABLE,
        FilterExpression: "#skill = :s AND is_active = :a",
        ExpressionAttributeNames: {
          "#skill": "skill",
        },
        ExpressionAttributeValues: {
          ":s": userSkill,
          ":a": true,
        },
      })
    );

    return response(200, trainingRes.Items || []);
  } catch (err) {
    console.error("Lambda error:", err);
    return response(500, { message: "Failed to fetch trainings" });
  }
};

// ✅ CORS + response helper
const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  },
  body: JSON.stringify(body),
});

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const client = new DynamoDBClient({ region: "ap-south-1" });
const ddb = DynamoDBDocumentClient.from(client);

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);

    const { title, skill, level, duration_hours, video_s3_key } = body;

    if (!title || !skill || !level || !duration_hours || !video_s3_key) {
      return response(400, { message: "All fields are required" });
    }

    const training_id = randomUUID();

    const item = {
      PK: `SKILL#${skill}`,
      SK: `TRAINING#${training_id}`,
      training_id,
      title,
      skill,
      level,
      duration_hours,
      video_s3_key,
      is_active: true,
      created_at: new Date().toISOString(),
    };

    await ddb.send(
      new PutCommand({
        TableName: process.env.TRAINING_TABLE,
        Item: item,
      })
    );

    return response(201, { message: "Training added", training_id });
  } catch (err) {
    console.error("AddTraining error:", err);
    return response(500, { message: "Failed to add training material" });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  },
  body: JSON.stringify(body),
});

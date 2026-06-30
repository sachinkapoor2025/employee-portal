import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({ region: process.env.AWS_REGION || "ap-south-1" });
const ddb = DynamoDBDocumentClient.from(client);

async function queryTrainingsBySkill(skillCode) {
  const items = [];
  let lastKey;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: process.env.TRAINING_TABLE,
        KeyConditionExpression: "PK = :pk",
        FilterExpression: "is_active = :active",
        ExpressionAttributeValues: {
          ":pk": `SKILL#${skillCode}`,
          ":active": true,
        },
        ExclusiveStartKey: lastKey,
      })
    );

    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

function dedupeTrainings(items) {
  const seen = new Set();
  return items.filter((item) => {
    const id = item.training_id || item.SK;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(200, "");
  }

  try {
    const email = event?.requestContext?.authorizer?.claims?.email;

    if (!email) {
      return response(401, { message: "Unauthorized" });
    }

    let userSkill = null;

    const userRes = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: {
          PK: `USER#${email}`,
          SK: "PROFILE",
        },
      })
    );

    if (userRes.Item?.skill) {
      userSkill = String(userRes.Item.skill).trim().toUpperCase();
    }

    const trainings = [];

    // Company-wide trainings (visible to every employee)
    trainings.push(...(await queryTrainingsBySkill("ALL")));

    if (userSkill) {
      const variants = new Set([
        userSkill,
        String(userRes.Item.skill).trim(),
      ]);
      for (const variant of variants) {
        trainings.push(...(await queryTrainingsBySkill(String(variant).toUpperCase())));
      }
    }

    const unique = dedupeTrainings(trainings).sort(
      (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );

    console.log(
      `Trainings for ${email} (skill=${userSkill || "none"}): ${unique.length}`
    );

    return response(200, unique);
  } catch (err) {
    console.error("Lambda error:", err);
    return response(500, { message: "Failed to fetch trainings" });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Content-Type": "application/json",
  },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

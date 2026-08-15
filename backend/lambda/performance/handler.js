const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

const CHARGED_HOURS = 40;
const COMPLETED_HOURS = 32;
const DEFAULT_RATING = "Good Performer";

async function trainingPointsFor(email) {
  const tableName = process.env.TRAINING_PROGRESS_TABLE;
  if (!tableName || !email) return 0;
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": email },
      })
    );
    let totalPoints = 0;
    for (const item of result.Items || []) {
      const status = String(item.status || "").toLowerCase();
      if (status === "completed") {
        totalPoints += parseInt(item.points, 10) || 0;
      }
    }
    return totalPoints;
  } catch (error) {
    console.error("Error fetching training points:", error?.name);
    return 0;
  }
}

function metrics(trainingPoints) {
  return {
    chargedHours: CHARGED_HOURS,
    completedHours: COMPLETED_HOURS,
    rating: DEFAULT_RATING,
    trainingPoints,
  };
}

async function listActiveEmployees() {
  if (!process.env.USER_ACCESS_TABLE) return [];
  const items = [];
  let lastKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: process.env.USER_ACCESS_TABLE,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items.filter((row) => String(row.status || "").toUpperCase() === "ACTIVE");
}

async function profileName(email) {
  if (!process.env.USER_PROFILE_TABLE) return email.split("@")[0];
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: { PK: `USER#${email}`, SK: "PROFILE" },
      })
    );
    return res.Item?.name || email.split("@")[0];
  } catch {
    return email.split("@")[0];
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  if (!user.email) return json(401, { error: "Unauthorized" });

  const qs = event.queryStringParameters || {};
  const all = String(qs.all || "") === "true";
  const emailParam = String(qs.email || "")
    .trim()
    .toLowerCase();

  try {
    if (user.isAdmin && (all || emailParam)) {
      if (emailParam) {
        const trainingPoints = await trainingPointsFor(emailParam);
        return json(200, {
          email: emailParam,
          name: await profileName(emailParam),
          ...metrics(trainingPoints),
        });
      }
      const access = await listActiveEmployees();
      const employees = [];
      for (const row of access) {
        const email = String(row.email || row.PK || "")
          .trim()
          .toLowerCase();
        if (!email) continue;
        const trainingPoints = await trainingPointsFor(email);
        employees.push({
          email,
          name: await profileName(email),
          ...metrics(trainingPoints),
        });
      }
      return json(200, { employees });
    }

    const trainingPoints = await trainingPointsFor(user.email);
    return json(200, metrics(trainingPoints));
  } catch (err) {
    console.error("Performance error:", err?.name);
    return json(500, { error: "Failed to load performance" });
  }
};

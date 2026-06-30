const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  if (!user.email) return json(401, { error: "Unauthorized" });

  try {
    const res = await ddb.send(
      new QueryCommand({
        TableName: process.env.WORK_TABLE,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
      })
    );

    const tasks = (res.Items || []).filter((t) => t.assignee === user.email);
    return json(200, tasks);
  } catch (err) {
    console.error("Work error:", err);
    return json(500, { error: "Internal server error" });
  }
};

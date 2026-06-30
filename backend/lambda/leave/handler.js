const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    if (event.httpMethod === "GET") {
      if (user.isAdmin && event.queryStringParameters?.all === "true") {
        const res = await ddb.send(
          new QueryCommand({
            TableName: process.env.WORK_TABLE,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": "ENTITY#LEAVE" },
          })
        );
        return json(200, res.Items || []);
      }

      const res = await ddb.send(
        new QueryCommand({
          TableName: process.env.WORK_TABLE,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: {
            ":pk": `USER#${user.email}`,
            ":sk": "LEAVE#",
          },
        })
      );
      return json(200, res.Items || []);
    }

    if (event.httpMethod === "POST") {
      if (!user.email) return json(401, { error: "Unauthorized" });
      const { fromDate, toDate, type, reason } = body;
      if (!fromDate || !toDate) return json(400, { error: "Dates required" });

      const id = randomUUID();
      const item = {
        PK: "ENTITY#LEAVE",
        SK: `LEAVE#${id}`,
        leaveId: id,
        email: user.email,
        fromDate,
        toDate,
        type: type || "CASUAL",
        reason: reason || "",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      };

      await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: item }));
      await ddb.send(
        new PutCommand({
          TableName: process.env.WORK_TABLE,
          Item: { ...item, PK: `USER#${user.email}`, SK: `LEAVE#${id}` },
        })
      );

      return json(201, item);
    }

    if (event.httpMethod === "PUT") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const { leaveId, status } = body;
      if (!leaveId || !status) return json(400, { error: "leaveId and status required" });

      const keys = await ddb.send(
        new QueryCommand({
          TableName: process.env.WORK_TABLE,
          KeyConditionExpression: "PK = :pk AND SK = :sk",
          ExpressionAttributeValues: {
            ":pk": "ENTITY#LEAVE",
            ":sk": `LEAVE#${leaveId}`,
          },
        })
      );

      const item = keys.Items?.[0];
      if (!item) return json(404, { error: "Not found" });

      const updated = {
        ...item,
        status,
        reviewedBy: user.email,
        reviewedAt: new Date().toISOString(),
      };

      await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: updated }));
      await ddb.send(
        new PutCommand({
          TableName: process.env.WORK_TABLE,
          Item: { ...updated, PK: `USER#${item.email}`, SK: `LEAVE#${leaveId}` },
        })
      );

      return json(200, updated);
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Leave error:", err);
    return json(500, { error: "Internal server error" });
  }
};

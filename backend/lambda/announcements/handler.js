const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  const body = event.body ? JSON.parse(event.body) : {};
  const isAdminPath = (event.path || "").includes("/admin/");

  try {
    if (event.httpMethod === "GET") {
      const res = await ddb.send(
        new QueryCommand({
          TableName: process.env.WORK_TABLE,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "ENTITY#ANNOUNCE" },
          ScanIndexForward: false,
        })
      );
      const items = (res.Items || []).filter((a) => a.active !== false);
      return json(200, items);
    }

    if (event.httpMethod === "POST" && isAdminPath) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const id = randomUUID();
      const item = {
        PK: "ENTITY#ANNOUNCE",
        SK: `ANN#${id}`,
        announceId: id,
        title: body.title,
        message: body.message,
        active: true,
        createdAt: new Date().toISOString(),
        createdBy: user.email,
      };
      await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: item }));
      return json(201, item);
    }

    if (event.httpMethod === "DELETE" && isAdminPath) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      await ddb.send(
        new DeleteCommand({
          TableName: process.env.WORK_TABLE,
          Key: { PK: "ENTITY#ANNOUNCE", SK: `ANN#${body.announceId}` },
        })
      );
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Announcements error:", err);
    return json(500, { error: "Internal server error" });
  }
};

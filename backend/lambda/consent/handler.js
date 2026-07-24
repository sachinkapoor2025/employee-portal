const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);

  try {
    if (event.httpMethod === "GET") {
      if (!user.email) return json(401, { error: "Unauthorized" });
      const res = await ddb.send(
        new GetCommand({
          TableName: process.env.WORK_TABLE,
          Key: { PK: "ENTITY#CONSENT", SK: user.email },
        })
      );
      return json(200, { accepted: !!res.Item, record: res.Item || null });
    }

    if (event.httpMethod === "POST") {
      if (!user.email) return json(401, { error: "Unauthorized" });
      const item = {
        PK: "ENTITY#CONSENT",
        SK: user.email,
        email: user.email,
        acceptedAt: new Date().toISOString(),
        version: "1.0",
      };
      await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: item }));
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Consent error:", err);
    return json(500, { error: "Internal server error" });
  }
};

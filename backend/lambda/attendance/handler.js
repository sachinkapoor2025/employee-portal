const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  try {
    const user = getUser(event);
    const tableName = process.env.ATTENDANCE_TABLE;

    if (!user.email) {
      return json(401, { error: "Unauthorized" });
    }

    if (event.httpMethod === "POST") {
      const attendanceData = JSON.parse(event.body || "[]");

      if (!Array.isArray(attendanceData) || attendanceData.length === 0) {
        return json(400, { error: "Attendance array is required" });
      }

      for (const item of attendanceData) {
        const record = {
          PK: { S: user.email },
          SK: { S: item.date },
          status: { S: item.status },
        };

        if (item.hours !== undefined && item.hours !== null) {
          record.hours = { N: String(item.hours) };
        }

        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: record,
          })
        );
      }

      return json(200, { message: "Attendance saved" });
    }

    if (event.httpMethod === "GET") {
      const { startDate, endDate } = event.queryStringParameters || {};
      if (!startDate || !endDate) {
        return json(400, { error: "startDate and endDate required" });
      }

      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
          ExpressionAttributeValues: {
            ":pk": { S: user.email },
            ":start": { S: startDate },
            ":end": { S: endDate },
          },
        })
      );

      const attendance = (result.Items || []).map((item) => ({
        date: item.SK.S,
        status: item.status.S,
        hours: item.hours ? parseFloat(item.hours.N) : null,
      }));

      return json(200, attendance);
    }

    return json(405, { error: "Method not allowed" });
  } catch (error) {
    console.error("Attendance error:", error);
    return json(500, { error: "Internal server error" });
  }
};

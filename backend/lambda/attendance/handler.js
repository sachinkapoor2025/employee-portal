const { getUser } = require("../common/auth");
const { DynamoDBClient, PutItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  const user = getUser(event);
  const tableName = process.env.ATTENDANCE_TABLE;

  if (event.httpMethod === 'POST') {
    const attendanceData = JSON.parse(event.body);
    // attendanceData is array of { date, status, hours? }

    for (const item of attendanceData) {
      const params = {
        TableName: tableName,
        Item: {
          PK: { S: user.email },
          SK: { S: item.date },
          status: { S: item.status },
          ...(item.hours && { hours: { N: item.hours.toString() } })
        }
      };
      await client.send(new PutItemCommand(params));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Attendance saved" })
    };
  } else if (event.httpMethod === 'GET') {
    const { startDate, endDate } = event.queryStringParameters || {};
    if (!startDate || !endDate) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "startDate and endDate required" })
      };
    }

    const params = {
      TableName: tableName,
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":pk": { S: user.email },
        ":start": { S: startDate },
        ":end": { S: endDate }
      }
    };

    const result = await client.send(new QueryCommand(params));
    const attendance = result.Items.map(item => ({
      date: item.SK.S,
      status: item.status.S,
      hours: item.hours ? parseFloat(item.hours.N) : null
    }));

    return {
      statusCode: 200,
      body: JSON.stringify(attendance)
    };
  }

  return {
    statusCode: 405,
    body: JSON.stringify({ error: "Method not allowed" })
  };
};

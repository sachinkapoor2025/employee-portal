const { getUser } = require("../common/auth");
const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  const user = getUser(event);
  const tableName = process.env.TRAINING_PROGRESS_TABLE;

  // Fetch training progress for Advanced videos
  let totalPoints = 0;
  try {
    const params = {
      TableName: tableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": { S: user.email }
      }
    };
    const result = await client.send(new QueryCommand(params));
    for (const item of result.Items) {
      if (item.points && item.status.S === 'Completed') {
        totalPoints += parseInt(item.points.N);
      }
    }
  } catch (error) {
    console.error("Error fetching training points:", error);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      chargedHours: 40,
      completedHours: 32,
      rating: "Good Performer",
      trainingPoints: totalPoints
    })
  };
};

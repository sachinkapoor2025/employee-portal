import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

export const handler = async () => {
  try {
    const params = {
      TableName: process.env.SKILL_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": "SKILL",
      },
    };

    const result = await ddb.send(new QueryCommand(params));

    const skills = (result.Items || [])
      .filter((skill) => skill.active === true)
      .map((skill) => ({
        code: skill.SK,
        name: skill.name,
      }));

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
      },
      body: JSON.stringify(skills),
    };
  } catch (err) {
    console.error("Error fetching skills:", err);

    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ message: "Failed to fetch skills" }),
    };
  }
};

const AWS = require("aws-sdk");
const db = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  const claims = event.requestContext.authorizer.claims;
  const email = claims.email;
  const body = JSON.parse(event.body);

  await db.put({
    TableName: "Attendance",
    Item: {
      PK: `USER#${email}`,
      SK: `DATE#${new Date().toISOString().slice(0,10)}`,
      hours: body.hours,
      status: body.status
    }
  }).promise();

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Attendance saved" })
  };
};

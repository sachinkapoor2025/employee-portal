import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION,
});

const ddbClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
});

const ddb = DynamoDBDocumentClient.from(ddbClient);

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);

    const { mode, email, role, profile } = body;

    if (!mode || !email) {
      return response(400, "mode and email are required");
    }

    // =============================
    // CREATE USER (ADMIN FLOW)
    // =============================
    if (mode === "CREATE") {
      try {
        const createUserCmd = new AdminCreateUserCommand({
          UserPoolId: process.env.USER_POOL_ID,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
          DesiredDeliveryMediums: ["EMAIL"],
        });

        await cognito.send(createUserCmd);
      } catch (err) {
        // User already exists → safe to ignore
        if (err.name !== "UsernameExistsException") {
          console.error("Cognito error:", err);
          throw err;
        }
      }

      // Save in userAccess
      await ddb.send(
        new PutCommand({
          TableName: process.env.USER_ACCESS_TABLE,
          Item: {
            PK: email,
            SK: email,
            email,
            role: role || "USER",
            status: "ACTIVE",
            createdAt: new Date().toISOString(),
          },
        })
      );
    }

    // =============================
    // SAVE / UPDATE USER PROFILE
    // =============================
    await ddb.send(
      new PutCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Item: {
          PK: `USER#${email}`,
          SK: "PROFILE",
          email,
          ...profile,
          updatedAt: new Date().toISOString(),
        },
      })
    );

    return response(200, {
      message: "User saved successfully",
    });
  } catch (error) {
    console.error("Lambda error:", error);
    return response(500, "Internal server error");
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

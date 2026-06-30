import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION,
});

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(ddbClient);

const ALLOWED_DOMAIN = "@mydgv.com";

function isAllowedEmail(email) {
  return email && email.toLowerCase().endsWith(ALLOWED_DOMAIN);
}

async function syncCognitoGroup(email, role) {
  const group = role === "ADMIN" ? "Admin" : "Employee";
  const other = role === "ADMIN" ? "Employee" : "Admin";

  try {
    await cognito.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Username: email,
        GroupName: other,
      })
    );
  } catch {
    // user may not be in the other group
  }

  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: email,
      GroupName: group,
    })
  );
}

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { mode, email, role, profile } = body;

    if (!mode || !email) {
      return response(400, "mode and email are required");
    }

    if (!isAllowedEmail(email)) {
      return response(400, "Only @mydgv.com email addresses are allowed");
    }

    const userRole = role === "ADMIN" ? "ADMIN" : "USER";

    if (mode === "CREATE") {
      try {
        await cognito.send(
          new AdminCreateUserCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: email,
            UserAttributes: [
              { Name: "email", Value: email },
              { Name: "email_verified", Value: "true" },
            ],
            DesiredDeliveryMediums: ["EMAIL"],
          })
        );
      } catch (err) {
        if (err.name !== "UsernameExistsException") {
          console.error("Cognito error:", err);
          throw err;
        }
      }

      await syncCognitoGroup(email, userRole);

      await ddb.send(
        new PutCommand({
          TableName: process.env.USER_ACCESS_TABLE,
          Item: {
            PK: email,
            SK: email,
            email,
            role: userRole,
            status: "ACTIVE",
            createdAt: new Date().toISOString(),
          },
        })
      );
    }

    if (mode === "EDIT" && role) {
      await syncCognitoGroup(email, userRole);
    }

    await ddb.send(
      new PutCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Item: {
          PK: `USER#${email}`,
          SK: "PROFILE",
          email,
          ...profile,
          skill: profile?.skill
            ? String(profile.skill).trim().toUpperCase()
            : profile?.skill,
          updatedAt: new Date().toISOString(),
        },
      })
    );

    return response(200, { message: "User saved successfully" });
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

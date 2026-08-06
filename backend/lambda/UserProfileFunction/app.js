const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION,
});
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

const ALLOWED_DOMAIN = "@mydgv.com";

function isAllowedEmail(email) {
  return email && email.toLowerCase().endsWith(ALLOWED_DOMAIN);
}

/** Meets Cognito policy: upper, lower, number, symbol, min 8 */
function generateTempPassword() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `DgV#${rand}A1!`;
}

async function createCognitoUser(email, name) {
  const temporaryPassword = generateTempPassword();

  try {
    // Do NOT rely on Cognito invitation email (SES often not configured).
    // Create with temp password; admin shares it with the employee.
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Username: email,
        TemporaryPassword: temporaryPassword,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          ...(name ? [{ Name: "name", Value: name }] : []),
        ],
      })
    );
    return { created: true, temporaryPassword };
  } catch (err) {
    if (err.name === "UsernameExistsException") {
      return { created: false, alreadyExists: true };
    }
    throw err;
  }
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(200, { ok: true });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { mode, email, role, profile } = body;

    if (!mode || !email) {
      return response(400, { error: "mode and email are required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    if (!isAllowedEmail(normalizedEmail)) {
      return response(400, {
        error: "Only @mydgv.com email addresses are allowed",
      });
    }

    if (
      !process.env.USER_POOL_ID ||
      !process.env.USER_ACCESS_TABLE ||
      !process.env.USER_PROFILE_TABLE
    ) {
      console.error("Missing env vars for UserProfileFunction");
      return response(500, {
        error: "Server misconfigured (missing Cognito/table settings)",
      });
    }

    const userRole = role === "ADMIN" ? "ADMIN" : "USER";
    let createMeta = null;

    if (mode === "CREATE") {
      try {
        createMeta = await createCognitoUser(
          normalizedEmail,
          profile?.name || ""
        );
      } catch (err) {
        console.error("Cognito create failed:", err);
        return response(500, {
          error: `Cognito create failed: ${err.name || "Error"} — ${
            err.message || "unknown"
          }`,
        });
      }

      try {
        await syncCognitoGroup(normalizedEmail, userRole);
      } catch (err) {
        console.error("Cognito group sync failed:", err);
        return response(500, {
          error: `User created but role assignment failed: ${
            err.message || "unknown error"
          }`,
        });
      }

      await ddb.send(
        new PutCommand({
          TableName: process.env.USER_ACCESS_TABLE,
          Item: {
            PK: normalizedEmail,
            SK: normalizedEmail,
            email: normalizedEmail,
            role: userRole,
            status: "ACTIVE",
            createdAt: new Date().toISOString(),
          },
        })
      );
    }

    if (mode === "EDIT" && role) {
      await syncCognitoGroup(normalizedEmail, userRole);
    }

    await ddb.send(
      new PutCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Item: {
          PK: `USER#${normalizedEmail}`,
          SK: "PROFILE",
          ...(profile || {}),
          email: normalizedEmail,
          skill: profile?.skill
            ? String(profile.skill).trim().toUpperCase()
            : profile?.skill,
          updatedAt: new Date().toISOString(),
        },
      })
    );

    const result = { message: "User saved successfully" };

    if (createMeta?.temporaryPassword) {
      result.warning =
        "No invitation email was sent. Share this temporary password with the employee.";
      result.temporaryPassword = createMeta.temporaryPassword;
    } else if (createMeta?.alreadyExists) {
      result.warning =
        "Cognito user already existed; access/profile records were updated.";
    }

    return response(200, result);
  } catch (error) {
    console.error("Lambda error:", error);
    return response(500, {
      error: error.message || "Internal server error",
    });
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

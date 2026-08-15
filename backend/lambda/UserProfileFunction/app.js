const { getUser } = require("../common/auth");
const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const {
  normalizeRole,
  cognitoGroupForRole,
  isValidAssignableRole,
} = require("../common/roles");

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

function isS3ObjectKey(key) {
  const value = String(key || "").trim();
  if (!value) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) return false;
  if (/^https?:\/\//i.test(value) || value.includes("..")) return false;
  return true;
}

function s3KeyFromFileUrl(fileUrl) {
  if (!fileUrl || typeof fileUrl !== "string") return "";
  const raw = String(fileUrl).split("?")[0];
  const idx = raw.indexOf("/profiles/");
  if (idx >= 0) {
    try {
      return decodeURIComponent(raw.slice(idx + 1).replace(/\+/g, "%20"));
    } catch {
      return raw.slice(idx + 1);
    }
  }
  try {
    const u = new URL(raw.replace(/ /g, "%20"));
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const host = u.hostname.toLowerCase();
    const pathStyle =
      host === "s3.amazonaws.com" ||
      /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host);
    if (pathStyle) {
      const parts = path.split("/");
      parts.shift();
      path = parts.join("/");
    }
    return isS3ObjectKey(path) ? path : "";
  } catch {
    return "";
  }
}

function generateTempPassword() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `DgV#${rand}A1!`;
}

async function createCognitoUser(email, name) {
  const temporaryPassword = generateTempPassword();

  try {
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
  const group = cognitoGroupForRole(role);
  const other = group === "Admin" ? "Employee" : "Admin";

  try {
    await cognito.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Username: email,
        GroupName: other,
      })
    );
  } catch {
    /* ignore */
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
      return response(500, {
        error: "Server misconfigured (missing Cognito/table settings)",
      });
    }

    const userRole = isValidAssignableRole(role)
      ? normalizeRole(role)
      : normalizeRole("EMPLOYEE");
    let createMeta = null;

    const user = getUser(event);
    if (!user.email) {
      return response(401, { error: "Unauthorized" });
    }

    if (!user.isAdmin) {
      if (mode !== "EDIT") {
        return response(403, { error: "Admin required" });
      }
      if (normalizedEmail !== user.email) {
        return response(403, { error: "You can only edit your own profile" });
      }
    }

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

    if (mode === "EDIT" && user.isAdmin && role && isValidAssignableRole(role)) {
      await syncCognitoGroup(normalizedEmail, userRole);
      await ddb.send(
        new UpdateCommand({
          TableName: process.env.USER_ACCESS_TABLE,
          Key: { PK: normalizedEmail, SK: normalizedEmail },
          UpdateExpression: "SET #role = :role, updatedAt = :updatedAt",
          ExpressionAttributeNames: { "#role": "role" },
          ExpressionAttributeValues: {
            ":role": userRole,
            ":updatedAt": new Date().toISOString(),
          },
        })
      );
    }

    const profileData = { ...(profile || {}) };
    delete profileData.PK;
    delete profileData.SK;
    delete profileData.profileImageUrl;
    delete profileData.imageStorageUrl;
    if (profileData.imageUrl && String(profileData.imageUrl).includes("X-Amz-")) {
      profileData.imageUrl = String(profileData.imageUrl).split("?")[0];
    }
    if (isS3ObjectKey(profileData.imageUrl) && !profileData.imageS3Key) {
      profileData.imageS3Key = String(profileData.imageUrl).trim();
    }
    if (!profileData.imageS3Key && profileData.imageUrl) {
      const fromUrl = s3KeyFromFileUrl(profileData.imageUrl);
      if (fromUrl) profileData.imageS3Key = fromUrl;
    }

    let existingProfile = {};
    try {
      const existing = await ddb.send(
        new GetCommand({
          TableName: process.env.USER_PROFILE_TABLE,
          Key: { PK: `USER#${normalizedEmail}`, SK: "PROFILE" },
        })
      );
      existingProfile = existing.Item || {};
    } catch {
      existingProfile = {};
    }
    if (profileData.resignations == null && Array.isArray(existingProfile.resignations)) {
      profileData.resignations = existingProfile.resignations;
    }

    try {
      await ddb.send(
        new PutCommand({
          TableName: process.env.USER_PROFILE_TABLE,
          Item: {
            PK: `USER#${normalizedEmail}`,
            SK: "PROFILE",
            ...profileData,
            email: normalizedEmail,
            department: profileData?.department
              ? String(profileData.department).trim()
              : "",
            skill: profileData?.skill
              ? String(profileData.skill).trim().toUpperCase()
              : profileData?.skill,
            updatedAt: new Date().toISOString(),
          },
        })
      );
    } catch (err) {
      console.error("DYNAMODB_PROFILE_UPDATE_FAILED", err?.name);
      throw err;
    }

    const result = { message: "User saved successfully", role: userRole };

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

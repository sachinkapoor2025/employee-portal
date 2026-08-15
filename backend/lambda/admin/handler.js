const { getUser } = require("../common/auth");
const {
  normalizeRole,
  isAdminPortalRole,
  cognitoGroupForRole,
  isValidAssignableRole,
} = require("../common/roles");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION,
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json",
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  };
}

function generateTempPassword() {
  return `DgV#${Math.random().toString(36).slice(2, 10)}A1!`;
}

async function scanAll(tableName) {
  const items = [];
  let lastKey;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function syncCognitoGroup(email, role) {
  const target = cognitoGroupForRole(role);
  const other = target === "Admin" ? "Employee" : "Admin";

  try {
    await cognito.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Username: email,
        GroupName: other,
      })
    );
  } catch {
    /* may not be in other group */
  }

  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: email,
      GroupName: target,
    })
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return respond(200, { ok: true });
  }

  const adminUser = getUser(event);
  const tableName = process.env.USER_ACCESS_TABLE;
  const profileTable = process.env.USER_PROFILE_TABLE;

  if (!adminUser.isAdmin) {
    return respond(403, { error: "Admin access required" });
  }

  if (event.httpMethod === "GET") {
    try {
      const accessItems = await scanAll(tableName);
      let profileByEmail = {};

      if (profileTable) {
        const profiles = await scanAll(profileTable);
        profileByEmail = Object.fromEntries(
          profiles
            .filter((p) => p.email || (p.PK && String(p.PK).startsWith("USER#")))
            .map((p) => {
              const email = (
                p.email || String(p.PK || "").replace(/^USER#/, "")
              ).toLowerCase();
              return [email, p];
            })
        );
      }

      const users = accessItems
        .map((item) => {
          const email = (item.email || item.PK || "").toLowerCase();
          if (!email || !email.includes("@")) return null;
          const profile = profileByEmail[email] || {};
          const role = normalizeRole(item.role);

          return {
            email,
            role,
            status: item.status || "UNKNOWN",
            createdAt: item.createdAt || "",
            updatedAt: item.updatedAt || "",
            name: profile.name || "",
            empId: profile.empId || "",
            department: profile.department || "",
            designation: profile.designation || "",
            skill: profile.skill || "",
            manager: profile.manager || "",
            groupLead: profile.groupLead || "",
            phone: profile.phone || "",
            doj: profile.doj || "",
            lastLogin: profile.lastLogin || item.lastLogin || "",
          };
        })
        .filter(Boolean)
        .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

      return respond(200, users);
    } catch (error) {
      console.error("Error fetching users:", error);
      return respond(500, { error: "Internal server error" });
    }
  }

  if (event.httpMethod === "POST") {
    const body = JSON.parse(event.body || "{}");
    const { email, action, role } = body;
    const normalizedEmail = email ? String(email).trim().toLowerCase() : "";

    if (action === "delete") {
      if (!normalizedEmail) {
        return respond(400, { error: "Email required" });
      }
      if (normalizedEmail === adminUser.email) {
        return respond(400, { error: "You cannot delete your own account" });
      }

      try {
        try {
          await cognito.send(
            new AdminDeleteUserCommand({
              UserPoolId: process.env.USER_POOL_ID,
              Username: normalizedEmail,
            })
          );
        } catch (err) {
          if (err.name !== "UserNotFoundException") throw err;
        }

        await client.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { PK: normalizedEmail, SK: normalizedEmail },
          })
        );

        if (profileTable) {
          await client.send(
            new DeleteCommand({
              TableName: profileTable,
              Key: { PK: `USER#${normalizedEmail}`, SK: "PROFILE" },
            })
          );
        }

        return respond(200, { message: "User deleted" });
      } catch (error) {
        console.error("Error deleting user:", error);
        return respond(500, { error: "Failed to delete user" });
      }
    }

    if (action === "resetPassword") {
      if (!normalizedEmail) {
        return respond(400, { error: "Email required" });
      }
      try {
        const temporaryPassword = generateTempPassword();
        await cognito.send(
          new AdminSetUserPasswordCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: normalizedEmail,
            Password: temporaryPassword,
            Permanent: false,
          })
        );
        return respond(200, {
          message: "Temporary password set",
          temporaryPassword,
        });
      } catch (error) {
        console.error("Reset password failed:", error);
        return respond(500, {
          error: error.message || "Failed to reset password",
        });
      }
    }

    if (action === "changeRole") {
      if (!normalizedEmail || !isValidAssignableRole(role)) {
        return respond(400, {
          error: "Valid email and role (SUPER_ADMIN|ADMIN|MANAGER|EMPLOYEE) required",
        });
      }

      const nextRole = normalizeRole(role);

      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: normalizedEmail, SK: normalizedEmail },
            UpdateExpression: "SET #role = :role, updatedAt = :updatedAt",
            ExpressionAttributeNames: { "#role": "role" },
            ExpressionAttributeValues: {
              ":role": nextRole,
              ":updatedAt": new Date().toISOString(),
            },
          })
        );

        try {
          await syncCognitoGroup(normalizedEmail, nextRole);
        } catch (err) {
          console.error("Cognito group sync failed:", err);
          return respond(500, {
            error:
              "Role saved but Cognito group sync failed: " +
              (err.message || "unknown"),
          });
        }

        return respond(200, {
          message: "Role updated",
          role: nextRole,
          portalAccess: isAdminPortalRole(nextRole) ? "ADMIN" : "USER",
        });
      } catch (error) {
        console.error("changeRole failed:", error);
        return respond(500, { error: "Failed to update role" });
      }
    }

    const updates = {};
    if (action === "approve" || action === "activate") updates.status = "ACTIVE";
    else if (action === "reject" || action === "block" || action === "deactivate") {
      updates.status = "BLOCKED";
    }

    if (!normalizedEmail || Object.keys(updates).length === 0) {
      return respond(400, { error: "Invalid request" });
    }

    const setParts = ["updatedAt = :updatedAt"];
    const names = {};
    const values = { ":updatedAt": new Date().toISOString() };
    Object.entries(updates).forEach(([key, value], i) => {
      setParts.push(`#f${i} = :v${i}`);
      names[`#f${i}`] = key;
      values[`:v${i}`] = value;
    });

    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: normalizedEmail, SK: normalizedEmail },
          UpdateExpression: `SET ${setParts.join(", ")}`,
          ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
          ExpressionAttributeValues: values,
        })
      );

      return respond(200, { message: "User updated" });
    } catch (error) {
      console.error("Error updating user:", error);
      return respond(500, { error: "Internal server error" });
    }
  }

  return respond(405, { error: "Method not allowed" });
};

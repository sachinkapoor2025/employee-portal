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
  canAssignPortalRole,
  isSuperAdminRole,
} = require("../common/roles");
const departments = require("../projects/departments");
const orgDesignations = require("../projects/departmentDesignations");
const costingDesignation = require("../projects/costingDesignation");
const { requireEligiblePortalAdmin } = require("../projects/portalAdminAuth");

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

async function loadUserAccessRole(email) {
  const table = process.env.USER_ACCESS_TABLE;
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!table || !normalized) return null;
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: table,
        Key: { PK: normalized, SK: normalized },
      })
    );
    return res.Item?.role || null;
  } catch {
    return null;
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

  const membershipPath = departments.membershipPathMatch(
    event.path || "",
    event.pathParameters
  );
  if (membershipPath) {
    if (!membershipPath.ok) {
      return response(400, { error: "Invalid path parameter." });
    }
    try {
      const membershipCtx = {
        user: getUser(event),
        email: membershipPath.value,
        body: event.body ? JSON.parse(event.body) : {},
        ddb,
        tableName: process.env.WORK_TABLE,
        accessTable: process.env.USER_ACCESS_TABLE,
        profileTable: process.env.USER_PROFILE_TABLE,
      };
      const method = event.httpMethod;
      if (method === "GET") {
        const result = await departments.handleGetMembership(membershipCtx);
        return response(result.statusCode, result.body);
      }
      if (method === "PUT") {
        const result = await departments.handlePutMembership(membershipCtx);
        return response(result.statusCode, result.body);
      }
      return response(405, { error: "Method not allowed" });
    } catch (error) {
      console.error("Department membership error:", error);
      return response(500, { error: error.message || "Internal server error" });
    }
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

    const actorRole = await loadUserAccessRole(user.email);
    if (user.isAdmin && role && isValidAssignableRole(role)) {
      if (!canAssignPortalRole(actorRole, userRole)) {
        if (mode === "CREATE") {
          return response(403, {
            error: "Only Super Admin can assign the Super Admin role.",
          });
        }
        const existingRole = await loadUserAccessRole(normalizedEmail);
        if (!isSuperAdminRole(existingRole) || !isSuperAdminRole(userRole)) {
          return response(403, {
            error: "Only Super Admin can assign the Super Admin role.",
          });
        }
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
      if (canAssignPortalRole(actorRole, userRole)) {
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
    }

    const incomingProfile = { ...(profile || {}) };
    if (incomingProfile.imageUrl && String(incomingProfile.imageUrl).includes("X-Amz-")) {
      incomingProfile.imageUrl = String(incomingProfile.imageUrl).split("?")[0];
    }
    if (isS3ObjectKey(incomingProfile.imageUrl) && !incomingProfile.imageS3Key) {
      incomingProfile.imageS3Key = String(incomingProfile.imageUrl).trim();
    }
    if (!incomingProfile.imageS3Key && incomingProfile.imageUrl) {
      const fromUrl = s3KeyFromFileUrl(incomingProfile.imageUrl);
      if (fromUrl) incomingProfile.imageS3Key = fromUrl;
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

    const assignmentTouched =
      user.isAdmin &&
      (Object.prototype.hasOwnProperty.call(incomingProfile, "departmentIds") ||
        Object.prototype.hasOwnProperty.call(incomingProfile, "primaryDepartmentId") ||
        Object.prototype.hasOwnProperty.call(incomingProfile, "departmentDesignations") ||
        Object.prototype.hasOwnProperty.call(incomingProfile, "costingDesignationId"));
    if (assignmentTouched) {
      const portal = await requireEligiblePortalAdmin({
        user,
        ddb,
        accessTable: process.env.USER_ACCESS_TABLE,
      });
      if (!portal.ok) return response(portal.statusCode, portal.body);
    }

    const profileData = departments.profileFieldsForActor({
      isAdmin: user.isAdmin,
      profileData: incomingProfile,
    });
    delete profileData.costingDesignationId;
    let membership;
    if (
      user.isAdmin &&
      (Object.prototype.hasOwnProperty.call(incomingProfile, "departmentIds") ||
        Object.prototype.hasOwnProperty.call(incomingProfile, "primaryDepartmentId"))
    ) {
      if (!Array.isArray(incomingProfile.departmentIds)) {
        return response(400, { error: "departmentIds must be an array of department IDs." });
      }
      const requested = incomingProfile.departmentIds;
      const knownIds = [
        ...requested,
        ...(Array.isArray(existingProfile.departmentIds)
          ? existingProfile.departmentIds
          : []),
      ];
      const departmentsById = new Map();
      for (const id of knownIds) {
        const key = String(id || "").trim();
        if (!key || departmentsById.has(key)) continue;
        const item = await departments.getDepartmentItem(
          ddb,
          process.env.WORK_TABLE,
          key
        );
        if (item) departmentsById.set(key, item);
      }
      const resolved = departments.resolveMembership({
        departmentIds: requested,
        primaryDepartmentId: incomingProfile.primaryDepartmentId,
        existingIds: Array.isArray(existingProfile.departmentIds)
          ? existingProfile.departmentIds
          : [],
        departmentsById,
      });
      if (!resolved.ok) {
        return response(400, { error: resolved.error });
      }
      membership = resolved;
      delete profileData.departmentIds;
      delete profileData.primaryDepartmentId;
    }

    if (
      user.isAdmin &&
      Object.prototype.hasOwnProperty.call(incomingProfile, "departmentDesignations")
    ) {
      const departmentIds = membership
        ? membership.departmentIds
        : Array.isArray(existingProfile.departmentIds)
          ? existingProfile.departmentIds
          : [];
      const linked = await orgDesignations.resolveDepartmentDesignations({
        ddb,
        tableName: process.env.WORK_TABLE,
        departmentIds,
        requested: incomingProfile.departmentDesignations,
        existingProfile,
      });
      if (!linked.ok) return response(400, { error: linked.error });
      membership = {
        ...(membership || {
          departmentIds,
          primaryDepartmentId: existingProfile.primaryDepartmentId || "",
        }),
        departmentDesignations: linked.departmentDesignations,
      };
      delete profileData.departmentDesignations;
    }

    if (assignmentTouched) {
      const links =
        membership &&
        Object.prototype.hasOwnProperty.call(membership, "departmentDesignations")
          ? membership.departmentDesignations
          : orgDesignations.existingLinks(existingProfile).filter((row) =>
              membership
                ? (membership.departmentIds || []).includes(row.departmentId)
                : true
            );
      const costing = await costingDesignation.syncCostingDesignation({
        ddb,
        tableName: process.env.WORK_TABLE,
        email: normalizedEmail,
        links,
        requested: Object.prototype.hasOwnProperty.call(
          incomingProfile,
          "costingDesignationId"
        )
          ? incomingProfile.costingDesignationId
          : undefined,
        actor: user.email,
      });
      if (!costing.ok) return response(400, { error: costing.error });
    }

    try {
      await ddb.send(
        new PutCommand({
          TableName: process.env.USER_PROFILE_TABLE,
          Item: departments.mergeProfileForSave({
            existing: existingProfile,
            profileData,
            email: normalizedEmail,
            membership,
          }),
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

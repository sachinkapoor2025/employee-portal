const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { randomUUID } = require("crypto");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.SOFTWARE_BUCKET;

async function deleteS3Object(key) {
  if (!key || !BUCKET) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    console.warn("S3 delete failed:", key, err.message);
  }
}

async function getSoftwareItem(softwareId) {
  const existing = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: {
        ":pk": "ENTITY#SOFTWARE",
        ":sk": `SW#${softwareId}`,
      },
    })
  );
  return existing.Items?.[0] || null;
}

async function listSoftware(activeOnly) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "ENTITY#SOFTWARE" },
    })
  );

  let items = res.Items || [];
  if (activeOnly) {
    items = items.filter((s) => s.active !== false);
  }

  return Promise.all(
    items.map(async (item) => {
      if (item.downloadType === "file" && item.s3Key) {
        try {
          const url = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET, Key: item.s3Key }),
            { expiresIn: 3600 }
          );
          return { ...item, downloadUrl: url, fileAvailable: true };
        } catch {
          return { ...item, downloadUrl: null, fileAvailable: false };
        }
      }
      return { ...item, fileAvailable: !!item.downloadUrl };
    })
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  const path = event.path || "";
  const body = event.body ? JSON.parse(event.body) : {};
  const isAdminPath = path.includes("/admin/");

  try {
    if (event.httpMethod === "GET" && path.includes("/admin/software")) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const items = await listSoftware(false);
      return json(200, items.sort((a, b) => a.name.localeCompare(b.name)));
    }

    if (event.httpMethod === "GET" && path.endsWith("/software")) {
      if (!user.email) return json(401, { error: "Unauthorized" });
      const items = await listSoftware(true);
      return json(200, items.sort((a, b) => a.name.localeCompare(b.name)));
    }

    if (path.endsWith("/software/upload-url") && event.httpMethod === "POST") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const { fileName } = body;
      if (!fileName) return json(400, { error: "fileName required" });

      const s3Key = `software/${randomUUID()}-${fileName}`;
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: s3Key,
          ContentType: "application/octet-stream",
        }),
        { expiresIn: 900 }
      );

      return json(200, { uploadUrl, s3Key });
    }

    if (path.endsWith("/software") && event.httpMethod === "POST" && isAdminPath) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const { name, description, category, platform, vendor, version, downloadType, downloadUrl, s3Key } = body;
      if (!name || !downloadType) {
        return json(400, { error: "name and downloadType required" });
      }

      const id = randomUUID();
      const item = {
        PK: "ENTITY#SOFTWARE",
        SK: `SW#${id}`,
        softwareId: id,
        name,
        description: description || "",
        category: category || "General",
        platform: platform || "Windows",
        vendor: vendor || "",
        version: version || "",
        downloadType,
        downloadUrl: downloadType === "external" ? downloadUrl : null,
        s3Key: downloadType === "file" ? s3Key : null,
        active: true,
        verified: true,
        createdAt: new Date().toISOString(),
        createdBy: user.email,
      };

      await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: item }));
      return json(201, item);
    }

    if (path.endsWith("/software") && event.httpMethod === "PUT" && isAdminPath) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const { softwareId, replaceFile, ...updates } = body;
      if (!softwareId) return json(400, { error: "softwareId required" });

      const item = await getSoftwareItem(softwareId);
      if (!item) return json(404, { error: "Not found" });

      const oldS3Key = item.s3Key;
      const newS3Key = updates.s3Key;

      if (replaceFile && newS3Key && oldS3Key && oldS3Key !== newS3Key) {
        await deleteS3Object(oldS3Key);
      }

      const merged = {
        ...item,
        ...updates,
        softwareId,
        downloadType: updates.downloadType || item.downloadType,
        downloadUrl:
          (updates.downloadType || item.downloadType) === "external"
            ? updates.downloadUrl ?? item.downloadUrl
            : null,
        s3Key:
          (updates.downloadType || item.downloadType) === "file"
            ? newS3Key || item.s3Key
            : updates.downloadType === "external"
              ? null
              : item.s3Key,
        updatedAt: new Date().toISOString(),
        updatedBy: user.email,
      };

      if (replaceFile || updates.version) {
        merged.version = updates.version || merged.version;
      }

      await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: merged }));
      return json(200, merged);
    }

    if (path.endsWith("/software") && event.httpMethod === "DELETE" && isAdminPath) {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const { softwareId } = body;
      if (!softwareId) return json(400, { error: "softwareId required" });

      const item = await getSoftwareItem(softwareId);
      if (item?.s3Key) {
        await deleteS3Object(item.s3Key);
      }

      await ddb.send(
        new DeleteCommand({
          TableName: process.env.WORK_TABLE,
          Key: { PK: "ENTITY#SOFTWARE", SK: `SW#${softwareId}` },
        })
      );

      return json(200, { ok: true, message: "Software removed from catalog" });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Software error:", err);
    return json(500, { error: "Internal server error" });
  }
};

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const s3 = new S3Client({ region: process.env.AWS_REGION });

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

async function withDocumentUrls(item) {
  const docs = item?.hrDocuments;
  const bucket = process.env.PROFILE_IMAGE_BUCKET;
  if (!bucket || !Array.isArray(docs) || !docs.length) return item || {};
  const hrDocuments = await Promise.all(
    docs.map(async (d) => {
      const s3Key = [
        d?.s3Key,
        d?.storageKey,
        s3KeyFromFileUrl(d?.fileUrl),
        s3KeyFromFileUrl(d?.imageUrl),
      ].find((key) => isS3ObjectKey(key));
      if (!s3Key) return d;
      try {
        console.log("Document view request:", d.documentId);
        console.log("Authenticated user:", item?.email);
        console.log("S3 storage key:", s3Key);
        console.log("Generating signed URL...");
        const safeName = String(d.fileName || "document").replace(/"/g, "");
        const downloadUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: bucket,
            Key: s3Key,
            ResponseContentDisposition: `inline; filename="${safeName}"`,
          }),
          { expiresIn: 300 }
        );
        console.log("Signed URL generated successfully");
        return { ...d, s3Key, downloadUrl, url: downloadUrl };
      } catch (err) {
        console.error("SIGNED_URL_GENERATION_FAILED", d.documentId, err?.name);
        return { ...d, s3Key };
      }
    })
  );
  return { ...item, hrDocuments };
}

function resolveProfileImageKey(item) {
  const candidates = [
    item?.imageS3Key,
    item?.imageKey,
    item?.profileImageKey,
    item?.imageUrl,
  ];
  for (const value of candidates) {
    if (isS3ObjectKey(value)) return String(value).trim();
    const fromUrl = s3KeyFromFileUrl(value);
    if (fromUrl) return fromUrl;
  }
  return "";
}

async function withProfileImage(item) {
  const bucket = process.env.PROFILE_IMAGE_BUCKET;
  if (!item) return item || {};
  const s3Key = resolveProfileImageKey(item);
  if (!s3Key) {
    if (item.imageUrl || item.imageS3Key) {
      console.error("PROFILE_IMAGE_MISSING_KEY");
    }
    return item;
  }
  if (!bucket) {
    console.error("AWS_CONFIGURATION_ERROR: PROFILE_IMAGE_BUCKET not set");
    return { ...item, imageS3Key: s3Key };
  }

  let objectMissing = false;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    const name = String(err?.name || err?.Code || "");
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") {
      console.error("S3_OBJECT_NOT_FOUND");
      objectMissing = true;
    } else {
      console.error("PROFILE_IMAGE_HEAD_FAILED", name);
    }
  }
  if (objectMissing) {
    return { ...item, imageS3Key: s3Key };
  }

  try {
    console.log("Generating profile image signed GET URL");
    const profileImageUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: s3Key,
      }),
      { expiresIn: 300 }
    );
    console.log("Profile image signed GET URL generated");
    return {
      ...item,
      imageS3Key: s3Key,
      profileImageUrl,
    };
  } catch (err) {
    console.error("PROFILE_IMAGE_SIGNED_URL_FAILED", err?.name);
    return { ...item, imageS3Key: s3Key };
  }
}

export const handler = async (event) => {
  console.log("EVENT:", JSON.stringify(event));

  try {
    // admin case → ?email=
    let email = event.queryStringParameters?.email;

    // user self profile → from cognito
    if (!email) {
      const claims = event.requestContext?.authorizer?.claims || {};
      email =
        claims.email ||
        claims["cognito:username"] ||
        claims.username ||
        "";
    }

    if (!email) {
      return response(400, { message: "Email is required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const result = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: {
          PK: `USER#${normalizedEmail}`,
          SK: "PROFILE",
        },
      })
    );

    const item = await withProfileImage(
      await withDocumentUrls(result.Item || {})
    );
    return response(200, item);
  } catch (err) {
    console.error("PROFILE_GET_FAILED", err?.name);
    return response(500, { message: "Failed to fetch profile" });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
  },
  body: JSON.stringify(body),
});

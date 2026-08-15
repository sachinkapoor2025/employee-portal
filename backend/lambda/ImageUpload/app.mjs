import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: process.env.AWS_REGION });

function getCaller(event) {
  const claims = event.requestContext?.authorizer?.claims || {};
  const email = String(
    claims.email || claims["cognito:username"] || claims.username || ""
  )
    .trim()
    .toLowerCase();
  const raw = claims["cognito:groups"];
  let groups = [];
  if (Array.isArray(raw)) groups = raw;
  else if (typeof raw === "string") {
    groups = raw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
  }
  const isAdmin = groups.some((g) => String(g).toLowerCase() === "admin");
  return { email, isAdmin };
}

function mimeFromName(name = "") {
  const ext = String(name).includes(".")
    ? String(name).slice(String(name).lastIndexOf(".")).toLowerCase()
    : "";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".doc") return "application/msword";
  if (ext === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (ext === ".xls") return "application/vnd.ms-excel";
  if (ext === ".xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return "";
}

function isS3ObjectKey(key) {
  const value = String(key || "").trim();
  if (!value) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (value.includes("..")) return false;
  return true;
}

function canReadKey(objectKey, caller) {
  if (caller.isAdmin) return true;
  const match = String(objectKey).match(/^profiles\/([^/]+)\//i);
  if (!match || !caller.email) return false;
  return decodeURIComponent(match[1]).toLowerCase() === caller.email;
}

function s3ErrorCode(err) {
  const status = err?.$metadata?.httpStatusCode;
  const name = String(err?.name || err?.Code || "");
  if (status === 404 || name === "NotFound" || name === "NoSuchKey") {
    return "S3_OBJECT_NOT_FOUND";
  }
  if (status === 403 || name === "AccessDenied" || name === "Forbidden") {
    return "S3_ACCESS_DENIED";
  }
  return "S3_SIGNED_URL_FAILED";
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(200, { ok: true });
  }

  let mode = "";
  try {
    const body = JSON.parse(event.body || "{}");
    const { fileName, contentType, email, s3Key, key, storageKey, documentId } =
      body;
    mode = String(body.mode || "").toLowerCase();
    const bucket = process.env.PROFILE_IMAGE_BUCKET;
    const region = process.env.AWS_REGION;

    if (!bucket) {
      console.error("AWS_CONFIGURATION_ERROR: PROFILE_IMAGE_BUCKET not set");
      return response(500, { message: "AWS_CONFIGURATION_ERROR" });
    }

    if (mode === "view" || mode === "download") {
      const objectKey = String(s3Key || key || storageKey || "").replace(
        /^\/+/,
        ""
      );
      const caller = getCaller(event);
      console.log("Document ID:", documentId || "");
      console.log("Authenticated user:", caller.email);
      console.log("Storage key:", objectKey);
      console.log("S3 bucket:", bucket);
      console.log("S3 region:", region);
      if (!isS3ObjectKey(objectKey)) {
        return response(400, { message: "INVALID_STORAGE_KEY" });
      }
      if (!canReadKey(objectKey, caller)) {
        return response(403, { message: "UNAUTHORIZED" });
      }
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        console.log("Document found:", objectKey);
      } catch (err) {
        const code = s3ErrorCode(err);
        console.error(code, err?.name);
        const status =
          code === "S3_OBJECT_NOT_FOUND"
            ? 404
            : code === "S3_ACCESS_DENIED"
              ? 403
              : 500;
        return response(status, { message: code });
      }
      const inline = mode !== "download";
      const safeName = String(fileName || "document").replace(/"/g, "");
      const viewType = contentType || mimeFromName(fileName) || undefined;
      console.log("Generating signed URL...");
      const commandInput = {
        Bucket: bucket,
        Key: objectKey,
        ResponseContentDisposition: `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
      };
      if (viewType) commandInput.ResponseContentType = viewType;
      const downloadUrl = await getSignedUrl(
        s3,
        new GetObjectCommand(commandInput),
        { expiresIn: 300 }
      );
      console.log("Signed URL generated successfully");
      return response(200, {
        success: true,
        url: downloadUrl,
        downloadUrl,
        expiresIn: 300,
        s3Key: objectKey,
      });
    }

    if (!fileName || !email) {
      return response(400, { message: "Missing required fields" });
    }

    const resolvedType =
      contentType && contentType !== "application/octet-stream"
        ? contentType
        : mimeFromName(fileName) || contentType;
    if (!resolvedType) {
      return response(400, { message: "Missing required fields" });
    }

    const ownerEmail = String(email).trim().toLowerCase();
    const objectKey = `profiles/${ownerEmail}/${Date.now()}-${fileName}`;
    const encodedKey = objectKey
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");

    console.log("Generating profile image upload URL");
    console.log("S3 bucket:", bucket);
    console.log("S3 key:", objectKey);
    let uploadUrl;
    try {
      uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          ContentType: resolvedType,
        }),
        { expiresIn: 300 }
      );
    } catch (err) {
      console.error("S3_UPLOAD_URL_FAILED", err?.name);
      return response(500, { message: "Failed to generate upload url" });
    }

    const imageUrl = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${encodedKey}`;
    console.log("Profile image upload URL generated");

    return response(200, {
      uploadUrl,
      imageUrl,
      s3Key: objectKey,
    });
  } catch (err) {
    const code = s3ErrorCode(err);
    console.error(
      mode === "view" || mode === "download"
        ? "S3_SIGNED_URL_FAILED"
        : "Upload URL error:",
      err?.name,
      err?.message
    );
    if (mode === "view" || mode === "download") {
      return response(500, { message: code });
    }
    return response(500, {
      message: "Failed to generate upload url",
    });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  },
  body: JSON.stringify(body),
});

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  console.log("EVENT:", JSON.stringify(event));

  try {
    const body = JSON.parse(event.body || "{}");
    const { fileName, contentType, email } = body;

    if (!fileName || !contentType || !email) {
      return response(400, { message: "Missing required fields" });
    }

    const bucket = process.env.PROFILE_IMAGE_BUCKET;

    if (!bucket) {
      throw new Error("PROFILE_IMAGE_BUCKET not set");
    }

    const key = `profiles/${email}/${Date.now()}-${fileName}`;

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: 300, // 5 minutes
    });

    const imageUrl = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

    return response(200, {
      uploadUrl,
      imageUrl,
    });
  } catch (err) {
    console.error("Upload URL error:", err);
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

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

const s3 = new S3Client({ region: process.env.AWS_REGION || "ap-south-1" });
const bucket = process.env.TRAINING_BUCKET;

export const handler = async (event) => {
  try {
    const { fileName, skill } = JSON.parse(event.body || "{}");

    if (!fileName || !skill) {
      return response(400, { message: "fileName and skill are required" });
    }

    const video_s3_key = `${skill}/${randomUUID()}-${fileName}`;

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: video_s3_key,
      ContentType: "video/mp4",
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    return response(200, { uploadUrl, video_s3_key });
  } catch (error) {
    console.error(error);
    return response(500, { message: "Failed to generate upload URL" });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  },
  body: JSON.stringify(body),
});

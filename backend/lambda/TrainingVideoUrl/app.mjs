import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: process.env.AWS_REGION || "ap-south-1" });
const bucket = process.env.TRAINING_BUCKET;

export const handler = async (event) => {
  try {
    const { video_s3_key } = JSON.parse(event.body || "{}");

    if (!video_s3_key) {
      return response(400, { message: "video_s3_key is required" });
    }

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: video_s3_key,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 900 });

    return response(200, { url });
  } catch (error) {
    console.error(error);
    return response(500, { message: "Failed to generate URL" });
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

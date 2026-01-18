import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "ap-south-1" });

export const handler = async (event) => {
  try {
    const { video_s3_key } = JSON.parse(event.body || "{}");

    if (!video_s3_key) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
          "Access-Control-Allow-Methods": "POST,OPTIONS",
        },
        body: JSON.stringify({ message: "video_s3_key is required" }),
      };
    }

    const command = new GetObjectCommand({
      Bucket: "dgv-training-materials",
      Key: video_s3_key,
    });

    const url = await getSignedUrl(s3, command, {
      expiresIn: 900, // 15 minutes
    });

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      },
      body: JSON.stringify({ url }),
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      },
      body: JSON.stringify({ message: "Failed to generate URL" }),
    };
  }
};

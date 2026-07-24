const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({ region: process.env.AWS_REGION });
const AGENT_KEY = "DGV-WorkTracker-Setup.exe";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  if (!user.email) return json(401, { error: "Unauthorized" });

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.AGENT_BUCKET,
      Key: AGENT_KEY,
    });

    try {
      const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
      return json(200, {
        available: true,
        downloadUrl: url,
        fileName: AGENT_KEY,
        message: "Download DGV Work Tracker for automatic time tracking.",
      });
    } catch {
      return json(200, {
        available: false,
        fileName: AGENT_KEY,
        message:
          "DGV Work Tracker installer will be available here soon. Use the web portal for check-in and task time until then.",
      });
    }
  } catch (err) {
    console.error("Agent download error:", err);
    return json(500, { error: "Internal server error" });
  }
};

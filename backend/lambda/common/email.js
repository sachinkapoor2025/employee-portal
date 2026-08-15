const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const ses = new SESClient({ region: process.env.AWS_REGION });

function parseFrom(raw) {
  const value = String(raw || "").trim();
  const match = value.match(/^(.*)<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^"|"$/g, ""),
      address: match[2].trim(),
    };
  }
  return { name: process.env.NOTIFICATION_FROM_NAME || "DGV Portal", address: value };
}

/**
 * Send an email through the existing AWS SES account used by this stack.
 * Success requires a provider MessageId. Secrets are never logged.
 */
async function sendEmail({ to, subject, text, html }) {
  const fromRaw = process.env.NOTIFICATION_FROM_EMAIL || "";
  const { name, address } = parseFrom(fromRaw);
  if (!address || !to || !subject) {
    console.error("EMAIL_CONFIG_MISSING");
    return { ok: false, error: "EMAIL_CONFIG_MISSING" };
  }

  try {
    const result = await ses.send(
      new SendEmailCommand({
        Source: name ? `${name} <${address}>` : address,
        Destination: { ToAddresses: [String(to).trim().toLowerCase()] },
        Message: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: text || subject, Charset: "UTF-8" },
            ...(html
              ? { Html: { Data: html, Charset: "UTF-8" } }
              : {}),
          },
        },
      })
    );
    const messageId = result?.MessageId || "";
    if (!messageId) {
      console.error("EMAIL_NO_MESSAGE_ID", String(to).toLowerCase());
      return { ok: false, error: "EMAIL_NO_MESSAGE_ID" };
    }
    return { ok: true, messageId, from: address, to: String(to).toLowerCase() };
  } catch (err) {
    const nameOrCode = err?.name || err?.Code || "EmailSendError";
    console.error("EMAIL_SEND_FAILED", nameOrCode);
    return { ok: false, error: nameOrCode };
  }
}

module.exports = { sendEmail, parseFrom };

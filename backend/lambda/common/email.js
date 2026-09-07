const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

function sesRegion() {
  return (
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "ap-south-1"
  );
}

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

function buildCommand({ source, to, subject, text, html }) {
  return new SendEmailCommand({
    Source: source,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: {
        Text: { Data: text || subject, Charset: "UTF-8" },
        ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}),
      },
    },
  });
}

/**
 * Send an email through the existing AWS SES account used by this stack.
 * Success requires a provider MessageId. Secrets are never logged.
 */
async function sendEmail({ to, subject, text, html }) {
  const fromRaw = process.env.NOTIFICATION_FROM_EMAIL || "";
  const { name, address } = parseFrom(fromRaw);
  const recipient = String(to || "").trim().toLowerCase();
  if (!address || !recipient || !subject) {
    console.error(
      "EMAIL_CONFIG_MISSING",
      JSON.stringify({
        hasFrom: !!address,
        hasTo: !!recipient,
        hasSubject: !!subject,
        region: sesRegion(),
      })
    );
    return { ok: false, error: "EMAIL_CONFIG_MISSING" };
  }

  const ses = new SESClient({ region: sesRegion() });
  const sources = name ? [`${name} <${address}>`, address] : [address];

  let lastError = "EmailSendError";
  for (const source of sources) {
    try {
      const result = await ses.send(
        buildCommand({
          source,
          to: recipient,
          subject,
          text,
          html,
        })
      );
      const messageId = result?.MessageId || "";
      if (!messageId) {
        lastError = "EMAIL_NO_MESSAGE_ID";
        continue;
      }
      console.log(
        "EMAIL_SES_ACCEPTED",
        JSON.stringify({ to: recipient, region: sesRegion() })
      );
      return { ok: true, messageId, from: address, to: recipient };
    } catch (err) {
      lastError = err?.name || err?.Code || "EmailSendError";
      console.error(
        "EMAIL_SEND_FAILED",
        JSON.stringify({
          to: recipient,
          region: sesRegion(),
          error: lastError,
          detail: String(err?.message || "").slice(0, 180),
        })
      );
    }
  }

  return { ok: false, error: lastError };
}

module.exports = { sendEmail, parseFrom };

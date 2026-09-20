const { ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const email = require("../common/email");
const { activeSuperAdminEmailsFromAccess } = require("../common/roles");
const { isConditionalCheckFailed } = require("./taskNotifyPersist");
const { DEFAULT_FROM, notifyFromAddress, notifyFromName } = require("./notifyFrom");
const {
  IMPORT_STATUSES,
  META_SK,
  importPk,
  syncImportHistory,
} = require("./taskImport");

const SUMMARY_SENDING = "SENDING";
const SUMMARY_SENT = "SENT";
const SUMMARY_FAILED = "FAILED";
const SUMMARY_SKIPPED = "SKIPPED";
const CLAIM_STALE_MS = 180000;
const EMAIL_CLAIM_MAX_ATTEMPTS = 5;
const FILE_NAME_MAX = 120;

function portalBaseUrl() {
  return String(process.env.PORTAL_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function importHistoryPath(batchId) {
  const id = String(batchId || "").trim();
  if (!id) return "";
  return `/admin/task-imports/${encodeURIComponent(id)}`;
}

function safeFileName(raw) {
  const cleaned = String(raw || "workbook.xlsx")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, FILE_NAME_MAX);
  return cleaned || "workbook.xlsx";
}

function safeLine(raw, fallback = "") {
  const cleaned = String(raw || fallback)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countModes(tasks = []) {
  let immediateCount = 0;
  let scheduledCount = 0;
  for (const task of tasks) {
    const mode = String(task?.assignmentMode || "").toUpperCase();
    if (mode === "SCHEDULED") scheduledCount += 1;
    else immediateCount += 1;
  }
  return {
    totalCount: tasks.length,
    immediateCount,
    scheduledCount,
  };
}

function buildSummaryEmail({
  fileName,
  uploaderName,
  uploaderEmail,
  batchId,
  totalCount,
  immediateCount,
  scheduledCount,
  portalUrl,
}) {
  const displayFile = safeFileName(fileName);
  const name = safeLine(uploaderName) || safeLine(uploaderEmail, "Admin");
  const email = safeLine(uploaderEmail);
  const uploader =
    email && name.toLowerCase() !== email.toLowerCase()
      ? `${name} (${email})`
      : name || email;
  const subject = `Excel Task Import Completed – ${displayFile}`;
  const portalLine = portalUrl
    ? `Portal reference: ${portalUrl}`
    : "";
  const text = [
    "Excel task import completed successfully.",
    "",
    `Uploaded by: ${uploader}`,
    `Excel file: ${displayFile}`,
    `Import reference: ${safeLine(batchId)}`,
    `Total tasks: ${Number(totalCount) || 0}`,
    `Immediate tasks: ${Number(immediateCount) || 0}`,
    `Scheduled tasks: ${Number(scheduledCount) || 0}`,
    "Processing status: COMPLETED",
    portalLine,
    "",
    "Task details are not included in this summary. Open the portal for the import record.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const html = `<p>Excel task import completed successfully.</p>
<ul>
<li>Uploaded by: ${escapeHtml(uploader)}</li>
<li>Excel file: ${escapeHtml(displayFile)}</li>
<li>Import reference: ${escapeHtml(batchId)}</li>
<li>Total tasks: ${Number(totalCount) || 0}</li>
<li>Immediate tasks: ${Number(immediateCount) || 0}</li>
<li>Scheduled tasks: ${Number(scheduledCount) || 0}</li>
<li>Processing status: COMPLETED</li>
${portalUrl ? `<li>Portal reference: ${escapeHtml(portalUrl)}</li>` : ""}
</ul>
<p>Task details are not included in this summary. Open the portal for the import record.</p>`;

  return { subject, text, html };
}

async function scanAccessRows(ddb, accessTable) {
  if (!ddb || !accessTable) return [];
  const items = [];
  let lastKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: accessTable,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function claimSummaryEmail(ddb, tableName, batchId, nowIso, nowMs) {
  const staleIso = new Date(
    (Number.isFinite(nowMs) ? nowMs : Date.now()) - CLAIM_STALE_MS
  ).toISOString();
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: importPk(batchId), SK: META_SK },
        ConditionExpression:
          "#batchStatus = :completed AND (attribute_not_exists(#emailStatus) OR #emailStatus = :failed OR (#emailStatus = :sending AND #claimed < :stale)) AND (attribute_not_exists(#attempts) OR #attempts < :maxAttempts)",
        UpdateExpression:
          "SET #emailStatus = :sending, #claimed = :now, updatedAt = :now ADD #attempts :one",
        ExpressionAttributeNames: {
          "#batchStatus": "status",
          "#emailStatus": "summaryEmailStatus",
          "#claimed": "summaryEmailClaimedAt",
          "#attempts": "summaryEmailAttempts",
        },
        ExpressionAttributeValues: {
          ":completed": IMPORT_STATUSES.COMPLETED,
          ":sending": SUMMARY_SENDING,
          ":failed": SUMMARY_FAILED,
          ":stale": staleIso,
          ":now": nowIso,
          ":one": 1,
          ":maxAttempts": EMAIL_CLAIM_MAX_ATTEMPTS,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    return { ok: true, meta: res.Attributes || {} };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { ok: false, reason: "ALREADY_CLAIMED" };
    }
    throw err;
  }
}

async function finalizeSummaryEmail(ddb, tableName, batchId, status, extra = {}) {
  const next = String(status || "").toUpperCase();
  const nowIso = extra.nowIso || new Date().toISOString();
  const names = { "#status": "summaryEmailStatus" };
  const values = {
    ":sending": SUMMARY_SENDING,
    ":next": next,
    ":now": nowIso,
  };
  let update =
    "SET #status = :next, summaryEmailUpdatedAt = :now, updatedAt = :now";
  if (extra.error) {
    update += ", summaryEmailError = :error";
    values[":error"] = String(extra.error).slice(0, 180);
  }
  if (extra.recipientCount != null) {
    update += ", summaryEmailRecipientCount = :count";
    values[":count"] = Number(extra.recipientCount) || 0;
  }
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: importPk(batchId), SK: META_SK },
        ConditionExpression: "#status = :sending",
        UpdateExpression: update,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );
    if (res.Attributes) {
      try {
        await syncImportHistory(ddb, tableName, res.Attributes);
      } catch (err) {
        console.error(
          "TASK_IMPORT_SUMMARY_HISTORY_ERROR",
          JSON.stringify({ batchId })
        );
        console.error(err);
      }
    }
    return { ok: true, meta: res.Attributes };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { ok: false, reason: "NOT_OWNER" };
    }
    throw err;
  }
}

async function sendCompletedImportSummaryEmail({
  ddb,
  tableName,
  accessTable,
  batchId,
  tasks = [],
  now,
  nowMs,
  listAccessRows,
  sendEmailFn,
} = {}) {
  if (!ddb || !tableName || !batchId) {
    return { skipped: true, reason: "INVALID_INPUT" };
  }
  const nowIso = now || new Date().toISOString();
  const clock = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

  let claimed;
  try {
    claimed = await claimSummaryEmail(ddb, tableName, batchId, nowIso, clock);
  } catch (err) {
    console.error(
      "TASK_IMPORT_SUMMARY_CLAIM_ERROR",
      JSON.stringify({ batchId })
    );
    console.error(err);
    return { skipped: true, reason: "CLAIM_ERROR" };
  }
  if (!claimed.ok) {
    console.log(
      "TASK_IMPORT_SUMMARY_SKIPPED",
      JSON.stringify({ batchId, reason: claimed.reason || "already sent" })
    );
    return { skipped: true, reason: claimed.reason || "ALREADY_CLAIMED" };
  }

  const meta = claimed.meta || {};
  const counts = countModes(tasks);
  let recipients = [];
  try {
    const rows =
      typeof listAccessRows === "function"
        ? await listAccessRows()
        : await scanAccessRows(ddb, accessTable);
    recipients = activeSuperAdminEmailsFromAccess(rows);
  } catch (err) {
    console.error(
      "TASK_IMPORT_SUMMARY_RECIPIENT_ERROR",
      JSON.stringify({ batchId })
    );
    console.error(err);
    await finalizeSummaryEmail(ddb, tableName, batchId, SUMMARY_FAILED, {
      nowIso,
      error: "RECIPIENT_LOOKUP_FAILED",
      recipientCount: 0,
    });
    return { skipped: false, status: SUMMARY_FAILED, error: "RECIPIENT_LOOKUP_FAILED" };
  }

  if (!recipients.length) {
    console.warn(
      "TASK_IMPORT_SUMMARY_NO_RECIPIENTS",
      JSON.stringify({ batchId })
    );
    await finalizeSummaryEmail(ddb, tableName, batchId, SUMMARY_SKIPPED, {
      nowIso,
      error: "NO_SUPER_ADMIN",
      recipientCount: 0,
    });
    return { skipped: false, status: SUMMARY_SKIPPED, reason: "NO_SUPER_ADMIN" };
  }

  const base = portalBaseUrl();
  const path = importHistoryPath(batchId);
  const portalUrl = base && path ? `${base}${path}` : "";
  const copy = buildSummaryEmail({
    fileName: meta.fileName,
    uploaderName: meta.uploadedByName,
    uploaderEmail: meta.uploadedBy || meta.confirmedBy,
    batchId,
    totalCount: counts.totalCount,
    immediateCount: counts.immediateCount,
    scheduledCount: counts.scheduledCount,
    portalUrl,
  });
  const from = notifyFromAddress();
  const fromName = notifyFromName();
  const mailer = typeof sendEmailFn === "function" ? sendEmailFn : email.sendEmail;

  let sent = 0;
  let failed = 0;
  for (const to of recipients) {
    try {
      const result = await mailer({
        to,
        subject: copy.subject,
        text: copy.text,
        html: copy.html,
        from,
        fromName,
      });
      if (result?.ok && result.messageId) {
        sent += 1;
        console.log(
          "TASK_IMPORT_SUMMARY_EMAIL_SENT",
          JSON.stringify({ batchId, to })
        );
      } else {
        failed += 1;
        console.error(
          "TASK_IMPORT_SUMMARY_EMAIL_FAILED",
          JSON.stringify({
            batchId,
            to,
            error: result?.error || "SEND_FAILED",
          })
        );
      }
    } catch (err) {
      failed += 1;
      console.error(
        "TASK_IMPORT_SUMMARY_EMAIL_FAILED",
        JSON.stringify({ batchId, to, error: err?.name || "SEND_FAILED" })
      );
    }
  }

  const nextStatus = sent > 0 ? SUMMARY_SENT : SUMMARY_FAILED;
  await finalizeSummaryEmail(ddb, tableName, batchId, nextStatus, {
    nowIso,
    error: sent > 0 ? null : "SEND_FAILED",
    recipientCount: recipients.length,
  });
  return {
    skipped: false,
    status: nextStatus,
    sent,
    failed,
    recipients: recipients.length,
  };
}

module.exports = {
  SUMMARY_SENDING,
  SUMMARY_SENT,
  SUMMARY_FAILED,
  SUMMARY_SKIPPED,
  EMAIL_CLAIM_MAX_ATTEMPTS,
  DEFAULT_FROM,
  notifyFromAddress,
  notifyFromName,
  safeFileName,
  escapeHtml,
  countModes,
  buildSummaryEmail,
  importHistoryPath,
  sendCompletedImportSummaryEmail,
  claimSummaryEmail,
  finalizeSummaryEmail,
};

const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { randomUUID } = require("crypto");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
const s3 = new S3Client({ region: process.env.AWS_REGION });

const MAX_BYTES = Number(process.env.DOCUMENT_MAX_BYTES || 10 * 1024 * 1024);
const SIGNED_TTL = Number(process.env.DOCUMENT_URL_TTL_SECONDS || 300);
const REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_TYPES = [
  { code: "AADHAAR", label: "Aadhaar Card", required: true },
  { code: "PAN", label: "PAN Card", required: true },
  { code: "PASSPORT", label: "Passport", required: false },
  { code: "PHOTOGRAPH", label: "Photograph", required: true },
  { code: "RESUME", label: "Resume/CV", required: true },
  { code: "BANK", label: "Bank Document", required: false },
  { code: "ADDRESS", label: "Address Proof", required: false },
  { code: "OTHER", label: "Other Documents", required: false },
];

const ALLOWED_BY_EXT = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const VIEWABLE_EXT = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
const REVIEW_STATUSES = new Set(["VERIFIED", "REJECTED"]);

function extOf(name = "") {
  const i = String(name).lastIndexOf(".");
  return i >= 0 ? String(name).slice(i).toLowerCase() : "";
}

function sanitizeFileName(name) {
  const cleaned = String(name || "document")
    .replace(/[/\\]/g, "")
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 120)
    .trim();
  return cleaned || "document";
}

function validateFile({ fileName, contentType, fileSize }) {
  const ext = extOf(fileName);
  const expected = ALLOWED_BY_EXT[ext];
  if (!expected) {
    return "Invalid file type. Allowed: PDF, JPG, JPEG, PNG, DOC, DOCX, XLS, XLSX.";
  }
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    return "Empty file.";
  }
  if (size > MAX_BYTES) {
    return "File size exceeds the allowed limit.";
  }
  return null;
}

function resolvedContentType(fileName, contentType) {
  const ext = extOf(fileName);
  const expected = ALLOWED_BY_EXT[ext];
  const ct = String(contentType || "").toLowerCase();
  if (ct && ct !== "application/octet-stream") return contentType;
  return expected || "application/octet-stream";
}

function pathOf(event) {
  return String(event.path || event.resource || "").replace(/\/+$/, "");
}

async function getProfile(email) {
  if (!email || !process.env.USER_PROFILE_TABLE) {
    return { employeeId: email?.split("@")[0] || "—", employeeName: email?.split("@")[0] || "Unknown" };
  }
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: { PK: `USER#${String(email).toLowerCase()}`, SK: "PROFILE" },
      })
    );
    const p = res.Item || {};
    return {
      employeeId: p.empId || email.split("@")[0],
      employeeName: p.name || email.split("@")[0],
    };
  } catch {
    return { employeeId: email.split("@")[0], employeeName: email.split("@")[0] };
  }
}

async function writeNotification(email, payload) {
  if (!email) return;
  const now = new Date().toISOString();
  const id = randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: process.env.WORK_TABLE,
      Item: {
        PK: `USER#${email}`,
        SK: `NOTIFY#${now}#${id}`,
        notifyId: id,
        email,
        read: false,
        createdAt: now,
        ...payload,
      },
    })
  );
}

async function logDocActivity({ email, documentId, documentType, action, performedBy, meta }) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: process.env.WORK_TABLE,
      Item: {
        PK: `USER#${email}`,
        SK: `DOCACT#${now}#${id}`,
        activityId: id,
        employeeId: email,
        documentId,
        documentType,
        action,
        timestamp: now,
        performedBy,
        ...(meta || {}),
      },
    })
  );
}

async function listTypes() {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "ENTITY#DOC_TYPE" },
    })
  );
  const overrides = {};
  for (const item of res.Items || []) {
    if (item.code) overrides[item.code] = item;
  }
  return DEFAULT_TYPES.map((t) => ({
    ...t,
    required: overrides[t.code]?.required ?? t.required,
    label: overrides[t.code]?.label || t.label,
  }));
}

async function getCurrentDoc(email, documentType) {
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: { PK: `USER#${email}`, SK: `CURRENT#${documentType}` },
    })
  );
  return res.Item || null;
}

async function getDocById(documentId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: { PK: "ENTITY#DOCUMENT", SK: `DOC#${documentId}` },
    })
  );
  return res.Item || null;
}

async function putDocCopies(item) {
  await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: item }));
  await ddb.send(
    new PutCommand({
      TableName: process.env.WORK_TABLE,
      Item: {
        ...item,
        PK: `USER#${item.email}`,
        SK: `CURRENT#${item.documentId}`,
      },
    })
  );
}

async function listCurrentForEmail(email) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": `USER#${email}`,
        ":sk": "CURRENT#",
      },
    })
  );
  return (res.Items || []).filter((i) => i.isCurrent !== false);
}

async function listAllCurrent() {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": "ENTITY#DOCUMENT",
        ":sk": "DOC#",
      },
    })
  );
  return (res.Items || []).filter((i) => i.isCurrent !== false);
}

function typeLabel(types, code) {
  return types.find((t) => t.code === code)?.label || code;
}

function buildSummary(types, docs) {
  const byType = Object.fromEntries(docs.map((d) => [d.documentType, d]));
  const requiredTypes = types.filter((t) => t.required);
  const required = requiredTypes.length;
  let uploaded = 0;
  let verified = 0;
  let pendingReview = 0;
  let missing = 0;
  let rejected = 0;
  for (const t of requiredTypes) {
    const doc = byType[t.code];
    if (!doc) {
      missing += 1;
      continue;
    }
    uploaded += 1;
    if (doc.status === "VERIFIED") verified += 1;
    else if (doc.status === "REJECTED") rejected += 1;
    else pendingReview += 1;
  }
  const completed = verified;
  const pct = required === 0 ? 100 : Math.round((completed / required) * 100);
  return {
    required,
    uploaded,
    verified,
    pendingReview,
    missing,
    rejected,
    optional: types.filter((t) => !t.required).length,
    percent: pct,
  };
}

function publicDoc(item) {
  if (!item) return null;
  return {
    documentId: item.documentId,
    employeeId: item.employeeId,
    email: item.email,
    employeeName: item.employeeName,
    documentType: item.documentType,
    fileName: item.fileName,
    fileSize: item.fileSize,
    fileType: item.fileType,
    status: item.status,
    description: item.description || "",
    documentDate: item.documentDate || (item.uploadedAt || "").slice(0, 10),
    uploadedAt: item.uploadedAt,
    updatedAt: item.updatedAt,
    verifiedAt: item.verifiedAt || null,
    verifiedBy: item.verifiedBy || null,
    rejectionReason: item.rejectionReason || "",
    version: item.version || 1,
    viewable: VIEWABLE_EXT.has(extOf(item.fileName)),
  };
}

async function maybeRemindMissing(email, types, docs) {
  const byType = Object.fromEntries(docs.map((d) => [d.documentType, d]));
  const { dispatchNotification } = require("../common/notify");
  for (const t of types.filter((x) => x.required)) {
    const doc = byType[t.code];
    const missing = !doc;
    const rejected = String(doc?.status || "").toUpperCase() === "REJECTED";
    if (!missing && !rejected) continue;
    const note = rejected ? "rejected — please re-upload" : "not uploaded";
    try {
      await dispatchNotification(ddb, {
        email,
        type: "DOCUMENT_MISSING",
        title: "Document required",
        subject: "Action required: please upload your documents",
        message: `Please upload your ${t.label} document in the DGV Portal Documents page (${note}).`,
        reason: `Required document pending: ${t.label}`,
        dedupKey: t.code,
        cooldownMs: REMINDER_MS,
        extra: { documentType: t.code },
      });
    } catch (err) {
      console.error("Document reminder error:", err?.name || err);
    }
  }
}

function canAccessDoc(user, doc) {
  if (!doc) return false;
  if (user.isAdmin) return true;
  return String(doc.email || "").toLowerCase() === user.email;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  if (!user.email) return json(401, { error: "Unauthorized" });

  const method = event.httpMethod;
  const path = pathOf(event);
  const qs = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    if (path.endsWith("/documents/types") && method === "GET") {
      return json(200, { types: await listTypes(), maxBytes: MAX_BYTES });
    }

    if (path.endsWith("/documents/types") && method === "PUT") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const incoming = Array.isArray(body.types) ? body.types : [];
      for (const row of incoming) {
        const code = String(row.code || "").toUpperCase();
        if (!DEFAULT_TYPES.some((t) => t.code === code)) continue;
        await ddb.send(
          new PutCommand({
            TableName: process.env.WORK_TABLE,
            Item: {
              PK: "ENTITY#DOC_TYPE",
              SK: `TYPE#${code}`,
              code,
              required: Boolean(row.required),
              label: row.label || DEFAULT_TYPES.find((t) => t.code === code).label,
              updatedAt: new Date().toISOString(),
              updatedBy: user.email,
            },
          })
        );
      }
      return json(200, { types: await listTypes() });
    }

    if (path.endsWith("/documents/upload-url") && method === "POST") {
      const documentType = String(body.documentType || "").toUpperCase();
      const types = await listTypes();
      if (!types.some((t) => t.code === documentType)) {
        return json(400, { error: "Invalid document type." });
      }
      const fileName = sanitizeFileName(body.fileName);
      const fileSize = Number(body.fileSize);
      const contentType = resolvedContentType(fileName, body.contentType);
      const error = validateFile({ fileName, contentType, fileSize });
      if (error) return json(400, { error });
      const bucket = process.env.DOCUMENTS_BUCKET;
      if (!bucket) return json(500, { error: "Documents bucket not configured" });
      const documentId = randomUUID();
      const s3Key = `documents/${user.email}/${documentType}/${documentId}/${fileName}`;
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: bucket,
          Key: s3Key,
          ContentType: contentType,
        }),
        { expiresIn: SIGNED_TTL }
      );
      return json(200, {
        uploadUrl,
        s3Key,
        documentId,
        fileName,
        contentType,
        maxBytes: MAX_BYTES,
      });
    }

    if (path.endsWith("/documents/view-url") && method === "POST") {
      const documentId = body.documentId;
      if (!documentId) return json(400, { error: "documentId required" });
      const doc = await getDocById(documentId);
      if (!doc) return json(404, { error: "Not found" });
      if (!canAccessDoc(user, doc)) return json(403, { error: "Forbidden" });
      const bucket = process.env.DOCUMENTS_BUCKET;
      if (!bucket || !doc.storageKey) {
        return json(500, { error: "Document storage not configured" });
      }
      const inline = body.disposition !== "attachment" && VIEWABLE_EXT.has(extOf(doc.fileName));
      const downloadUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: doc.storageKey,
          ResponseContentDisposition: `${inline ? "inline" : "attachment"}; filename="${sanitizeFileName(doc.fileName)}"`,
          ResponseContentType: doc.fileType || undefined,
        }),
        { expiresIn: SIGNED_TTL }
      );
      await logDocActivity({
        email: doc.email,
        documentId: doc.documentId,
        documentType: doc.documentType,
        action: "document_viewed",
        performedBy: user.email,
      });
      return json(200, { downloadUrl, fileName: doc.fileName, viewable: inline });
    }

    if (path.endsWith("/documents") && method === "POST") {
      const documentType = String(body.documentType || "").toUpperCase();
      const types = await listTypes();
      if (!types.some((t) => t.code === documentType)) {
        return json(400, { error: "Invalid document type." });
      }
      const fileName = sanitizeFileName(body.fileName);
      const fileSize = Number(body.fileSize);
      const contentType = resolvedContentType(fileName, body.contentType);
      const error = validateFile({ fileName, contentType, fileSize });
      if (error) return json(400, { error });
      const s3Key = String(body.s3Key || "");
      const prefix = `documents/${user.email}/${documentType}/`;
      if (!s3Key.startsWith(prefix)) {
        return json(400, { error: "Invalid storage key." });
      }
      const profile = await getProfile(user.email);
      const now = new Date().toISOString();
      const documentId = body.documentId || randomUUID();
      const documentDate = String(body.documentDate || now.slice(0, 10)).slice(0, 10);

      const item = {
        PK: "ENTITY#DOCUMENT",
        SK: `DOC#${documentId}`,
        documentId,
        email: user.email,
        employeeId: profile.employeeId,
        employeeName: profile.employeeName,
        documentType,
        fileName,
        fileSize,
        fileType: contentType,
        storageKey: s3Key,
        status: "UNDER_REVIEW",
        description: String(body.description || "").trim().slice(0, 500),
        documentDate,
        uploadedAt: now,
        updatedAt: now,
        verifiedAt: null,
        verifiedBy: null,
        rejectionReason: "",
        version: 1,
        isCurrent: true,
      };
      await putDocCopies(item);
      await logDocActivity({
        email: user.email,
        documentId,
        documentType,
        action: "document_uploaded",
        performedBy: user.email,
        meta: { fileName, documentDate },
      });
      return json(201, publicDoc(item));
    }

    if (path.endsWith("/documents") && method === "PUT") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const documentId = body.documentId;
      const next = String(body.status || "").toUpperCase();
      if (!documentId || !REVIEW_STATUSES.has(next)) {
        return json(400, { error: "documentId and status VERIFIED or REJECTED required" });
      }
      if (next === "REJECTED" && !String(body.rejectionReason || "").trim()) {
        return json(400, { error: "Rejection reason is required." });
      }
      const item = await getDocById(documentId);
      if (!item || item.isCurrent === false) return json(404, { error: "Not found" });
      const now = new Date().toISOString();
      const types = await listTypes();
      const label = typeLabel(types, item.documentType);
      const updated = {
        ...item,
        status: next,
        updatedAt: now,
        verifiedAt: next === "VERIFIED" ? now : null,
        verifiedBy: user.email,
        rejectionReason:
          next === "REJECTED" ? String(body.rejectionReason || "").trim() : "",
      };
      await putDocCopies(updated);
      await logDocActivity({
        email: item.email,
        documentId,
        documentType: item.documentType,
        action: next === "VERIFIED" ? "document_verified" : "document_rejected",
        performedBy: user.email,
        meta: { rejectionReason: updated.rejectionReason },
      });
      if (next === "VERIFIED") {
        await writeNotification(item.email, {
          type: "DOCUMENT_VERIFIED",
          title: "Document verified",
          message: `Your ${label} has been verified successfully.`,
          documentId,
          documentType: item.documentType,
        });
      } else {
        await writeNotification(item.email, {
          type: "DOCUMENT_REJECTED",
          title: "Document rejected",
          message: `Your ${label} document was rejected. Reason: ${updated.rejectionReason}`,
          documentId,
          documentType: item.documentType,
        });
      }
      return json(200, publicDoc(updated));
    }

    if (path.endsWith("/documents") && method === "GET") {
      const types = await listTypes();
      if (qs.history === "true") {
        const documentType = String(qs.documentType || "").toUpperCase();
        const email = user.isAdmin && qs.email ? String(qs.email).toLowerCase() : user.email;
        if (!user.isAdmin && email !== user.email) return json(403, { error: "Forbidden" });
        const res = await ddb.send(
          new QueryCommand({
            TableName: process.env.WORK_TABLE,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues: {
              ":pk": `USER#${email}`,
              ":sk": `VER#${documentType}#`,
            },
          })
        );
        const current = await getCurrentDoc(email, documentType);
        return json(200, {
          current: publicDoc(current),
          previous: (res.Items || [])
            .sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")))
            .map(publicDoc),
        });
      }

      if (user.isAdmin && (qs.all === "true" || path.includes("/admin/documents"))) {
        const items = (await listAllCurrent()).map(publicDoc);
        items.sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")));
        return json(200, { types, documents: items, maxBytes: MAX_BYTES });
      }

      if (user.isAdmin && qs.email) {
        const email = String(qs.email).toLowerCase();
        const docs = await listCurrentForEmail(email);
        const summary = buildSummary(types, docs);
        return json(200, {
          types,
          documents: docs.map(publicDoc),
          summary,
          maxBytes: MAX_BYTES,
          email,
        });
      }

      const docs = await listCurrentForEmail(user.email);
      await maybeRemindMissing(user.email, types, docs);
      const summary = buildSummary(types, docs);
      return json(200, {
        types,
        documents: docs.map(publicDoc),
        summary,
        maxBytes: MAX_BYTES,
      });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Documents error:", err);
    return json(500, { error: "Internal server error" });
  }
};

import { createRequire } from "module";
import { randomUUID } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

const require = createRequire(import.meta.url);
const { getUser } = require("../common/auth");
const { json } = require("../common/response");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

function toPublic(item) {
  if (!item) return null;
  const email = String(item.email || "")
    .replace(/^USER#/i, "")
    .trim()
    .toLowerCase();
  const resignationId =
    item.resignationId ||
    String(item.SK || "").replace(/^RESIGNATION#/i, "") ||
    null;
  return {
    resignationId,
    email: email || null,
    name: item.name || null,
    lastWorkingDay: item.lastWorkingDay || null,
    reason: item.reason || null,
    status: item.status || "SUBMITTED",
    createdAt: item.createdAt || null,
    reviewedAt: item.reviewedAt || null,
    reviewedBy: item.reviewedBy || null,
  };
}

async function getProfileName(email) {
  const table = process.env.USER_PROFILE_TABLE;
  if (!table || !email) return "";
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: table,
        Key: { PK: `USER#${email}`, SK: "PROFILE" },
      })
    );
    return res.Item?.name || "";
  } catch {
    return "";
  }
}

async function listByEmail(email) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.RESIGNATIONS_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": `USER#${email}`,
        ":sk": "RESIGNATION#",
      },
    })
  );
  return (res.Items || [])
    .map(toPublic)
    .filter(Boolean)
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
}

async function listAll() {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: process.env.RESIGNATIONS_TABLE,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items
    .map(toPublic)
    .filter(Boolean)
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
}

async function findResignation(resignationId, emailHint) {
  const id = String(resignationId || "").trim();
  if (!id) return null;
  const emails = [];
  if (emailHint) emails.push(String(emailHint).toLowerCase());
  for (const email of emails) {
    const direct = await ddb.send(
      new GetCommand({
        TableName: process.env.RESIGNATIONS_TABLE,
        Key: { PK: `USER#${email}`, SK: `RESIGNATION#${id}` },
      })
    );
    if (direct.Item) return direct.Item;
  }
  const all = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: process.env.RESIGNATIONS_TABLE,
        ExclusiveStartKey: lastKey,
      })
    );
    all.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return (
    all.find(
      (item) =>
        item.resignationId === id ||
        String(item.SK || "") === `RESIGNATION#${id}`
    ) || null
  );
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  try {
    const user = getUser(event);
    if (!user.email) {
      return json(401, { error: "Unauthorized" });
    }

    const method = event.httpMethod;
    const qs = event.queryStringParameters || {};

    if (method === "GET") {
      if (user.isAdmin && qs.all === "true") {
        return json(200, await listAll());
      }
      return json(200, await listByEmail(user.email));
    }

    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      const lastWorkingDay = String(body.lastWorkingDay || "").trim();
      const reason = String(body.reason || "").trim();
      if (!lastWorkingDay || !reason) {
        return json(400, { error: "lastWorkingDay and reason are required" });
      }

      const resignationId = randomUUID();
      const nowIso = new Date().toISOString();
      const name = await getProfileName(user.email);
      const item = {
        PK: `USER#${user.email}`,
        SK: `RESIGNATION#${resignationId}`,
        resignationId,
        email: user.email,
        name: name || user.email.split("@")[0],
        lastWorkingDay,
        reason,
        status: "SUBMITTED",
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      await ddb.send(
        new PutCommand({
          TableName: process.env.RESIGNATIONS_TABLE,
          Item: item,
        })
      );

      return json(200, {
        message: "Resignation submitted successfully",
        resignation: toPublic(item),
      });
    }

    if (method === "PUT") {
      if (!user.isAdmin) {
        return json(403, { error: "Admin access required" });
      }
      const body = JSON.parse(event.body || "{}");
      const resignationId = String(body.resignationId || "").trim();
      const rawStatus = String(body.status || body.action || "")
        .trim()
        .toUpperCase();
      const nextStatus =
        rawStatus === "APPROVE" || rawStatus === "APPROVED"
          ? "APPROVED"
          : rawStatus === "REJECT" || rawStatus === "REJECTED"
            ? "REJECTED"
            : "";
      if (!resignationId) {
        return json(400, { error: "resignationId is required" });
      }
      if (nextStatus !== "APPROVED" && nextStatus !== "REJECTED") {
        return json(400, { error: "status must be APPROVED or REJECTED" });
      }

      const existing = await findResignation(resignationId, body.email);
      if (!existing) {
        return json(404, { error: "Resignation not found" });
      }
      const current = String(existing.status || "SUBMITTED").toUpperCase();
      if (current !== "SUBMITTED" && current !== "PENDING") {
        return json(400, { error: "Resignation already reviewed" });
      }

      const nowIso = new Date().toISOString();
      await ddb.send(
        new UpdateCommand({
          TableName: process.env.RESIGNATIONS_TABLE,
          Key: { PK: existing.PK, SK: existing.SK },
          UpdateExpression:
            "SET #status = :status, reviewedAt = :reviewedAt, reviewedBy = :reviewedBy, updatedAt = :updatedAt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": nextStatus,
            ":reviewedAt": nowIso,
            ":reviewedBy": user.email,
            ":updatedAt": nowIso,
          },
        })
      );

      return json(200, {
        message: `Resignation ${nextStatus.toLowerCase()}`,
        resignation: toPublic({
          ...existing,
          status: nextStatus,
          reviewedAt: nowIso,
          reviewedBy: user.email,
        }),
      });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Resignation error:", err);
    return json(500, { error: err.message || "Failed to process resignation" });
  }
};

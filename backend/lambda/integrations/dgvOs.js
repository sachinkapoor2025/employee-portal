/**
 * Server-to-server integration for DGV AI Business OS.
 * Auth: x-dgv-os-key (NOT Cognito). Never expose this key to browsers.
 *
 * Allowed: read employees/tasks/capacity; create/update human tasks with dgvTaskId.
 * Forbidden: attendance mutation, payroll, employee record writes, payments.
 */

const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID, timingSafeEqual } = require("crypto");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

function authorized(event) {
  const expected = process.env.DGV_OS_API_KEY || "";
  const provided =
    event.headers?.["x-dgv-os-key"] ||
    event.headers?.["X-Dgv-Os-Key"] ||
    "";
  if (!expected || !provided) return false;
  try {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function idempotencyKey(event, body) {
  return (
    event.headers?.["idempotency-key"] ||
    event.headers?.["Idempotency-Key"] ||
    body?.idempotencyKey ||
    null
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");
  if (!authorized(event)) return json(401, { error: "Unauthorized" });

  const path = event.path || event.resource || "";
  const method = event.httpMethod;
  const body = event.body ? JSON.parse(event.body) : {};
  const workTable = process.env.WORK_TABLE;
  const usersTable = process.env.USERS_TABLE;
  const profileTable = process.env.USER_PROFILE_TABLE || usersTable;

  try {
    if (path.endsWith("/integrations/dgv-os/health") && method === "GET") {
      return json(200, { ok: true, service: "mydgv-dgv-os" });
    }

    if (path.endsWith("/integrations/dgv-os/employees") && method === "GET") {
      // Prefer profiles under USER#* ; fall back to empty if scan restricted
      let employees = [];
      try {
        const res = await ddb.send(
          new ScanCommand({
            TableName: profileTable,
            Limit: 200,
          })
        );
        employees = (res.Items || [])
          .filter((i) => i.email || (i.SK && String(i.SK).includes("PROFILE")))
          .map((i) => ({
            email: i.email || String(i.PK || "").replace(/^USER#/, "") || "",
            name: i.name || i.fullName || "",
            department: i.department || "",
            designation: i.designation || "",
            skills: i.skills || [],
            role: i.role || "",
            active: i.active !== false && i.status !== "disabled",
          }))
          .filter((e) => e.email);
      } catch (err) {
        console.error("employees scan", err);
      }
      return json(200, { employees });
    }

    if (path.endsWith("/integrations/dgv-os/capacity") && method === "GET") {
      const tasksRes = await ddb.send(
        new QueryCommand({
          TableName: workTable,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
        })
      );
      const open = (tasksRes.Items || []).filter(
        (t) => t.status && !["DONE", "CANCELLED"].includes(t.status)
      );
      const byEmail = {};
      for (const t of open) {
        const email = t.assignee || "unassigned";
        byEmail[email] = (byEmail[email] || 0) + 1;
      }
      const employees = Object.entries(byEmail).map(([email, openTasks]) => {
        let status = "balanced";
        if (openTasks <= 2) status = "underutilized";
        if (openTasks >= 8) status = "overloaded";
        return { email, openTasks, status };
      });
      return json(200, { employees });
    }

    if (path.endsWith("/integrations/dgv-os/tasks") && method === "GET") {
      const { assignee } = event.queryStringParameters || {};
      const res = await ddb.send(
        new QueryCommand({
          TableName: workTable,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
        })
      );
      let tasks = res.Items || [];
      if (assignee) tasks = tasks.filter((t) => t.assignee === assignee);
      return json(200, { tasks });
    }

    if (path.endsWith("/integrations/dgv-os/tasks") && method === "POST") {
      const key = idempotencyKey(event, body);
      if (!key) return json(400, { error: "Idempotency-Key required" });
      if (!body.title || !body.projectId) {
        return json(400, { error: "title and projectId required" });
      }

      // Idempotent replay
      const existingIdem = await ddb.send(
        new GetCommand({
          TableName: workTable,
          Key: { PK: "ENTITY#DGV_IDEMPOTENCY", SK: `KEY#${key}` },
        })
      );
      if (existingIdem.Item?.taskId) {
        const existingTask = await ddb.send(
          new GetCommand({
            TableName: workTable,
            Key: {
              PK: "ENTITY#TASK",
              SK: `TASK#${existingIdem.Item.taskId}`,
            },
          })
        );
        return json(200, existingTask.Item || { taskId: existingIdem.Item.taskId });
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const item = {
        PK: "ENTITY#TASK",
        SK: `TASK#${id}`,
        taskId: id,
        projectId: body.projectId,
        title: body.title,
        description: body.description || "",
        assignee: body.assignee || "",
        priority: body.priority || "MEDIUM",
        status: body.status || "TODO",
        dueDate: body.dueDate || null,
        eta: body.eta || null,
        blockers: body.blockers || [],
        dgvTaskId: body.dgvTaskId || null,
        source: "DGV_AI_OS",
        labels: Array.isArray(body.labels)
          ? [...body.labels, "ai-os"]
          : ["ai-os"],
        createdAt: now,
        createdBy: "dgv-ai-os",
        updatedAt: now,
      };

      await ddb.send(new PutCommand({ TableName: workTable, Item: item }));
      await ddb.send(
        new PutCommand({
          TableName: workTable,
          Item: { ...item, PK: `PROJECT#${body.projectId}`, SK: `TASK#${id}` },
        })
      );
      await ddb.send(
        new PutCommand({
          TableName: workTable,
          Item: {
            PK: "ENTITY#DGV_IDEMPOTENCY",
            SK: `KEY#${key}`,
            taskId: id,
            createdAt: now,
          },
        })
      );

      return json(201, item);
    }

    const patchMatch = path.match(/\/integrations\/dgv-os\/tasks\/([^/]+)$/);
    if (patchMatch && method === "PATCH") {
      const taskId = decodeURIComponent(patchMatch[1]);
      const existing = await ddb.send(
        new GetCommand({
          TableName: workTable,
          Key: { PK: "ENTITY#TASK", SK: `TASK#${taskId}` },
        })
      );
      if (!existing.Item) return json(404, { error: "Task not found" });

      const allowed = {};
      for (const k of [
        "status",
        "assignee",
        "dueDate",
        "eta",
        "blockers",
        "description",
        "priority",
      ]) {
        if (body[k] !== undefined) allowed[k] = body[k];
      }
      const merged = {
        ...existing.Item,
        ...allowed,
        updatedAt: new Date().toISOString(),
        updatedBy: "dgv-ai-os",
      };
      await ddb.send(new PutCommand({ TableName: workTable, Item: merged }));
      if (merged.projectId) {
        await ddb.send(
          new PutCommand({
            TableName: workTable,
            Item: {
              ...merged,
              PK: `PROJECT#${merged.projectId}`,
              SK: `TASK#${taskId}`,
            },
          })
        );
      }
      return json(200, merged);
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("dgvOs integration error", err);
    return json(500, { error: "Internal server error" });
  }
};

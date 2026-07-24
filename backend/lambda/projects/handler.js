const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

const STATUSES = ["BACKLOG", "TODO", "IN_PROGRESS", "REVIEW", "DONE"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  const path = event.path || "";
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // ── PROJECTS ──
    if (path.endsWith("/projects") && event.httpMethod === "GET") {
      const res = await ddb.send(
        new QueryCommand({
          TableName: process.env.WORK_TABLE,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "ENTITY#PROJECT" },
        })
      );
      return json(200, res.Items || []);
    }

    if (path.endsWith("/projects") && event.httpMethod === "POST") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const id = randomUUID();
      const item = {
        PK: "ENTITY#PROJECT",
        SK: `PROJECT#${id}`,
        projectId: id,
        name: body.name,
        client: body.client || "",
        lead: body.lead || user.email,
        members: body.members || [],
        status: body.status || "ACTIVE",
        description: body.description || "",
        createdAt: new Date().toISOString(),
        createdBy: user.email,
      };
      await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: item }));
      return json(201, item);
    }

    // ── TASKS ──
    if (path.endsWith("/tasks") && event.httpMethod === "GET") {
      const { projectId, assignee, mine } = event.queryStringParameters || {};
      let items = [];

      if (projectId) {
        const res = await ddb.send(
          new QueryCommand({
            TableName: process.env.WORK_TABLE,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues: {
              ":pk": `PROJECT#${projectId}`,
              ":sk": "TASK#",
            },
          })
        );
        items = res.Items || [];
      } else {
        const res = await ddb.send(
          new QueryCommand({
            TableName: process.env.WORK_TABLE,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": "ENTITY#TASK" },
          })
        );
        items = res.Items || [];
      }

      if (mine === "true" || assignee) {
        const email = assignee || user.email;
        items = items.filter((t) => t.assignee === email);
      }

      return json(200, items);
    }

    if (path.endsWith("/tasks") && event.httpMethod === "POST") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const id = randomUUID();
      const projectId = body.projectId;
      if (!projectId || !body.title) {
        return json(400, { error: "projectId and title required" });
      }

      const item = {
        PK: "ENTITY#TASK",
        SK: `TASK#${id}`,
        taskId: id,
        projectId,
        title: body.title,
        description: body.description || "",
        assignee: body.assignee || "",
        priority: body.priority || "MEDIUM",
        status: body.status || "TODO",
        dueDate: body.dueDate || null,
        labels: body.labels || [],
        createdAt: new Date().toISOString(),
        createdBy: user.email,
        updatedAt: new Date().toISOString(),
      };

      await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: item }));
      await ddb.send(
        new PutCommand({
          TableName: process.env.WORK_TABLE,
          Item: { ...item, PK: `PROJECT#${projectId}`, SK: `TASK#${id}` },
        })
      );

      return json(201, item);
    }

    if (path.endsWith("/tasks") && event.httpMethod === "PUT") {
      const { taskId, projectId, ...updates } = body;
      if (!taskId) return json(400, { error: "taskId required" });

      const existing = await ddb.send(
        new GetCommand({
          TableName: process.env.WORK_TABLE,
          Key: { PK: "ENTITY#TASK", SK: `TASK#${taskId}` },
        })
      );

      if (!existing.Item) return json(404, { error: "Task not found" });

      const isAssignee = existing.Item.assignee === user.email;
      if (!user.isAdmin && !isAssignee) return json(403, { error: "Forbidden" });

      const allowed = user.isAdmin
        ? updates
        : { status: updates.status };

      const merged = {
        ...existing.Item,
        ...allowed,
        updatedAt: new Date().toISOString(),
      };

      await ddb.send(
        new PutCommand({ TableName: process.env.WORK_TABLE, Item: merged })
      );

      const pid = projectId || existing.Item.projectId;
      if (pid) {
        await ddb.send(
          new PutCommand({
            TableName: process.env.WORK_TABLE,
            Item: { ...merged, PK: `PROJECT#${pid}`, SK: `TASK#${taskId}` },
          })
        );
      }

      return json(200, merged);
    }

    // ── TIME ENTRIES ──
    if (path.endsWith("/time-entries") && event.httpMethod === "POST") {
      if (!user.email) return json(401, { error: "Unauthorized" });
      const { taskId, minutes, note, projectId } = body;
      if (!taskId || !minutes) return json(400, { error: "taskId and minutes required" });

      const id = randomUUID();
      const now = new Date().toISOString();
      const item = {
        PK: `USER#${user.email}`,
        SK: `TIME#${now}#${id}`,
        timeId: id,
        taskId,
        projectId: projectId || null,
        email: user.email,
        minutes: Number(minutes),
        note: note || "",
        date: now.slice(0, 10),
        createdAt: now,
      };

      await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: item }));
      return json(201, item);
    }

    if (path.endsWith("/time-entries") && event.httpMethod === "GET") {
      const email = user.isAdmin && event.queryStringParameters?.email
        ? event.queryStringParameters.email
        : user.email;

      const res = await ddb.send(
        new QueryCommand({
          TableName: process.env.WORK_TABLE,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: {
            ":pk": `USER#${email}`,
            ":sk": "TIME#",
          },
          ScanIndexForward: false,
        })
      );

      return json(200, res.Items || []);
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Projects error:", err);
    return json(500, { error: "Internal server error" });
  }
};

exports.STATUSES = STATUSES;

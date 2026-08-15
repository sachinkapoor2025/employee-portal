const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
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

const STATUSES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "REVIEW",
  "DONE",
  "CANCELLED",
];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const DURATION_TYPES = ["HOURS", "DAYS", "DATES"];

function parseDuration(body = {}) {
  const type = String(body.durationType || "").toUpperCase();
  if (!DURATION_TYPES.includes(type)) {
    return {
      durationType: null,
      durationHours: null,
      durationDays: null,
      durationStart: null,
      durationEnd: null,
    };
  }
  if (type === "HOURS") {
    const n = Number(body.durationHours);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        durationType: null,
        durationHours: null,
        durationDays: null,
        durationStart: null,
        durationEnd: null,
      };
    }
    return {
      durationType: "HOURS",
      durationHours: n,
      durationDays: null,
      durationStart: null,
      durationEnd: null,
    };
  }
  if (type === "DAYS") {
    const n = Number(body.durationDays);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        durationType: null,
        durationHours: null,
        durationDays: null,
        durationStart: null,
        durationEnd: null,
      };
    }
    return {
      durationType: "DAYS",
      durationHours: null,
      durationDays: n,
      durationStart: null,
      durationEnd: null,
    };
  }
  const start = body.durationStart || null;
  const end = body.durationEnd || null;
  if (!start && !end) {
    return {
      durationType: null,
      durationHours: null,
      durationDays: null,
      durationStart: null,
      durationEnd: null,
    };
  }
  return {
    durationType: "DATES",
    durationHours: null,
    durationDays: null,
    durationStart: start,
    durationEnd: end,
  };
}

function taskPathMatch(path) {
  // /tasks/{taskId} or /prod/tasks/{taskId}
  const m = String(path).match(/\/tasks\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) return null;
  return { taskId: decodeURIComponent(m[1]), sub: m[2] || null };
}

function isOverdue(task) {
  if (!task?.dueDate) return false;
  const status = String(task.status || "").toUpperCase();
  // Do not overwrite DONE/CANCELLED; overdue is a display flag only.
  if (status === "DONE" || status === "CANCELLED") return false;
  const raw = String(task.dueDate);
  const due = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T23:59:59`)
    : new Date(raw);
  if (!Number.isFinite(due.getTime())) return false;
  return Date.now() > due.getTime();
}

async function getTask(taskId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: { PK: "ENTITY#TASK", SK: `TASK#${taskId}` },
    })
  );
  return res.Item || null;
}

async function putTaskCopies(task) {
  await ddb.send(
    new PutCommand({ TableName: process.env.WORK_TABLE, Item: task })
  );
  if (task.projectId) {
    await ddb.send(
      new PutCommand({
        TableName: process.env.WORK_TABLE,
        Item: {
          ...task,
          PK: `PROJECT#${task.projectId}`,
          SK: `TASK#${task.taskId}`,
        },
      })
    );
  }
}

async function appendActivity(taskId, action, detail, actorEmail) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const item = {
    PK: `TASK#${taskId}`,
    SK: `ACTIVITY#${now}#${id}`,
    activityId: id,
    taskId,
    action,
    detail: detail || "",
    actorEmail: actorEmail || "",
    timestamp: now,
  };
  await ddb.send(
    new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
  );
  return item;
}

async function getProjectName(projectId) {
  if (!projectId) return "";
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: { PK: "ENTITY#PROJECT", SK: `PROJECT#${projectId}` },
    })
  );
  return res.Item?.name || "";
}

async function getAssigneeProfile(email) {
  if (!email || !process.env.USER_PROFILE_TABLE) {
    return {
      email: email || "",
      name: "",
      empId: "",
      department: "",
      designation: "",
    };
  }
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: {
          PK: `USER#${String(email).toLowerCase()}`,
          SK: "PROFILE",
        },
      })
    );
    const p = res.Item || {};
    return {
      email: email,
      name: p.name || "",
      empId: p.empId || "",
      department: p.department || "",
      designation: p.designation || "",
    };
  } catch {
    return {
      email,
      name: "",
      empId: "",
      department: "",
      designation: "",
    };
  }
}

async function listByPrefix(pk, prefix) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": pk, ":sk": prefix },
      ScanIndexForward: false,
    })
  );
  return res.Items || [];
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  const path = event.path || "";
  const method = event.httpMethod;
  const body = event.body ? JSON.parse(event.body) : {};
  const taskRoute = taskPathMatch(path);

  try {
    // ── TASK BY ID / COMMENTS / ACTIVITY / ATTACHMENTS ──
    if (taskRoute) {
      const { taskId, sub } = taskRoute;
      const task = await getTask(taskId);

      if (sub === "attachment-download-url" && method === "POST") {
        const { s3Key, attachmentId } = body;
        let key = s3Key;
        if (!key && attachmentId && task) {
          const att = await ddb.send(
            new GetCommand({
              TableName: process.env.WORK_TABLE,
              Key: {
                PK: `TASK#${taskId}`,
                SK: `ATTACHMENT#${attachmentId}`,
              },
            })
          );
          key = att.Item?.s3Key;
        }
        if (!key) return json(400, { error: "s3Key or attachmentId required" });
        const objectKey = String(key).replace(/^\/+/, "");
        if (!objectKey || objectKey.includes("..")) {
          return json(400, { error: "Invalid s3Key" });
        }
        const email = String(user.email || "").toLowerCase();
        const ownPrefix = email ? `profiles/${email}/` : "";
        const taskPrefix = taskId ? `tasks/${taskId}/` : "";
        const allowed =
          user.isAdmin ||
          (task && task.assignee === user.email) ||
          (ownPrefix && objectKey.startsWith(ownPrefix)) ||
          (taskPrefix && objectKey.startsWith(taskPrefix));
        if (!allowed) return json(403, { error: "Forbidden" });
        const bucket = process.env.TASK_ATTACHMENTS_BUCKET;
        if (!bucket) {
          return json(500, { error: "Attachments bucket not configured" });
        }
        const downloadUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
          { expiresIn: 300 }
        );
        return json(200, { downloadUrl });
      }

      if (!sub && method === "GET") {
        if (!task) return json(404, { error: "Task not found" });
        const isAssignee = task.assignee === user.email;
        if (!user.isAdmin && !isAssignee) {
          return json(403, { error: "Forbidden" });
        }

        const [projectName, assignee] = await Promise.all([
          getProjectName(task.projectId),
          getAssigneeProfile(task.assignee),
        ]);

        return json(200, {
          ...task,
          projectName,
          assigneeProfile: assignee,
          overdue: isOverdue(task),
          displayStatus: isOverdue(task) ? "OVERDUE" : task.status,
        });
      }

      if (!task) return json(404, { error: "Task not found" });
      const canAccess =
        user.isAdmin || task.assignee === user.email;
      if (!canAccess) return json(403, { error: "Forbidden" });

      // Comments
      if (sub === "comments" && method === "GET") {
        const items = await listByPrefix(`TASK#${taskId}`, "COMMENT#");
        return json(200, items);
      }

      if (sub === "comments" && method === "POST") {
        const text = String(body.text || body.comment || "").trim();
        if (!text) return json(400, { error: "Comment text required" });
        const now = new Date().toISOString();
        const id = randomUUID();
        const item = {
          PK: `TASK#${taskId}`,
          SK: `COMMENT#${now}#${id}`,
          commentId: id,
          taskId,
          text,
          authorEmail: user.email,
          authorName: body.authorName || user.email.split("@")[0],
          createdAt: now,
        };
        await ddb.send(
          new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
        );
        await appendActivity(
          taskId,
          "comment_added",
          "Comment added",
          user.email
        );
        return json(201, item);
      }

      // Activity
      if (sub === "activity" && method === "GET") {
        const items = await listByPrefix(`TASK#${taskId}`, "ACTIVITY#");
        return json(200, items);
      }

      // Attachments
      if (sub === "attachments" && method === "GET") {
        const items = await listByPrefix(`TASK#${taskId}`, "ATTACHMENT#");
        return json(200, items);
      }

      if (sub === "attachment-upload-url" && method === "POST") {
        if (!user.isAdmin && task.assignee !== user.email) {
          return json(403, { error: "Forbidden" });
        }
        const fileName = body.fileName;
        const contentType = body.contentType || "application/octet-stream";
        if (!fileName) return json(400, { error: "fileName required" });
        const bucket = process.env.TASK_ATTACHMENTS_BUCKET;
        if (!bucket) {
          return json(500, { error: "Attachments bucket not configured" });
        }
        const key = `tasks/${taskId}/${Date.now()}-${fileName}`;
        const uploadUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: contentType,
          }),
          { expiresIn: 300 }
        );
        return json(200, { uploadUrl, s3Key: key, fileName, contentType });
      }

      if (sub === "attachments" && method === "POST") {
        if (!user.isAdmin && task.assignee !== user.email) {
          return json(403, { error: "Forbidden" });
        }
        const { fileName, contentType, s3Key } = body;
        if (!fileName || !s3Key) {
          return json(400, { error: "fileName and s3Key required" });
        }
        const now = new Date().toISOString();
        const id = randomUUID();
        const item = {
          PK: `TASK#${taskId}`,
          SK: `ATTACHMENT#${id}`,
          attachmentId: id,
          taskId,
          fileName,
          contentType: contentType || "application/octet-stream",
          s3Key,
          uploadedBy: user.email,
          uploadedAt: now,
        };
        await ddb.send(
          new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
        );
        await appendActivity(
          taskId,
          "attachment_uploaded",
          `Uploaded ${fileName}`,
          user.email
        );
        return json(201, item);
      }

      return json(405, { error: "Method not allowed" });
    }

    // ── PROJECTS ──
    if (path.endsWith("/projects") && method === "GET") {
      const res = await ddb.send(
        new QueryCommand({
          TableName: process.env.WORK_TABLE,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "ENTITY#PROJECT" },
        })
      );
      return json(200, res.Items || []);
    }

    if (path.endsWith("/projects") && method === "POST") {
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
      await ddb.send(
        new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
      );
      return json(201, item);
    }

    // ── TASKS LIST / CREATE / UPDATE ──
    if (path.endsWith("/tasks") && method === "GET") {
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

      items = items.map((t) => ({
        ...t,
        overdue: isOverdue(t),
      }));

      return json(200, items);
    }

    if (path.endsWith("/tasks") && method === "POST") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const id = randomUUID();
      const projectId = body.projectId;
      if (!projectId || !body.title) {
        return json(400, { error: "projectId and title required" });
      }

      const now = new Date().toISOString();
      const duration = parseDuration(body);
      const item = {
        PK: "ENTITY#TASK",
        SK: `TASK#${id}`,
        taskId: id,
        projectId,
        title: body.title,
        description: body.description || "",
        assignee: body.assignee || "",
        priority: PRIORITIES.includes(body.priority)
          ? body.priority
          : "MEDIUM",
        status: STATUSES.includes(body.status) ? body.status : "TODO",
        dueDate: body.dueDate || null,
        startDate: body.startDate || null,
        durationType: duration.durationType,
        durationHours: duration.durationHours,
        durationDays: duration.durationDays,
        durationStart: duration.durationStart,
        durationEnd: duration.durationEnd,
        completedDate: null,
        labels: body.labels || [],
        archived: false,
        createdAt: now,
        createdBy: user.email,
        updatedAt: now,
      };

      await putTaskCopies(item);
      await appendActivity(id, "task_created", "Task created", user.email);
      if (item.assignee) {
        await appendActivity(
          id,
          "task_assigned",
          `Assigned to ${item.assignee}`,
          user.email
        );
      }

      return json(201, item);
    }

    if (path.endsWith("/tasks") && method === "PUT") {
      const { taskId, projectId, ...updates } = body;
      if (!taskId) return json(400, { error: "taskId required" });

      const existing = await getTask(taskId);
      if (!existing) return json(404, { error: "Task not found" });

      const isAssignee = existing.assignee === user.email;
      if (!user.isAdmin && !isAssignee) return json(403, { error: "Forbidden" });

      const allowed = user.isAdmin
        ? updates
        : {
            status: updates.status,
          };

      if (allowed.status && !STATUSES.includes(allowed.status)) {
        delete allowed.status;
      }
      if (allowed.priority && !PRIORITIES.includes(allowed.priority)) {
        delete allowed.priority;
      }
      if (allowed.durationType !== undefined) {
        Object.assign(allowed, parseDuration(allowed));
      }

      const merged = {
        ...existing,
        ...allowed,
        taskId: existing.taskId,
        PK: "ENTITY#TASK",
        SK: `TASK#${taskId}`,
        updatedAt: new Date().toISOString(),
      };

      if (
        allowed.status === "DONE" &&
        existing.status !== "DONE" &&
        !merged.completedDate
      ) {
        merged.completedDate = new Date().toISOString().slice(0, 10);
      }

      await putTaskCopies(merged);

      if (allowed.status && allowed.status !== existing.status) {
        const statusLabel = (s) => {
          const map = {
            TODO: "TODO",
            IN_PROGRESS: "IN PROGRESS",
            REVIEW: "IN REVIEW",
            DONE: "COMPLETED",
            CANCELLED: "CANCELLED",
            BACKLOG: "TODO",
          };
          return map[String(s || "").toUpperCase()] || s;
        };
        await appendActivity(
          taskId,
          "status_changed",
          `Status changed from ${statusLabel(existing.status)} → ${statusLabel(
            allowed.status
          )}`,
          user.email
        );
      }
      if (allowed.priority && allowed.priority !== existing.priority) {
        await appendActivity(
          taskId,
          "priority_changed",
          `Priority changed from ${existing.priority} → ${allowed.priority}`,
          user.email
        );
      }
      if (
        allowed.assignee !== undefined &&
        allowed.assignee !== existing.assignee
      ) {
        await appendActivity(
          taskId,
          "task_assigned",
          `Assigned to ${allowed.assignee || "Unassigned"}`,
          user.email
        );
      }
      if (allowed.archived === true && !existing.archived) {
        await appendActivity(
          taskId,
          "task_archived",
          "Task archived",
          user.email
        );
      }
      if (allowed.title || allowed.description || allowed.dueDate !== undefined) {
        if (
          (allowed.title && allowed.title !== existing.title) ||
          (allowed.description !== undefined &&
            allowed.description !== existing.description) ||
          (allowed.dueDate !== undefined &&
            allowed.dueDate !== existing.dueDate)
        ) {
          await appendActivity(
            taskId,
            "task_updated",
            "Task details updated",
            user.email
          );
        }
      }

      void projectId;
      return json(200, { ...merged, overdue: isOverdue(merged) });
    }

    // Soft-delete / archive via PUT preferred; hard delete for admin
    if (path.endsWith("/tasks") && method === "DELETE") {
      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const taskId = body.taskId || event.queryStringParameters?.taskId;
      if (!taskId) return json(400, { error: "taskId required" });
      const existing = await getTask(taskId);
      if (!existing) return json(404, { error: "Task not found" });

      const merged = {
        ...existing,
        archived: true,
        status: existing.status,
        updatedAt: new Date().toISOString(),
      };
      await putTaskCopies(merged);
      await appendActivity(taskId, "task_archived", "Task archived", user.email);
      return json(200, { message: "Task archived", task: merged });
    }

    // ── TIME ENTRIES ──
    if (path.endsWith("/time-entries") && method === "POST") {
      if (!user.email) return json(401, { error: "Unauthorized" });
      const { taskId, minutes, note, projectId } = body;
      if (!taskId || !minutes) {
        return json(400, { error: "taskId and minutes required" });
      }

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

      await ddb.send(
        new PutCommand({ TableName: process.env.WORK_TABLE, Item: item })
      );
      return json(201, item);
    }

    if (path.endsWith("/time-entries") && method === "GET") {
      const email =
        user.isAdmin && event.queryStringParameters?.email
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
exports.PRIORITIES = PRIORITIES;

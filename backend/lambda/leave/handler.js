const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

const COMPANY_TZ = process.env.COMPANY_TIMEZONE || "Asia/Kolkata";
const APPROVAL_HOURS = Number(process.env.LEAVE_APPROVAL_HOURS || 5);
const APPROVER_EMAILS = String(
  process.env.LEAVE_APPROVER_EMAILS || "priya@mydgv.com,sachin@mydgv.com"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const LEAVE_TYPES = ["CASUAL", "SICK", "EARNED"];
const PENDING_STATUSES = new Set(["PENDING", "PENDING_APPROVAL"]);
const TERMINAL_STATUSES = new Set([
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "PLANNED_OFF",
]);

function todayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: COMPANY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseDateKey(key) {
  const [y, m, d] = String(key || "")
    .split("-")
    .map(Number);
  if (!y || !m || !d) return NaN;
  return Date.UTC(y, m - 1, d);
}

function isValidDateKey(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(key || "")) && Number.isFinite(parseDateKey(key));
}

function daysInclusive(fromDate, toDate) {
  const a = parseDateKey(fromDate);
  const b = parseDateKey(toDate);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86400000) + 1;
}

function daysUntilStart(startDate, now = new Date()) {
  return Math.round((parseDateKey(startDate) - parseDateKey(todayKey(now))) / 86400000);
}

function eachDate(fromDate, toDate) {
  const dates = [];
  let t = parseDateKey(fromDate);
  const end = parseDateKey(toDate);
  if (!Number.isFinite(t) || !Number.isFinite(end) || t > end) return dates;
  while (t <= end) {
    dates.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return dates;
}

function isPending(status) {
  return PENDING_STATUSES.has(String(status || "").toUpperCase());
}

function withComputed(item, now = new Date()) {
  if (!item) return item;
  const days = item.days || daysInclusive(item.fromDate || item.startDate, item.toDate || item.endDate);
  let remainingMs = null;
  if (isPending(item.status) && item.approvalDeadline) {
    remainingMs = Math.max(0, new Date(item.approvalDeadline).getTime() - now.getTime());
  }
  return {
    ...item,
    startDate: item.startDate || item.fromDate,
    endDate: item.endDate || item.toDate,
    days,
    remainingMs,
  };
}

async function putLeaveCopies(item) {
  await ddb.send(new PutCommand({ TableName: process.env.WORK_TABLE, Item: item }));
  await ddb.send(
    new PutCommand({
      TableName: process.env.WORK_TABLE,
      Item: { ...item, PK: `USER#${item.email}`, SK: `LEAVE#${item.leaveId}` },
    })
  );
}

async function getLeave(leaveId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.WORK_TABLE,
      Key: { PK: "ENTITY#LEAVE", SK: `LEAVE#${leaveId}` },
    })
  );
  return res.Item || null;
}

async function listEntityLeaves() {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.WORK_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "ENTITY#LEAVE" },
    })
  );
  return res.Items || [];
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

async function notifyApprovers(leave) {
  const message = `${leave.email} requested ${leave.type} leave from ${leave.fromDate} to ${leave.toDate} (${leave.days} day${leave.days === 1 ? "" : "s"}). Approval deadline: ${leave.approvalDeadline}.`;
  await Promise.all(
    APPROVER_EMAILS.map((email) =>
      writeNotification(email, {
        type: "LEAVE_SUBMITTED",
        title: "New leave request",
        message,
        leaveId: leave.leaveId,
      })
    )
  );
}

async function notifyEmployee(leave, type, message) {
  await writeNotification(leave.email, {
    type,
    title:
      type === "LEAVE_REJECTED"
        ? "Leave request rejected"
        : type === "LEAVE_AUTO_APPROVED"
          ? "Leave automatically approved"
          : "Leave request approved",
    message,
    leaveId: leave.leaveId,
  });
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

async function applyAttendanceStatus(email, fromDate, toDate, status) {
  if (!process.env.ATTENDANCE_TABLE || !email) return;
  const profile = await getProfile(email);
  const nowIso = new Date().toISOString();
  for (const date of eachDate(fromDate, toDate)) {
    let existing = null;
    try {
      const res = await ddb.send(
        new GetCommand({
          TableName: process.env.ATTENDANCE_TABLE,
          Key: { PK: email, SK: date },
        })
      );
      existing = res.Item || null;
    } catch {
      existing = null;
    }
    if (existing?.checkInTime) continue;

    const item = {
      ...(existing || {}),
      PK: email,
      SK: date,
      email,
      date,
      attendanceId: existing?.attendanceId || randomUUID(),
      employeeId: existing?.employeeId || profile.employeeId,
      employeeName: existing?.employeeName || profile.employeeName,
      status,
      sessionStatus: existing?.sessionStatus || null,
      checkInTime: existing?.checkInTime || null,
      checkOutTime: existing?.checkOutTime || null,
      workingTime: existing?.workingTime || null,
      workingSeconds: existing?.workingSeconds ?? null,
      hours: existing?.hours ?? null,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      GSI1PK: `DATE#${date}`,
      GSI1SK: `${nowIso}#${email}`,
    };
    await ddb.send(
      new PutCommand({ TableName: process.env.ATTENDANCE_TABLE, Item: item })
    );
  }
}

function validatePlannedOff({ fromDate, toDate, emergencyReason }) {
  if (!isValidDateKey(fromDate) || !isValidDateKey(toDate)) {
    return "Valid Planned Off date is required.";
  }
  if (parseDateKey(toDate) < parseDateKey(fromDate)) {
    return "End date cannot be before start date.";
  }
  const until = daysUntilStart(fromDate);
  if (until < 0) {
    return "Planned Off cannot be submitted for a past date.";
  }
  if (until < 1 && !String(emergencyReason || "").trim()) {
    return "Same-day Planned Off requires an emergency reason.";
  }
  return null;
}

function validateLeaveRequest({ fromDate, toDate, type, reason, emergencyReason }) {
  if (!isValidDateKey(fromDate) || !isValidDateKey(toDate)) {
    return "Start date and end date are required.";
  }
  if (parseDateKey(toDate) < parseDateKey(fromDate)) {
    return "End date cannot be before start date.";
  }
  if (!LEAVE_TYPES.includes(String(type || "").toUpperCase())) {
    return "Invalid leave type.";
  }
  const until = daysUntilStart(fromDate);
  if (until < 0) {
    return "Leave cannot start in the past.";
  }
  const days = daysInclusive(fromDate, toDate);
  if (days > 1 && until < 3 && !String(emergencyReason || "").trim()) {
    return "Leave requests for more than 1 day should normally be submitted at least 3 days in advance. Please provide an emergency reason.";
  }
  void reason;
  return null;
}

function resolveApprovalDeadline(item) {
  if (item?.approvalDeadline) {
    const t = new Date(item.approvalDeadline).getTime();
    if (Number.isFinite(t)) return t;
  }
  const submitted = item?.submittedAt || item?.createdAt;
  if (!submitted) return null;
  const t = new Date(submitted).getTime();
  if (!Number.isFinite(t)) return null;
  return t + APPROVAL_HOURS * 60 * 60 * 1000;
}

async function autoApproveExpired(now = new Date()) {
  const items = await listEntityLeaves();
  const approved = [];
  for (const item of items) {
    if (item.category === "PLANNED_OFF" || item.status === "PLANNED_OFF") continue;
    if (!isPending(item.status)) continue;
    const deadlineMs = resolveApprovalDeadline(item);
    if (deadlineMs == null) continue;
    if (now.getTime() < deadlineMs) continue;

    const updated = {
      ...item,
      status: "APPROVED",
      approvalDeadline: item.approvalDeadline || new Date(deadlineMs).toISOString(),
      approvedBy: "SYSTEM_AUTO",
      approvedAt: now.toISOString(),
      reviewedBy: "SYSTEM_AUTO",
      reviewedAt: now.toISOString(),
      autoApproved: true,
      updatedAt: now.toISOString(),
    };
    await putLeaveCopies(updated);
    await applyAttendanceStatus(updated.email, updated.fromDate, updated.toDate, "Leave");
    await notifyEmployee(
      updated,
      "LEAVE_AUTO_APPROVED",
      `Your leave request from ${updated.fromDate} to ${updated.toDate} has been automatically approved because no action was taken within ${APPROVAL_HOURS} hours.`
    );
    approved.push(updated.leaveId);
  }
  return { scanned: items.length, autoApproved: approved.length, leaveIds: approved };
}

function isAutoApproveEvent(event) {
  if (!event || event.httpMethod) return false;
  if (event.autoApprove === true || event.source === "leave-auto-approve") return true;
  if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
    return true;
  }
  const detail = event.detail;
  if (detail && typeof detail === "object") {
    return detail.autoApprove === true || detail.source === "leave-auto-approve";
  }
  return false;
}

async function autoApproveExpiredSafe() {
  try {
    const result = await autoApproveExpired();
    if (result.autoApproved) {
      console.log("Leave auto-approve", result);
    }
    return result;
  } catch (err) {
    console.error("Leave auto-approve error:", err);
    return null;
  }
}

function isMeetingRequest(event, body) {
  const qs = event.queryStringParameters || {};
  if (qs.meetings === "true") return true;
  const resource = String(body?.resource || body?.module || "").toUpperCase();
  return resource === "MEETING";
}

exports.handler = async (event) => {
  if (isAutoApproveEvent(event)) {
    const result = await autoApproveExpiredSafe();
    try {
      const { sendReminders } = require("../meetings/handler");
      await sendReminders();
    } catch (err) {
      console.error("Meeting reminders from leave schedule:", err);
    }
    if (!result) return json(500, { error: "Auto-approve failed" });
    return json(200, result);
  }

  if (event.httpMethod === "OPTIONS") return json(200, "");

  const user = getUser(event);
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    if (isMeetingRequest(event, body)) {
      const { handleCompat } = require("../meetings/handler");
      return await handleCompat(event, user, body);
    }

    if (event.httpMethod === "GET") {
      if (event.queryStringParameters?.notifications !== "true") {
        await autoApproveExpiredSafe();
      }

      if (event.queryStringParameters?.notifications === "true") {
        if (!user.email) return json(401, { error: "Unauthorized" });
        const res = await ddb.send(
          new QueryCommand({
            TableName: process.env.WORK_TABLE,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues: {
              ":pk": `USER#${user.email}`,
              ":sk": "NOTIFY#",
            },
            ScanIndexForward: false,
            Limit: 50,
          })
        );
        return json(200, res.Items || []);
      }

      if (user.isAdmin && event.queryStringParameters?.all === "true") {
        const items = (await listEntityLeaves()).map((i) => withComputed(i));
        items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        return json(200, items);
      }

      if (!user.email) return json(401, { error: "Unauthorized" });
      const res = await ddb.send(
        new QueryCommand({
          TableName: process.env.WORK_TABLE,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: {
            ":pk": `USER#${user.email}`,
            ":sk": "LEAVE#",
          },
        })
      );
      const items = (res.Items || []).map((i) => withComputed(i));
      items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return json(200, items);
    }

    if (event.httpMethod === "POST") {
      if (!user.email) return json(401, { error: "Unauthorized" });

      const category = String(body.category || body.requestType || "").toUpperCase();
      const isPlannedOff =
        category === "PLANNED_OFF" ||
        String(body.type || "").toUpperCase() === "PLANNED_OFF";

      const fromDate = body.fromDate || body.startDate || body.date;
      const toDate = body.toDate || body.endDate || fromDate;
      const reason = String(body.reason || "").trim();
      const emergencyReason = String(body.emergencyReason || "").trim();
      const now = new Date();
      const submittedAt = now.toISOString();
      const id = randomUUID();

      if (isPlannedOff) {
        const error = validatePlannedOff({ fromDate, toDate, emergencyReason });
        if (error) return json(400, { error });

        const days = daysInclusive(fromDate, toDate);
        const item = {
          PK: "ENTITY#LEAVE",
          SK: `LEAVE#${id}`,
          leaveId: id,
          email: user.email,
          category: "PLANNED_OFF",
          type: "PLANNED_OFF",
          fromDate,
          toDate,
          startDate: fromDate,
          endDate: toDate,
          days,
          reason,
          emergencyReason,
          status: "PLANNED_OFF",
          submittedAt,
          createdAt: submittedAt,
          approvalDeadline: null,
          approvedBy: null,
          approvedAt: null,
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
          timezone: COMPANY_TZ,
        };
        await putLeaveCopies(item);
        await applyAttendanceStatus(user.email, fromDate, toDate, "PlannedOff");
        return json(201, withComputed(item));
      }

      const type = String(body.type || "CASUAL").toUpperCase();
      const error = validateLeaveRequest({
        fromDate,
        toDate,
        type,
        reason,
        emergencyReason,
      });
      if (error) return json(400, { error });

      const days = daysInclusive(fromDate, toDate);
      const shortNotice = days > 1 && daysUntilStart(fromDate) < 3;
      const approvalDeadline = new Date(
        now.getTime() + APPROVAL_HOURS * 60 * 60 * 1000
      ).toISOString();

      const item = {
        PK: "ENTITY#LEAVE",
        SK: `LEAVE#${id}`,
        leaveId: id,
        email: user.email,
        category: "LEAVE",
        type,
        fromDate,
        toDate,
        startDate: fromDate,
        endDate: toDate,
        days,
        reason,
        emergencyReason: shortNotice ? emergencyReason : emergencyReason || "",
        shortNotice,
        status: "PENDING_APPROVAL",
        submittedAt,
        createdAt: submittedAt,
        approvalDeadline,
        approvedBy: null,
        approvedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
        timezone: COMPANY_TZ,
      };
      await putLeaveCopies(item);
      await notifyApprovers(item);
      return json(201, withComputed(item));
    }

    if (event.httpMethod === "PUT") {
      await autoApproveExpiredSafe();

      if (!user.isAdmin) return json(403, { error: "Admin required" });
      const { leaveId, status, rejectionReason } = body;
      if (!leaveId || !status) return json(400, { error: "leaveId and status required" });

      const next = String(status).toUpperCase();
      if (next !== "APPROVED" && next !== "REJECTED") {
        return json(400, { error: "status must be APPROVED or REJECTED" });
      }

      const item = await getLeave(leaveId);
      if (!item) return json(404, { error: "Not found" });

      if (item.category === "PLANNED_OFF" || item.status === "PLANNED_OFF") {
        return json(400, { error: "Planned Off does not require approval" });
      }
      if (!isPending(item.status)) {
        return json(409, {
          error: `Leave is already ${item.status} and cannot be changed`,
          leave: withComputed(item),
        });
      }

      const nowIso = new Date().toISOString();
      const updated = {
        ...item,
        status: next,
        reviewedBy: user.email,
        reviewedAt: nowIso,
        updatedAt: nowIso,
      };

      if (next === "APPROVED") {
        updated.approvedBy = user.email;
        updated.approvedAt = nowIso;
        updated.rejectedBy = null;
        updated.rejectedAt = null;
      } else {
        updated.rejectedBy = user.email;
        updated.rejectedAt = nowIso;
        updated.rejectionReason = String(rejectionReason || "").trim();
        updated.approvedBy = null;
        updated.approvedAt = null;
      }

      await putLeaveCopies(updated);

      if (next === "APPROVED") {
        await applyAttendanceStatus(updated.email, updated.fromDate, updated.toDate, "Leave");
        await notifyEmployee(
          updated,
          "LEAVE_APPROVED",
          `Your leave request from ${updated.fromDate} to ${updated.toDate} has been approved.`
        );
      } else {
        await notifyEmployee(
          updated,
          "LEAVE_REJECTED",
          `Your leave request from ${updated.fromDate} to ${updated.toDate} has been rejected.${
            updated.rejectionReason ? ` Reason: ${updated.rejectionReason}` : ""
          }`
        );
      }

      return json(200, withComputed(updated));
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Leave error:", err);
    return json(500, { error: "Internal server error" });
  }
};

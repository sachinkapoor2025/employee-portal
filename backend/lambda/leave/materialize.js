const { randomUUID } = require("crypto");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { isSuperAdminRole } = require("../common/roles");

const COMPANY_TZ = process.env.COMPANY_TIMEZONE || "Asia/Kolkata";
const SOURCE_LEAVE_MATERIALIZED = "LEAVE_MATERIALIZED";

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

function normalizeEmail(email) {
  return String(email || "")
    .replace(/^USER#/i, "")
    .trim()
    .toLowerCase();
}

function isValidDateKey(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(key || ""));
}

function leaveCoversDate(item, dateKey) {
  const from = item?.fromDate || item?.startDate;
  const to = item?.toDate || item?.endDate || from;
  if (!isValidDateKey(from) || !isValidDateKey(to) || !isValidDateKey(dateKey)) {
    return false;
  }
  return dateKey >= from && dateKey <= to;
}

function isCancelledStatus(status) {
  return String(status || "").toUpperCase() === "CANCELLED";
}

function isConfirmedLeaveRecord(item) {
  if (!item || isCancelledStatus(item.status)) return false;
  const status = String(item.status || "").toUpperCase();
  return status === "APPROVED" || status === "PLANNED_OFF";
}

function overlayStatusForConfirmedLeave(leave) {
  if (!isConfirmedLeaveRecord(leave)) return null;
  const status = String(leave.status || "").toUpperCase();
  if (status === "PLANNED_OFF") return "PlannedOff";
  return "Leave";
}

function attendanceStatusForLeave(item) {
  const status = String(item?.status || "").toUpperCase();
  const category = String(item?.category || "").toUpperCase();
  const type = String(item?.type || "").toUpperCase();
  if (
    status === "PLANNED_OFF" ||
    category === "PLANNED_OFF" ||
    type === "PLANNED_OFF"
  ) {
    return "PlannedOff";
  }
  return "Leave";
}

function hasRealAttendanceActivity(item) {
  if (!item) return false;
  if (item.actualCheckInTime || item.actualCheckOutTime) return true;
  if (item.checkInTime || item.checkOutTime) return true;
  const session = String(item.sessionStatus || "");
  if (session === "Active" || session === "Checked Out" || session === "Present") {
    return true;
  }
  const status = String(item.status || "");
  if (status === "Working" || status === "Present") return true;
  if (item.submittedAt && status !== "Leave" && status !== "PlannedOff") return true;
  return false;
}

function isEffectiveLeaveLock(item) {
  if (!item?.submittedAt) return false;
  const status = String(item.status || "");
  return status === "Leave" || status === "PlannedOff";
}

function isConditionalCheckFailed(err) {
  return (
    err?.name === "ConditionalCheckFailedException" ||
    err?.Code === "ConditionalCheckFailedException" ||
    err?.code === "ConditionalCheckFailedException"
  );
}

async function getAttendanceDay(ddb, table, email, dateKey) {
  if (!ddb || !table || !email || !dateKey) return null;
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: table,
        Key: { PK: email, SK: dateKey },
      })
    );
    return res.Item || null;
  } catch {
    return null;
  }
}

async function loadUserAccessRole(ddb, email) {
  const table = process.env.USER_ACCESS_TABLE;
  const normalized = normalizeEmail(email);
  if (!ddb || !table || !normalized) return null;
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: table,
        Key: { PK: normalized, SK: normalized },
      })
    );
    return res.Item?.role || null;
  } catch {
    return null;
  }
}

async function getProfile(ddb, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return { employeeId: "—", employeeName: "Unknown" };
  }
  if (!process.env.USER_PROFILE_TABLE) {
    return {
      employeeId: normalized.split("@")[0],
      employeeName: normalized.split("@")[0],
    };
  }
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: { PK: `USER#${normalized}`, SK: "PROFILE" },
      })
    );
    const p = res.Item || {};
    return {
      employeeId: p.empId || normalized.split("@")[0],
      employeeName: p.name || normalized.split("@")[0],
    };
  } catch {
    return {
      employeeId: normalized.split("@")[0],
      employeeName: normalized.split("@")[0],
    };
  }
}

async function listEntityLeaves(ddb, workTable) {
  if (!ddb || !workTable) return [];
  const res = await ddb.send(
    new QueryCommand({
      TableName: workTable,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "ENTITY#LEAVE" },
    })
  );
  return res.Items || [];
}

async function listUserLeaves(ddb, workTable, email) {
  const normalized = normalizeEmail(email);
  if (!ddb || !workTable || !normalized) return [];
  const res = await ddb.send(
    new QueryCommand({
      TableName: workTable,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": `USER#${normalized}`,
        ":sk": "LEAVE#",
      },
    })
  );
  return res.Items || [];
}

function findConfirmedLeaveCoveringDateFromItems(items, email, dateKey) {
  const owner = normalizeEmail(email);
  for (const item of items || []) {
    if (!isConfirmedLeaveRecord(item)) continue;
    if (normalizeEmail(item.email) !== owner) continue;
    if (!leaveCoversDate(item, dateKey)) continue;
    return item;
  }
  return null;
}

async function findConfirmedLeaveCoveringDate(ddb, workTable, email, dateKey) {
  const items = await listUserLeaves(ddb, workTable, email);
  return findConfirmedLeaveCoveringDateFromItems(items, email, dateKey);
}

async function materializeConfirmedLeaveDay({
  ddb,
  leave,
  now = new Date(),
  attendanceTable = process.env.ATTENDANCE_TABLE,
} = {}) {
  if (!ddb || !leave || !attendanceTable) return { action: "skipped" };
  const email = normalizeEmail(leave.email);
  if (!email) return { action: "skipped" };
  if (!isConfirmedLeaveRecord(leave)) return { action: "skipped" };
  const today = todayKey(now);
  if (!leaveCoversDate(leave, today)) return { action: "skipped" };
  if (isSuperAdminRole(await loadUserAccessRole(ddb, email))) {
    return { action: "skipped" };
  }

  const existing = await getAttendanceDay(ddb, attendanceTable, email, today);
  if (hasRealAttendanceActivity(existing)) {
    return { action: "preserved" };
  }
  if (isEffectiveLeaveLock(existing)) {
    return { action: "exists", attendanceId: existing.attendanceId };
  }

  const profile = await getProfile(ddb, email);
  const nowIso = now.toISOString();
  const status = attendanceStatusForLeave(leave);
  const item = {
    PK: email,
    SK: today,
    email,
    date: today,
    attendanceId: existing?.attendanceId || randomUUID(),
    employeeId: existing?.employeeId || profile.employeeId,
    employeeName: existing?.employeeName || profile.employeeName,
    status,
    leaveId: leave.leaveId || existing?.leaveId || null,
    source: SOURCE_LEAVE_MATERIALIZED,
    submittedAt: nowIso,
    sessionStatus: null,
    checkInTime: null,
    checkOutTime: null,
    workingTime: null,
    workingSeconds: null,
    hours: null,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    GSI1PK: `DATE#${today}`,
    GSI1SK: `${nowIso}#${email}`,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: attendanceTable,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(PK) OR (attribute_not_exists(submittedAt) AND attribute_not_exists(actualCheckInTime) AND attribute_not_exists(actualCheckOutTime))",
      })
    );
    return { action: "written", attendanceId: item.attendanceId, date: today };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { action: "conflict" };
    }
    throw err;
  }
}

async function materializeTodaysConfirmedLeave({
  ddb,
  now = new Date(),
  workTable = process.env.WORK_TABLE,
  attendanceTable = process.env.ATTENDANCE_TABLE,
} = {}) {
  const result = {
    scanned: 0,
    written: 0,
    exists: 0,
    preserved: 0,
    skipped: 0,
  };
  if (!ddb || !workTable || !attendanceTable) return result;
  let items = [];
  try {
    items = await listEntityLeaves(ddb, workTable);
  } catch (err) {
    console.error("LEAVE_MATERIALIZE_LIST_ERROR", err);
    return result;
  }
  result.scanned = items.length;
  for (const leave of items) {
    try {
      const one = await materializeConfirmedLeaveDay({
        ddb,
        leave,
        now,
        attendanceTable,
      });
      if (one.action === "written") result.written += 1;
      else if (one.action === "exists") result.exists += 1;
      else if (one.action === "preserved") result.preserved += 1;
      else result.skipped += 1;
    } catch (err) {
      console.error(
        "LEAVE_MATERIALIZE_ITEM_ERROR",
        JSON.stringify({ leaveId: leave?.leaveId || "" })
      );
      console.error(err);
      result.skipped += 1;
    }
  }
  return result;
}

module.exports = {
  SOURCE_LEAVE_MATERIALIZED,
  todayKey,
  isConfirmedLeaveRecord,
  overlayStatusForConfirmedLeave,
  leaveCoversDate,
  attendanceStatusForLeave,
  hasRealAttendanceActivity,
  isEffectiveLeaveLock,
  findConfirmedLeaveCoveringDate,
  materializeConfirmedLeaveDay,
  materializeTodaysConfirmedLeave,
};

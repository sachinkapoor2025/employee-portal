const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const { json } = require("../common/response");
const { dispatchNotification } = require("../common/notify");
const {
  dateKeyInTimeZone,
  addDaysToKey,
  LOOKBACK_DAYS,
  findMissedWorkingStreak,
  attendanceEmail,
  documentEmail,
  trainingEmail,
} = require("./logic");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

const DOC_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const TRAINING_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DOC_TYPES = [
  { code: "AADHAAR", label: "Aadhaar Card", required: true },
  { code: "PAN", label: "PAN Card", required: true },
  { code: "PASSPORT", label: "Passport", required: false },
  { code: "PHOTOGRAPH", label: "Photograph", required: true },
  { code: "RESUME", label: "Resume/CV", required: true },
  { code: "BANK", label: "Bank Document", required: false },
  { code: "ADDRESS", label: "Address Proof", required: false },
  { code: "OTHER", label: "Other Documents", required: false },
];

function portalUrl() {
  return process.env.PORTAL_URL || "https://login.mydgv.com";
}

function isScheduleEvent(event) {
  if (!event || event.httpMethod) return false;
  if (event.notifications === true || event.source === "notifications") return true;
  if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
    return true;
  }
  return false;
}

async function scanAll(tableName) {
  const items = [];
  let lastKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function queryPk(pk, skPrefix) {
  const items = [];
  let lastKey;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: process.env.WORK_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": pk, ":sk": skPrefix },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function listActiveEmployees() {
  const rows = await scanAll(process.env.USER_ACCESS_TABLE);
  const seen = new Set();
  const employees = [];
  for (const row of rows) {
    const email = String(row.email || row.PK || "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    if (String(row.status || "").toUpperCase() !== "ACTIVE") continue;
    seen.add(email);
    employees.push({ email, role: row.role || "" });
  }
  return employees;
}

async function getProfile(email) {
  if (!process.env.USER_PROFILE_TABLE) {
    return { name: email.split("@")[0], skill: "", doj: "" };
  }
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: process.env.USER_PROFILE_TABLE,
        Key: { PK: `USER#${email}`, SK: "PROFILE" },
      })
    );
    const p = res.Item || {};
    return {
      name: p.name || email.split("@")[0],
      skill: p.skill ? String(p.skill).trim().toUpperCase() : "",
      doj: p.doj || p.dateOfJoining || "",
    };
  } catch {
    return { name: email.split("@")[0], skill: "", doj: "" };
  }
}

async function loadAttendanceWindow(email, startKey, endKey) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.ATTENDANCE_TABLE,
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":pk": email,
        ":start": startKey,
        ":end": endKey,
      },
    })
  );
  const recordsByDate = {};
  for (const item of res.Items || []) {
    const key = item.SK || item.date;
    if (key) recordsByDate[key] = item;
  }
  return recordsByDate;
}

async function loadLeaves(email) {
  if (!process.env.WORK_TABLE) return [];
  return queryPk(`USER#${email}`, "LEAVE#");
}

async function processAttendance(employee, todayKey) {
  const yesterday = addDaysToKey(todayKey, -1);
  const start = addDaysToKey(yesterday, -(LOOKBACK_DAYS - 1));
  const [recordsByDate, leaves, profile] = await Promise.all([
    loadAttendanceWindow(employee.email, start, yesterday),
    loadLeaves(employee.email),
    getProfile(employee.email),
  ]);
  const found = findMissedWorkingStreak({
    todayKey,
    recordsByDate,
    leaves,
    notBeforeKey: String(profile.doj || "").slice(0, 10),
  });
  if (!found.shouldNotify) {
    return { sent: false, skipped: true };
  }
  const reason = `Attendance not marked for 2 required working days (${found.missedDays.join(", ")})`;
  const { subject, message } = attendanceEmail({
    employeeName: profile.name,
    missedDays: found.missedDays,
    portalUrl: portalUrl(),
  });
  return dispatchNotification(ddb, {
    email: employee.email,
    type: "ATTENDANCE_MISSED",
    title: "Attendance not marked",
    subject,
    message,
    reason,
    dedupKey: found.eventKey,
    extra: { missedDays: found.missedDays, streakStart: found.eventKey },
  });
}

async function listDocTypes() {
  if (!process.env.WORK_TABLE) return DEFAULT_DOC_TYPES;
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
  return DEFAULT_DOC_TYPES.map((t) => ({
    ...t,
    required: overrides[t.code]?.required ?? t.required,
    label: overrides[t.code]?.label || t.label,
  }));
}

async function processDocuments(employee, types) {
  const docs = (await queryPk(`USER#${employee.email}`, "CURRENT#")).filter(
    (i) => i.isCurrent !== false
  );
  const byType = Object.fromEntries(docs.map((d) => [d.documentType, d]));
  const pending = [];
  for (const t of types.filter((x) => x.required)) {
    const doc = byType[t.code];
    if (!doc) pending.push({ code: t.code, label: t.label, note: "not uploaded" });
    else if (String(doc.status || "").toUpperCase() === "REJECTED") {
      pending.push({
        code: t.code,
        label: t.label,
        note: "rejected — please re-upload",
      });
    }
  }
  if (!pending.length) return { sent: 0 };

  const profile = await getProfile(employee.email);
  let sent = 0;
  for (const doc of pending) {
    const { subject, message } = documentEmail({
      employeeName: profile.name,
      documents: [doc],
      portalUrl: portalUrl(),
    });
    const result = await dispatchNotification(ddb, {
      email: employee.email,
      type: "DOCUMENT_MISSING",
      title: "Document required",
      subject,
      message,
      reason: `Required document pending: ${doc.label}`,
      dedupKey: doc.code,
      cooldownMs: DOC_COOLDOWN_MS,
      extra: { documentType: doc.code },
    });
    if (result.status === "SENT") sent += 1;
  }
  return { sent };
}

async function queryTrainings(skillCode) {
  if (!process.env.TRAINING_TABLE || !skillCode) return [];
  const items = [];
  let lastKey;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: process.env.TRAINING_TABLE,
        KeyConditionExpression: "PK = :pk",
        FilterExpression: "is_active = :active",
        ExpressionAttributeValues: {
          ":pk": `SKILL#${skillCode}`,
          ":active": true,
        },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function loadProgress(email) {
  if (!process.env.TRAINING_PROGRESS_TABLE) return {};
  const items = [];
  let lastKey;
  try {
    do {
      const result = await ddb.send(
        new QueryCommand({
          TableName: process.env.TRAINING_PROGRESS_TABLE,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": email },
          ExclusiveStartKey: lastKey,
        })
      );
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  } catch (err) {
    console.error("TRAINING_PROGRESS_READ_FAILED", err?.name);
    return {};
  }
  const map = {};
  for (const item of items) {
    const id = item.SK || item.training_id;
    if (id) map[String(id)] = String(item.status || "");
  }
  return map;
}

async function processTraining(employee) {
  const profile = await getProfile(employee.email);
  const assigned = [
    ...(await queryTrainings("ALL")),
    ...(profile.skill ? await queryTrainings(profile.skill) : []),
  ];
  const unique = [];
  const seen = new Set();
  for (const t of assigned) {
    const id = t.training_id || t.SK;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(t);
  }
  if (!unique.length) return { sent: false, skipped: true };

  const progress = await loadProgress(employee.email);
  const pending = unique.filter((t) => {
    const id = String(t.training_id || t.SK);
    return String(progress[id] || "").toLowerCase() !== "completed";
  });
  if (!pending.length) return { sent: false, skipped: true };

  const titles = pending.map((t) => t.title || t.training_id).slice(0, 12);
  const { subject, message } = trainingEmail({
    employeeName: profile.name,
    titles,
    portalUrl: portalUrl(),
  });
  return dispatchNotification(ddb, {
    email: employee.email,
    type: "TRAINING_PENDING",
    title: "Training pending",
    subject,
    message,
    reason: "Assigned training is still incomplete",
    dedupKey: "ASSIGNED",
    cooldownMs: TRAINING_COOLDOWN_MS,
    extra: { trainingCount: pending.length },
  });
}

async function runNotifications() {
  const todayKey = dateKeyInTimeZone(new Date());
  const employees = await listActiveEmployees();
  const summary = {
    employees: employees.length,
    attendanceSent: 0,
    attendanceFailed: 0,
    documentsSent: 0,
    trainingSent: 0,
  };

  for (const employee of employees) {
    try {
      const attendance = await processAttendance(employee, todayKey);
      if (attendance.status === "SENT") summary.attendanceSent += 1;
      if (attendance.status === "FAILED") summary.attendanceFailed += 1;
    } catch (err) {
      console.error("ATTENDANCE_NOTIFY_ERROR", employee.email, err?.name);
    }
    // Documents v1 dropped the missing-required-document reminder email.
    try {
      const training = await processTraining(employee);
      if (training.status === "SENT") summary.trainingSent += 1;
    } catch (err) {
      console.error("TRAINING_NOTIFY_ERROR", employee.email, err?.name);
    }
  }

  console.log("NOTIFICATION_RUN", JSON.stringify(summary));
  return summary;
}

exports.handler = async (event) => {
  if (event?.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (!isScheduleEvent(event) && event?.httpMethod) {
    return json(403, { error: "Scheduled invocation only" });
  }
  try {
    const summary = await runNotifications();
    return json(200, summary);
  } catch (err) {
    console.error("NOTIFICATION_JOB_FAILED", err?.name);
    return json(500, { error: "Notification job failed" });
  }
};

exports.runNotifications = runNotifications;

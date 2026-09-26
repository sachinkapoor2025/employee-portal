const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const { isSuperAdminRole } = require("../common/roles");
const { companyTodayKey } = require("../common/shiftWindows");
const {
  resolveWorkPeriod,
  workPeriodEligibility,
  buildWorkingAttendanceShift,
  loadCurrentAssignedShift,
} = require("./assignedShift");
const {
  findConfirmedLeaveCoveringDate,
  isEffectiveLeaveLock,
  overlayStatusForConfirmedLeave,
} = require("../leave/materialize");

let ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
let nowMs = () => Date.now();

const EMPLOYEE_STATUSES = new Set([
  "Working",
  "Leave",
  "Holiday",
  "WeeklyOff",
]);

function isValidDateKey(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(key || ""));
}

function parseInstantMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function formatWorkingTime(checkInTime, checkOutTime) {
  const start = new Date(checkInTime).getTime();
  const end = new Date(checkOutTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { workingSeconds: 0, workingTime: "00h 00m 00s", hours: 0 };
  }
  const workingSeconds = Math.floor((end - start) / 1000);
  const h = Math.floor(workingSeconds / 3600);
  const m = Math.floor((workingSeconds % 3600) / 60);
  const s = workingSeconds % 60;
  const workingTime = `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  const hours = Math.round((workingSeconds / 3600) * 100) / 100;
  return { workingSeconds, workingTime, hours };
}

function recordEmail(item) {
  const raw = item?.email || item?.PK || "";
  return String(raw)
    .replace(/^USER#/i, "")
    .trim()
    .toLowerCase();
}

function toPublicRecord(item) {
  if (!item) return null;
  const email = recordEmail(item);
  return {
    attendanceId: item.attendanceId || null,
    employeeId: item.employeeId || null,
    employeeName: item.employeeName || null,
    email: email || null,
    date: item.date || item.SK || null,
    checkInTime: item.checkInTime || null,
    checkOutTime: item.checkOutTime || null,
    workingTime: item.workingTime || null,
    workingSeconds: item.workingSeconds ?? null,
    hours: item.hours ?? null,
    status: item.status || null,
    dayType: item.dayType || null,
    shift: item.shift || null,
    reason: item.reason || null,
    submittedAt: item.submittedAt || null,
    sessionStatus: item.sessionStatus || null,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
    shiftId: item.shiftId || null,
    shiftName: item.shiftName || null,
    expectedStartTime: item.expectedStartTime || null,
    expectedEndTime: item.expectedEndTime || null,
    graceMinutes: item.graceMinutes ?? null,
    crossesMidnight: item.crossesMidnight ?? null,
    workPeriod: item.workPeriod || null,
    timeSource: item.timeSource || null,
    attendanceSubmittedAt: item.attendanceSubmittedAt || null,
    timingStatus: item.timingStatus || null,
    lateMinutes: item.lateMinutes ?? null,
    actualCheckInTime: item.actualCheckInTime || null,
    actualCheckOutTime: item.actualCheckOutTime || null,
    workedBeyondShift: item.workedBeyondShift ?? null,
    workedBeyondReason: item.workedBeyondReason || null,
  };
}

async function getProfile(email) {
  const table = process.env.USER_PROFILE_TABLE;
  const normalized = String(email || "")
    .replace(/^USER#/i, "")
    .trim()
    .toLowerCase();
  if (!table || !normalized) {
    return {
      employeeId: normalized.split("@")[0] || "—",
      employeeName: normalized.split("@")[0] || "Unknown",
    };
  }
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: table,
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

async function findEmailsBySearch(search) {
  const table = process.env.USER_PROFILE_TABLE;
  const emails = new Set();
  if (!table || !search) return emails;
  let lastKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey: lastKey,
      })
    );
    for (const p of result.Items || []) {
      const email = recordEmail(p);
      const name = String(p.name || "").toLowerCase();
      const empId = String(p.empId || p.employeeId || "").toLowerCase();
      if (
        name.includes(search) ||
        empId.includes(search) ||
        email.includes(search)
      ) {
        if (email) emails.add(email);
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return emails;
}

async function queryAttendanceByEmail(email) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: process.env.ATTENDANCE_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": email },
    })
  );
  return result.Items || [];
}

async function enrichRecords(records) {
  const unique = [
    ...new Set(records.map((r) => String(r.email || "").toLowerCase()).filter(Boolean)),
  ];
  const profiles = {};
  await Promise.all(
    unique.map(async (email) => {
      profiles[email] = await getProfile(email);
    })
  );
  return records.map((r) => {
    const email = String(r.email || "").toLowerCase();
    const p = profiles[email];
    return {
      ...r,
      email: email || r.email,
      employeeName: r.employeeName || p?.employeeName || null,
      employeeId: r.employeeId || p?.employeeId || null,
    };
  });
}

async function getDayRecord(email, date) {
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.ATTENDANCE_TABLE,
      Key: { PK: email, SK: date },
    })
  );
  return res.Item || null;
}

async function putRecord(item) {
  await ddb.send(
    new PutCommand({
      TableName: process.env.ATTENDANCE_TABLE,
      Item: item,
    })
  );
}

async function loadUserAccessRole(email) {
  const table = process.env.USER_ACCESS_TABLE;
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!table || !normalized) return null;
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

async function attendanceExemptResponse(email) {
  const role = await loadUserAccessRole(email);
  if (!isSuperAdminRole(role)) return null;
  return json(403, {
    error: "SUPER_ADMIN users do not participate in attendance.",
  });
}

function isEmployeeLocked(item) {
  return Boolean(item?.submittedAt);
}

const WORKED_BEYOND_REASON_MAX = 500;

function normalizeWorkedBeyondReason(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, WORKED_BEYOND_REASON_MAX);
}

function isWorkedBeyond(actualOutIso, expectedEndIso) {
  const actual = Date.parse(actualOutIso);
  const expected = Date.parse(expectedEndIso);
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  return actual > expected;
}

function isConditionalCheckFailed(err) {
  return (
    err?.name === "ConditionalCheckFailedException" ||
    err?.Code === "ConditionalCheckFailedException" ||
    err?.code === "ConditionalCheckFailedException"
  );
}

/** First employee submission only — never overwrite submittedAt. */
async function putFirstEmployeeSubmission(item) {
  await ddb.send(
    new PutCommand({
      TableName: process.env.ATTENDANCE_TABLE,
      Item: item,
      ConditionExpression: "attribute_not_exists(submittedAt)",
    })
  );
}

function buildDateKeys(date, checkInTime, email) {
  return {
    GSI1PK: `DATE#${date}`,
    // Sort latest check-in first when ScanIndexForward=false
    GSI1SK: `${checkInTime || "1970-01-01T00:00:00.000Z"}#${email}`,
  };
}

exports.handler = async (event) => {
  try {
    const user = getUser(event);
    const path = event.path || "";
    const method = event.httpMethod;

    if (!user.email) {
      return json(401, { error: "Unauthorized" });
    }

    // =====================================================
    // ADMIN: Attendance Activity list
    // =====================================================
    if (
      method === "GET" &&
      path.includes("/admin/attendance-activity")
    ) {
      if (!user.isAdmin) {
        return json(403, { error: "Admin access required" });
      }

      const qs = event.queryStringParameters || {};
      const date = qs.date || "";
      const statusFilter = (qs.status || "").trim();
      const search = (qs.search || "").trim().toLowerCase();
      const page = Math.max(1, parseInt(qs.page || "1", 10) || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, parseInt(qs.pageSize || "20", 10) || 20)
      );

      let items = [];
      let searchedByProfile = false;

      if (search) {
        const emails = await findEmailsBySearch(search);
        if (search.includes("@")) emails.add(search);
        if (emails.size) {
          const scanned = [];
          for (const email of emails) {
            scanned.push(...(await queryAttendanceByEmail(email)));
          }
          items = scanned;
          searchedByProfile = items.length > 0;
        }
        if (!items.length) {
          const scanned = [];
          let lastKey;
          do {
            const result = await ddb.send(
              new ScanCommand({
                TableName: process.env.ATTENDANCE_TABLE,
                ExclusiveStartKey: lastKey,
              })
            );
            scanned.push(...(result.Items || []));
            lastKey = result.LastEvaluatedKey;
          } while (lastKey);
          items = scanned;
        }
      } else if (date) {
        const result = await ddb.send(
          new QueryCommand({
            TableName: process.env.ATTENDANCE_TABLE,
            IndexName: "DateIndex",
            KeyConditionExpression: "GSI1PK = :pk",
            ExpressionAttributeValues: { ":pk": `DATE#${date}` },
            ScanIndexForward: false,
          })
        );
        items = result.Items || [];
      } else {
        // Full activity feed — scan then sort by latest check-in
        const scanned = [];
        let lastKey;
        do {
          const result = await ddb.send(
            new ScanCommand({
              TableName: process.env.ATTENDANCE_TABLE,
              ExclusiveStartKey: lastKey,
            })
          );
          scanned.push(...(result.Items || []));
          lastKey = result.LastEvaluatedKey;
        } while (lastKey);
        items = scanned;
      }

      let records = items
        .map(toPublicRecord)
        .filter((r) => r && (r.checkInTime || r.sessionStatus || r.status || r.date));

      records = await enrichRecords(records);

      if (search && date) {
        records = records.filter((r) => r.date === date);
      }

      // Normalize display status for admin filters/badges
      records = records.map((r) => {
        let activityStatus = r.sessionStatus;
        if (!activityStatus) {
          if (r.checkInTime && !r.checkOutTime) activityStatus = "Active";
          else if (r.checkOutTime) activityStatus = "Checked Out";
          else if (r.status === "Working") activityStatus = "Present";
          else activityStatus = r.status || "Present";
        }
        return { ...r, activityStatus };
      });

      if (statusFilter) {
        records = records.filter(
          (r) =>
            String(r.activityStatus).toLowerCase() ===
            statusFilter.toLowerCase()
        );
      }

      if (search && !searchedByProfile) {
        records = records.filter((r) => {
          const name = String(r.employeeName || "").toLowerCase();
          const id = String(r.employeeId || "").toLowerCase();
          const email = String(r.email || "").toLowerCase();
          return (
            name.includes(search) ||
            id.includes(search) ||
            email.includes(search)
          );
        });
      }

      records.sort((a, b) => {
        const ta = new Date(a.checkInTime || a.updatedAt || 0).getTime();
        const tb = new Date(b.checkInTime || b.updatedAt || 0).getTime();
        return tb - ta;
      });

      const total = records.length;
      const start = (page - 1) * pageSize;
      const pageItems = records.slice(start, start + pageSize);

      return json(200, {
        items: pageItems,
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      });
    }

    // =====================================================
    // EMPLOYEE: Check-In / Check-Out / Week save / Get range
    // =====================================================

    if (method === "POST") {
      const blocked = await attendanceExemptResponse(user.email);
      if (blocked) return blocked;

      const body = JSON.parse(event.body || "null");

      // ---- Check-In (server time → actualCheckInTime) ----
      if (body && !Array.isArray(body) && body.action === "checkIn") {
        const submittedMs = nowMs();
        const nowIso = new Date(submittedMs).toISOString();
        const todayKey = companyTodayKey(new Date(submittedMs));
        if (body.date && isValidDateKey(body.date) && body.date !== todayKey) {
          return json(400, { error: "Attendance can only be punched for today." });
        }

        const existing = await getDayRecord(user.email, todayKey);
        if (!existing || existing.status !== "Working") {
          return json(400, {
            error: "Submit Working attendance before checking in.",
          });
        }
        if (existing.actualCheckInTime) {
          return json(200, {
            message: "Already checked in",
            attendance: toPublicRecord(existing),
          });
        }

        const assignment = await loadCurrentAssignedShift(
          ddb,
          process.env.WORK_TABLE,
          user.email
        );
        if (!assignment && !existing.shiftId) {
          return json(400, {
            error:
              "No shift is assigned. Ask an admin to assign your shift before checking in.",
          });
        }

        const item = {
          ...existing,
          PK: user.email,
          SK: todayKey,
          email: user.email,
          date: todayKey,
          status: "Working",
          sessionStatus: "Active",
          actualCheckInTime: nowIso,
          checkInTime: existing.checkInTime,
          checkOutTime: existing.checkOutTime,
          expectedStartTime: existing.expectedStartTime,
          expectedEndTime: existing.expectedEndTime,
          updatedAt: nowIso,
          ...buildDateKeys(
            todayKey,
            existing.checkInTime || nowIso,
            user.email
          ),
        };

        await putRecord(item);

        return json(200, {
          message: "Checked in",
          attendance: toPublicRecord(item),
        });
      }

      // ---- Check-Out (server time → actualCheckOutTime; allowed after submittedAt) ----
      if (body && !Array.isArray(body) && body.action === "checkOut") {
        const submittedMs = nowMs();
        const nowIso = new Date(submittedMs).toISOString();
        const todayKey = companyTodayKey(new Date(submittedMs));
        if (body.date && isValidDateKey(body.date) && body.date !== todayKey) {
          return json(400, { error: "Attendance can only be punched for today." });
        }

        const existing = await getDayRecord(user.email, todayKey);
        if (!existing || existing.status !== "Working") {
          return json(400, {
            error: "Only Working attendance can be checked out.",
          });
        }
        if (!existing.actualCheckInTime) {
          return json(400, { error: "Cannot check out before check-in" });
        }
        if (existing.actualCheckOutTime) {
          return json(200, {
            message: "Already checked out",
            attendance: toPublicRecord(existing),
          });
        }

        const workedBeyondShift = isWorkedBeyond(
          nowIso,
          existing.expectedEndTime
        );
        const workedBeyondReason = workedBeyondShift
          ? normalizeWorkedBeyondReason(body.workedBeyondReason)
          : null;

        const item = {
          ...existing,
          PK: user.email,
          SK: todayKey,
          email: user.email,
          date: todayKey,
          status: "Working",
          sessionStatus: "Checked Out",
          actualCheckInTime: existing.actualCheckInTime,
          actualCheckOutTime: nowIso,
          workedBeyondShift,
          workedBeyondReason,
          checkInTime: existing.checkInTime,
          checkOutTime: existing.checkOutTime,
          expectedStartTime: existing.expectedStartTime,
          expectedEndTime: existing.expectedEndTime,
          workingTime: existing.workingTime,
          workingSeconds: existing.workingSeconds,
          hours: existing.hours,
          reason: existing.reason,
          updatedAt: nowIso,
          ...buildDateKeys(
            todayKey,
            existing.checkInTime || existing.actualCheckInTime,
            user.email
          ),
        };

        await putRecord(item);

        return json(200, {
          message: "Checked out",
          attendance: toPublicRecord(item),
        });
      }

      // ---- Employee daily attendance save (today only) ----
      const attendanceData = body;
      if (!Array.isArray(attendanceData) || attendanceData.length !== 1) {
        return json(400, {
          error: "Attendance can only be submitted for today.",
        });
      }

      const submittedMs = nowMs();
      const nowIso = new Date(submittedMs).toISOString();
      const todayKey = companyTodayKey(new Date(submittedMs));
      const profile = await getProfile(user.email);

      for (const entry of attendanceData) {
        if (entry.date && isValidDateKey(entry.date) && entry.date !== todayKey) {
          return json(400, {
            error: "Attendance can only be submitted for today.",
          });
        }

        const status = String(entry.status || "").trim();
        if (!EMPLOYEE_STATUSES.has(status)) {
          return json(400, { error: "Invalid attendance status." });
        }

        const existing = await getDayRecord(user.email, todayKey);
        const working = status === "Working";
        if (working) {
          if (isEffectiveLeaveLock(existing)) {
            return json(409, {
              error:
                "Working attendance is not allowed because approved leave or Planned Off covers today.",
              attendance: toPublicRecord(existing),
            });
          }
          const covering = await findConfirmedLeaveCoveringDate(
            ddb,
            process.env.WORK_TABLE,
            user.email,
            todayKey
          );
          if (covering) {
            return json(409, {
              error:
                "Working attendance is not allowed because approved leave or Planned Off covers today.",
            });
          }
        }
        if (isEmployeeLocked(existing)) {
          return json(409, {
            error: "Today's attendance has already been submitted.",
            attendance: toPublicRecord(existing),
          });
        }
        const reason =
          status === "Leave"
            ? "Leave"
            : status === "Holiday"
              ? "Holiday"
              : null;

        let snapshot = null;
        if (working) {
          const workPeriod = resolveWorkPeriod(entry);
          if (!workPeriod) {
            return json(400, {
              error: "Please select Full Day, First Half, or Second Half.",
            });
          }
          const assignment = await loadCurrentAssignedShift(
            ddb,
            process.env.WORK_TABLE,
            user.email
          );
          if (!assignment) {
            return json(400, {
              error:
                "No shift is assigned. Ask an admin to assign your shift before marking Working attendance.",
            });
          }
          const eligibility = workPeriodEligibility(assignment, workPeriod);
          if (!eligibility.ok) {
            return json(400, { error: eligibility.error });
          }
          snapshot = buildWorkingAttendanceShift(assignment, {
            dateKey: todayKey,
            workPeriod,
            submittedMs,
          });
          if (!snapshot) {
            return json(400, {
              error: "Assigned shift times are invalid.",
            });
          }
        }

        // Compatibility only: expected window for scheduler fallback, not punches.
        const checkInTime = working
          ? snapshot.checkInTime
          : existing?.checkInTime || null;
        const checkOutTime = working
          ? snapshot.checkOutTime
          : existing?.checkOutTime || null;
        const dayType = working ? snapshot.dayType : null;
        const shift = working ? snapshot.shift : null;

        let sessionStatus = existing?.sessionStatus || null;
        if (working) {
          sessionStatus = "Present";
        } else if (!sessionStatus) {
          sessionStatus = status;
        }

        let workingTime = existing?.workingTime || null;
        let workingSeconds = existing?.workingSeconds ?? null;
        let hours = existing?.hours ?? null;
        if (working && checkInTime && checkOutTime) {
          const computed = formatWorkingTime(checkInTime, checkOutTime);
          workingTime = computed.workingTime;
          workingSeconds = computed.workingSeconds;
          hours = computed.hours;
        }

        const item = {
          PK: user.email,
          SK: todayKey,
          email: user.email,
          date: todayKey,
          attendanceId: existing?.attendanceId || randomUUID(),
          employeeId: existing?.employeeId || profile.employeeId,
          employeeName: existing?.employeeName || profile.employeeName,
          status,
          dayType: working ? dayType : null,
          shift: working ? shift : null,
          reason,
          submittedAt: nowIso,
          sessionStatus,
          checkInTime,
          checkOutTime,
          workingTime,
          workingSeconds,
          hours,
          createdAt: existing?.createdAt || nowIso,
          updatedAt: nowIso,
          ...(working
            ? {
                shiftId: snapshot.shiftId,
                shiftName: snapshot.shiftName,
                expectedStartTime: snapshot.expectedStartTime,
                expectedEndTime: snapshot.expectedEndTime,
                graceMinutes: snapshot.graceMinutes,
                crossesMidnight: snapshot.crossesMidnight,
                workPeriod: snapshot.workPeriod,
                timeSource: snapshot.timeSource,
                attendanceSubmittedAt: snapshot.attendanceSubmittedAt,
                timingStatus: snapshot.timingStatus,
                lateMinutes: snapshot.lateMinutes,
              }
            : {}),
          ...buildDateKeys(
            todayKey,
            checkInTime || nowIso,
            user.email
          ),
        };

        try {
          await putFirstEmployeeSubmission(item);
        } catch (err) {
          if (isConditionalCheckFailed(err)) {
            const locked = await getDayRecord(user.email, todayKey);
            return json(409, {
              error: "Today's attendance has already been submitted.",
              attendance: toPublicRecord(locked),
            });
          }
          throw err;
        }

        return json(200, {
          message: "Attendance saved",
          attendance: toPublicRecord(item),
        });
      }

      return json(200, { message: "Attendance saved" });
    }

    if (method === "GET") {
      const qs = event.queryStringParameters || {};
      const { startDate, endDate } = qs;
      if (!startDate || !endDate) {
        return json(400, { error: "startDate and endDate required" });
      }

      const email =
        user.isAdmin && qs.email
          ? String(qs.email).trim().toLowerCase()
          : user.email;

      const result = await ddb.send(
        new QueryCommand({
          TableName: process.env.ATTENDANCE_TABLE,
          KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
          ExpressionAttributeValues: {
            ":pk": email,
            ":start": startDate,
            ":end": endDate,
          },
        })
      );

      const attendance = (result.Items || []).map((item) => ({
        date: item.SK || item.date,
        status: item.status || null,
        hours: item.hours ?? null,
        dayType: item.dayType || null,
        shift: item.shift || null,
        reason: item.reason || null,
        submittedAt: item.submittedAt || null,
        checkInTime: item.checkInTime || null,
        checkOutTime: item.checkOutTime || null,
        workingTime: item.workingTime || null,
        workingSeconds: item.workingSeconds ?? null,
        sessionStatus: item.sessionStatus || null,
        attendanceId: item.attendanceId || null,
        employeeId: item.employeeId || null,
        employeeName: item.employeeName || null,
        shiftId: item.shiftId || null,
        shiftName: item.shiftName || null,
        expectedStartTime: item.expectedStartTime || null,
        expectedEndTime: item.expectedEndTime || null,
        graceMinutes: item.graceMinutes ?? null,
        crossesMidnight: item.crossesMidnight ?? null,
        workPeriod: item.workPeriod || null,
        timeSource: item.timeSource || null,
        attendanceSubmittedAt: item.attendanceSubmittedAt || null,
        timingStatus: item.timingStatus || null,
        lateMinutes: item.lateMinutes ?? null,
        actualCheckInTime: item.actualCheckInTime || null,
        actualCheckOutTime: item.actualCheckOutTime || null,
        workedBeyondShift: item.workedBeyondShift ?? null,
        workedBeyondReason: item.workedBeyondReason || null,
      }));

      // Overlay Planned Off / Approved Leave so calendar never shows those days as Absent
      if (process.env.WORK_TABLE) {
        try {
          const leaveRes = await ddb.send(
            new QueryCommand({
              TableName: process.env.WORK_TABLE,
              KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
              ExpressionAttributeValues: {
                ":pk": `USER#${user.email}`,
                ":sk": "LEAVE#",
              },
            })
          );
          const byDate = {};
          attendance.forEach((row) => {
            if (row.date) byDate[row.date] = row;
          });
          const inRange = (key) => key >= startDate && key <= endDate;
          for (const leave of leaveRes.Items || []) {
            const overlayStatus = overlayStatusForConfirmedLeave(leave);
            if (!overlayStatus) continue;
            const from = leave.fromDate || leave.startDate;
            const to = leave.toDate || leave.endDate || from;
            if (!from || !to) continue;
            let t = Date.parse(`${from}T00:00:00Z`);
            const end = Date.parse(`${to}T00:00:00Z`);
            if (!Number.isFinite(t) || !Number.isFinite(end)) continue;
            while (t <= end) {
              const dateKey = new Date(t).toISOString().slice(0, 10);
              if (inRange(dateKey)) {
                const existing = byDate[dateKey];
                if (!existing?.checkInTime && !existing?.submittedAt) {
                  byDate[dateKey] = {
                    ...(existing || { date: dateKey }),
                    date: dateKey,
                    status: overlayStatus,
                  };
                }
              }
              t += 86400000;
            }
          }
          return json(200, Object.values(byDate).sort((a, b) => String(a.date).localeCompare(String(b.date))));
        } catch (overlayErr) {
          console.warn("Leave overlay skipped:", overlayErr);
        }
      }

      return json(200, attendance);
    }

    return json(405, { error: "Method not allowed" });
  } catch (error) {
    console.error("Attendance error:", error);
    return json(500, { error: "Internal server error" });
  }
};

exports.setDocumentClientForTests = (client) => {
  ddb = client;
};

exports.setNowMsForTests = (fn) => {
  nowMs = typeof fn === "function" ? fn : () => Date.now();
};

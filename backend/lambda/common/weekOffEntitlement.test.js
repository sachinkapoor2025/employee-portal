process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.ATTENDANCE_TABLE = "Attendance";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.WORK_TABLE = "WorkTasks";
process.env.AWS_REGION = "ap-south-1";
process.env.COMPANY_TIMEZONE = "Asia/Kolkata";
process.env.COMPANY_TZ_OFFSET = "+05:30";

const assert = require("assert");
const {
  WEEK_OFF_ENTITLEMENT,
  WEEK_OFF_EXHAUSTED_MESSAGE,
  WEEK_OFF_ONE_DATE_MESSAGE,
  getCompanyWeekRange,
  validateSingleWeekOffDate,
  usedWeekOffFromRecords,
  confirmedLeaveDaysInWeek,
  overlappingWeekOffDate,
  overlappingApprovedLeaveDate,
  hasWeekOffUsedInCompanyWeek,
  getWeekOffWeekState,
  consumeWeekOffEntitlement,
  releaseWeekOffClaim,
  weekOffClaimSk,
  buildWeekOffState,
} = require("./weekOffEntitlement");
const { applyTransactWrite, queryStore, isTransactWrite } = require("./memoryTransact");

function createMemoryDdb({ work = {}, attendance = {} } = {}) {
  const puts = [];
  const workStore = { ...work };
  const attendanceStore = { ...attendance };
  return {
    puts,
    workStore,
    attendanceStore,
    send: async (cmd) => {
      const input = cmd.input || {};
      const table = input.TableName;
      if (isTransactWrite(cmd, input)) {
        const written = applyTransactWrite(input, {
          [process.env.ATTENDANCE_TABLE]: attendanceStore,
          [process.env.WORK_TABLE]: workStore,
        });
        puts.push(...written);
        return {};
      }
      if (input.Item) {
        const key = `${input.Item.PK}|${input.Item.SK}`;
        if (table === process.env.ATTENDANCE_TABLE) attendanceStore[key] = { ...input.Item };
        else workStore[key] = { ...input.Item };
        puts.push({ table, item: input.Item });
        return {};
      }
      if (input.KeyConditionExpression) {
        const store =
          table === process.env.ATTENDANCE_TABLE ? attendanceStore : workStore;
        return { Items: queryStore(store, input) };
      }
      if (input.Key) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        const store =
          table === process.env.ATTENDANCE_TABLE ? attendanceStore : workStore;
        if (cmd.constructor?.name === "DeleteCommand") {
          delete store[key];
          return {};
        }
        return { Item: store[key] || null };
      }
      return { Items: [] };
    },
  };
}

function plannedOff(email, date, extra = {}) {
  return {
    PK: `USER#${email}`,
    SK: `LEAVE#wo-${date}`,
    leaveId: `wo-${date}`,
    email,
    fromDate: date,
    toDate: date,
    status: "PLANNED_OFF",
    category: "PLANNED_OFF",
    type: "PLANNED_OFF",
    ...extra,
  };
}

function approvedLeave(email, from, to, extra = {}) {
  return {
    PK: `USER#${email}`,
    SK: `LEAVE#lv-${from}`,
    leaveId: `lv-${from}`,
    email,
    fromDate: from,
    toDate: to,
    status: "APPROVED",
    category: "LEAVE",
    type: "CASUAL",
    ...extra,
  };
}

const EMAIL = "nitesh@mydgv.com";
const WEEK = getCompanyWeekRange("2026-09-30");
assert.deepStrictEqual(WEEK, { weekStart: "2026-09-28", weekEnd: "2026-10-04" });
assert.deepStrictEqual(getCompanyWeekRange("2026-09-28"), WEEK);
assert.deepStrictEqual(getCompanyWeekRange("2026-10-04"), WEEK);
assert.deepStrictEqual(getCompanyWeekRange("2026-10-05"), {
  weekStart: "2026-10-05",
  weekEnd: "2026-10-11",
});

assert.strictEqual(validateSingleWeekOffDate("2026-09-30", "2026-09-30"), null);
assert.strictEqual(validateSingleWeekOffDate("2026-09-30", "2026-10-01"), WEEK_OFF_ONE_DATE_MESSAGE);
assert.strictEqual(validateSingleWeekOffDate("2026-09-30", "2026-09-29"), WEEK_OFF_ONE_DATE_MESSAGE);

{
  const unused = usedWeekOffFromRecords({
    leaves: [],
    attendance: [],
    weekStart: WEEK.weekStart,
    weekEnd: WEEK.weekEnd,
  });
  assert.strictEqual(unused.used, false);
  const state = buildWeekOffState({
    ...WEEK,
    weekOffUsed: false,
    leaveUsed: 0,
  });
  assert.strictEqual(state.weekOffEntitlement, WEEK_OFF_ENTITLEMENT);
  assert.strictEqual(state.weekOffUsed, 0);
  assert.strictEqual(state.weekOffAvailable, 1);
  assert.strictEqual(state.balance, 1);
}

{
  const fromLeave = usedWeekOffFromRecords({
    leaves: [plannedOff(EMAIL, "2026-09-30")],
    attendance: [{ PK: EMAIL, SK: "2026-09-30", date: "2026-09-30", status: "WeeklyOff" }],
    weekStart: WEEK.weekStart,
    weekEnd: WEEK.weekEnd,
  });
  assert.strictEqual(fromLeave.used, true);
  assert.strictEqual(fromLeave.usedSource, "PLANNED_OFF");
}

{
  const fromAttendance = usedWeekOffFromRecords({
    leaves: [],
    attendance: [{ PK: EMAIL, SK: "2026-10-01", date: "2026-10-01", status: "WeeklyOff" }],
    weekStart: WEEK.weekStart,
    weekEnd: WEEK.weekEnd,
  });
  assert.strictEqual(fromAttendance.used, true);
  assert.strictEqual(fromAttendance.usedSource, "WeeklyOff");
}

{
  const cancelled = usedWeekOffFromRecords({
    leaves: [plannedOff(EMAIL, "2026-09-30", { status: "CANCELLED" })],
    attendance: [],
    weekStart: WEEK.weekStart,
    weekEnd: WEEK.weekEnd,
  });
  assert.strictEqual(cancelled.used, false);
}

{
  const previousWeek = usedWeekOffFromRecords({
    leaves: [plannedOff(EMAIL, "2026-09-22")],
    attendance: [{ PK: EMAIL, SK: "2026-09-22", date: "2026-09-22", status: "WeeklyOff" }],
    weekStart: WEEK.weekStart,
    weekEnd: WEEK.weekEnd,
  });
  assert.strictEqual(previousWeek.used, false);
}

{
  assert.strictEqual(
    confirmedLeaveDaysInWeek(
      [approvedLeave(EMAIL, "2026-10-01", "2026-10-02")],
      WEEK.weekStart,
      WEEK.weekEnd
    ),
    2
  );
  assert.strictEqual(
    confirmedLeaveDaysInWeek(
      [
        {
          ...approvedLeave(EMAIL, "2026-10-01", "2026-10-02"),
          status: "PENDING_APPROVAL",
        },
      ],
      WEEK.weekStart,
      WEEK.weekEnd
    ),
    0
  );
  assert.strictEqual(
    confirmedLeaveDaysInWeek(
      [{ ...approvedLeave(EMAIL, "2026-10-01", "2026-10-02"), status: "REJECTED" }],
      WEEK.weekStart,
      WEEK.weekEnd
    ),
    0
  );
  assert.strictEqual(
    confirmedLeaveDaysInWeek(
      [{ ...approvedLeave(EMAIL, "2026-10-01", "2026-10-02"), status: "CANCELLED" }],
      WEEK.weekStart,
      WEEK.weekEnd
    ),
    0
  );
  assert.strictEqual(
    confirmedLeaveDaysInWeek(
      [plannedOff(EMAIL, "2026-10-03")],
      WEEK.weekStart,
      WEEK.weekEnd
    ),
    0
  );
}

{
  const leaveOnly = buildWeekOffState({
    ...WEEK,
    weekOffUsed: false,
    leaveUsed: 2,
  });
  assert.strictEqual(leaveOnly.weekOffAvailable, 1);
  assert.strictEqual(leaveOnly.balance, -1);
  const both = buildWeekOffState({
    ...WEEK,
    weekOffUsed: true,
    leaveUsed: 2,
  });
  assert.strictEqual(both.weekOffAvailable, 0);
  assert.strictEqual(both.balance, -2);
}

assert.strictEqual(
  overlappingWeekOffDate(
    [plannedOff(EMAIL, "2026-09-30")],
    [],
    "2026-09-30",
    "2026-09-30"
  ),
  "2026-09-30"
);
assert.strictEqual(
  overlappingApprovedLeaveDate(
    [approvedLeave(EMAIL, "2026-09-30", "2026-09-30")],
    "2026-09-30"
  ),
  "2026-09-30"
);
assert.strictEqual(
  overlappingWeekOffDate(
    [plannedOff(EMAIL, "2026-10-03")],
    [],
    "2026-10-01",
    "2026-10-04"
  ),
  "2026-10-03"
);

(async () => {
  {
    const ddb = createMemoryDdb();
    const unused = await hasWeekOffUsedInCompanyWeek(
      ddb,
      EMAIL,
      WEEK.weekStart,
      WEEK.weekEnd
    );
    assert.strictEqual(unused.used, false);
    const state = await getWeekOffWeekState(ddb, EMAIL, "2026-09-30");
    assert.strictEqual(state.weekOffAvailable, 1);
    assert.strictEqual(state.weekStart, "2026-09-28");
    assert.strictEqual(state.weekEnd, "2026-10-04");
  }

  {
    const ddb = createMemoryDdb({
      work: {
        [`USER#${EMAIL}|LEAVE#wo-2026-09-30`]: plannedOff(EMAIL, "2026-09-30"),
      },
    });
    const used = await hasWeekOffUsedInCompanyWeek(
      ddb,
      EMAIL,
      WEEK.weekStart,
      WEEK.weekEnd
    );
    assert.strictEqual(used.used, true);
    await assert.rejects(
      () =>
        consumeWeekOffEntitlement(ddb, {
          email: EMAIL,
          dateKey: "2026-10-01",
          source: "WeeklyOff",
        }),
      (err) => err.message === WEEK_OFF_EXHAUSTED_MESSAGE
    );
  }

  {
    const ddb = createMemoryDdb({
      attendance: {
        [`${EMAIL}|2026-10-01`]: {
          PK: EMAIL,
          SK: "2026-10-01",
          date: "2026-10-01",
          status: "WeeklyOff",
        },
      },
    });
    const used = await hasWeekOffUsedInCompanyWeek(
      ddb,
      EMAIL,
      WEEK.weekStart,
      WEEK.weekEnd
    );
    assert.strictEqual(used.used, true);
  }

  {
    const ddb = createMemoryDdb();
    await consumeWeekOffEntitlement(ddb, {
      email: EMAIL,
      dateKey: "2026-09-30",
      source: "PLANNED_OFF",
      leaveId: "wo-1",
      extraPuts: [
        {
          Put: {
            TableName: process.env.WORK_TABLE,
            Item: plannedOff(EMAIL, "2026-09-30", { leaveId: "wo-1", SK: "LEAVE#wo-1" }),
          },
        },
      ],
    });
    const used = await hasWeekOffUsedInCompanyWeek(
      ddb,
      EMAIL,
      WEEK.weekStart,
      WEEK.weekEnd
    );
    assert.strictEqual(used.used, true);
    assert.ok(ddb.attendanceStore[`${EMAIL}|${weekOffClaimSk(WEEK.weekStart)}`]);
    await assert.rejects(
      () =>
        consumeWeekOffEntitlement(ddb, {
          email: EMAIL,
          dateKey: "2026-10-02",
          source: "WeeklyOff",
        }),
      (err) => err.message === WEEK_OFF_EXHAUSTED_MESSAGE
    );
  }

  {
    const ddb = createMemoryDdb();
    const first = consumeWeekOffEntitlement(ddb, {
      email: EMAIL,
      dateKey: "2026-09-30",
      source: "PLANNED_OFF",
      leaveId: "a",
    });
    const second = consumeWeekOffEntitlement(ddb, {
      email: EMAIL,
      dateKey: "2026-10-01",
      source: "WeeklyOff",
    });
    const settled = await Promise.allSettled([first, second]);
    const fulfilled = settled.filter((row) => row.status === "fulfilled");
    const rejected = settled.filter((row) => row.status === "rejected");
    assert.strictEqual(fulfilled.length, 1);
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].reason.message, WEEK_OFF_EXHAUSTED_MESSAGE);
    assert.strictEqual(
      Object.values(ddb.attendanceStore).filter((row) =>
        String(row.SK || "").startsWith("WEEKOFF#")
      ).length,
      1
    );
  }

  {
    const ddb = createMemoryDdb({
      work: {
        [`USER#${EMAIL}|LEAVE#lv-1`]: approvedLeave(EMAIL, "2026-10-01", "2026-10-02"),
      },
    });
    const state = await getWeekOffWeekState(ddb, EMAIL, "2026-09-30");
    assert.strictEqual(state.weekOffUsed, 0);
    assert.strictEqual(state.weekOffAvailable, 1);
    assert.strictEqual(state.leaveUsed, 2);
    assert.strictEqual(state.balance, -1);
  }

  {
    const ddb = createMemoryDdb();
    await consumeWeekOffEntitlement(ddb, {
      email: EMAIL,
      dateKey: "2026-09-30",
      source: "PLANNED_OFF",
      leaveId: "wo-cancel",
    });
    await releaseWeekOffClaim(ddb, EMAIL, "2026-09-30", "wo-cancel");
    const after = await hasWeekOffUsedInCompanyWeek(
      ddb,
      EMAIL,
      WEEK.weekStart,
      WEEK.weekEnd
    );
    assert.strictEqual(after.used, false);
  }

  {
    const ddb = createMemoryDdb({
      work: {
        [`USER#${EMAIL}|LEAVE#old`]: plannedOff(EMAIL, "2026-09-22"),
      },
    });
    const nextWeek = getCompanyWeekRange("2026-10-05");
    const state = await getWeekOffWeekState(ddb, EMAIL, "2026-10-05");
    assert.strictEqual(state.weekStart, nextWeek.weekStart);
    assert.strictEqual(state.weekOffAvailable, 1);
  }

  console.log("weekOffEntitlement.test.js ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

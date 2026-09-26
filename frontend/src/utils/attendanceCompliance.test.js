import {
  COMPLIANCE,
  attendanceCompliance,
  companyDateTimeMs,
  expectedWindowFromRecordOrShift,
  lateByLabel,
  shiftLabel,
} from "./attendanceCompliance";

const MORNING = {
  name: "Morning Shift",
  startTime: "11:00",
  endTime: "20:00",
  graceMinutes: 5,
  crossesMidnight: false,
};

test("expected by is shift start plus grace", () => {
  const window = expectedWindowFromRecordOrShift({
    dateKey: "2026-09-26",
    shift: MORNING,
  });
  const start = companyDateTimeMs("2026-09-26", "11:00");
  expect(window.startMs).toBe(start);
  expect(window.expectedByMs).toBe(start + 5 * 60 * 1000);
});

test("marked before cutoff is ON TIME", () => {
  const result = attendanceCompliance({
    dateKey: "2026-09-26",
    todayKey: "2026-09-26",
    shift: MORNING,
    record: {
      status: "Working",
      expectedStartTime: "2026-09-26T11:00:00+05:30",
      graceMinutes: 5,
      attendanceSubmittedAt: "2026-09-26T10:58:00+05:30",
    },
  });
  expect(result.status).toBe(COMPLIANCE.ON_TIME);
  expect(result.lateMinutes).toBe(null);
});

test("marked exactly at grace boundary is ON TIME", () => {
  const result = attendanceCompliance({
    dateKey: "2026-09-26",
    todayKey: "2026-09-26",
    record: {
      status: "Working",
      expectedStartTime: "2026-09-26T11:00:00+05:30",
      graceMinutes: 5,
      attendanceSubmittedAt: "2026-09-26T11:05:00+05:30",
    },
  });
  expect(result.status).toBe(COMPLIANCE.ON_TIME);
});

test("marked after cutoff is LATE with delay past expected by", () => {
  const result = attendanceCompliance({
    dateKey: "2026-09-26",
    todayKey: "2026-09-26",
    record: {
      status: "Working",
      expectedStartTime: "2026-09-26T11:00:00+05:30",
      graceMinutes: 5,
      attendanceSubmittedAt: "2026-09-26T11:18:00+05:30",
    },
  });
  expect(result.status).toBe(COMPLIANCE.LATE);
  expect(result.lateMinutes).toBe(13);
  expect(lateByLabel(result.lateMinutes)).toBe("13 min");
});

test("missing attendance on today or past is NOT MARKED", () => {
  const today = attendanceCompliance({
    dateKey: "2026-09-26",
    todayKey: "2026-09-26",
    shift: MORNING,
  });
  expect(today.status).toBe(COMPLIANCE.NOT_MARKED);
  expect(today.expectedByMs).toBeTruthy();

  const past = attendanceCompliance({
    dateKey: "2026-09-25",
    todayKey: "2026-09-26",
    shift: MORNING,
  });
  expect(past.status).toBe(COMPLIANCE.NOT_MARKED);
});

test("future date without a record is UPCOMING, not NOT MARKED", () => {
  const result = attendanceCompliance({
    dateKey: "2026-09-28",
    todayKey: "2026-09-26",
    shift: MORNING,
  });
  expect(result.status).toBe(COMPLIANCE.UPCOMING);
});

test("approved Leave overlay is LEAVE, not NOT MARKED", () => {
  const result = attendanceCompliance({
    dateKey: "2026-09-26",
    todayKey: "2026-09-26",
    leaveLabel: "On Leave",
    shift: MORNING,
  });
  expect(result.status).toBe(COMPLIANCE.LEAVE);
});

test("Planned Off and WeeklyOff are WEEK OFF", () => {
  expect(
    attendanceCompliance({
      dateKey: "2026-09-26",
      todayKey: "2026-09-26",
      leaveLabel: "Planned Off",
    }).status
  ).toBe(COMPLIANCE.WEEK_OFF);
  expect(
    attendanceCompliance({
      dateKey: "2026-09-26",
      todayKey: "2026-09-26",
      record: { status: "WeeklyOff" },
    }).status
  ).toBe(COMPLIANCE.WEEK_OFF);
});

test("Holiday is HOLIDAY", () => {
  expect(
    attendanceCompliance({
      dateKey: "2026-09-26",
      todayKey: "2026-09-26",
      record: { status: "Holiday" },
    }).status
  ).toBe(COMPLIANCE.HOLIDAY);
});

test("employee-specific shift and grace drive expected by", () => {
  const evening = {
    name: "Evening Shift",
    startTime: "17:00",
    endTime: "23:00",
    graceMinutes: 10,
  };
  const window = expectedWindowFromRecordOrShift({
    dateKey: "2026-09-26",
    shift: evening,
  });
  expect(window.expectedByMs).toBe(
    companyDateTimeMs("2026-09-26", "17:00") + 10 * 60 * 1000
  );
  expect(shiftLabel(evening)).toMatch(/Evening Shift/);
  expect(shiftLabel(evening)).toMatch(/5:00 PM/);
});

test("overnight assignment uses previous start when still inside the window", () => {
  const night = {
    name: "Night",
    startTime: "22:00",
    endTime: "06:00",
    graceMinutes: 5,
    crossesMidnight: true,
  };
  const nowMs = companyDateTimeMs("2026-09-27", "01:00");
  const window = expectedWindowFromRecordOrShift({
    dateKey: "2026-09-27",
    shift: night,
    nowMs,
  });
  expect(window.startMs).toBe(companyDateTimeMs("2026-09-26", "22:00"));
});

test("shift label prefers attendance record snapshot over current assignment", () => {
  const result = attendanceCompliance({
    dateKey: "2026-09-26",
    todayKey: "2026-09-26",
    record: {
      status: "Working",
      shiftName: "Morning Shift",
      expectedStartTime: "2026-09-26T11:00:00+05:30",
      expectedEndTime: "2026-09-26T20:00:00+05:30",
      graceMinutes: 5,
      attendanceSubmittedAt: "2026-09-26T10:58:00+05:30",
    },
    shift: {
      name: "Night Shift",
      startTime: "22:00",
      endTime: "07:00",
      graceMinutes: 10,
      crossesMidnight: true,
    },
    useAssignedShiftName: false,
  });
  expect(result.shiftLabel).toMatch(/Morning Shift/);
  expect(result.shiftLabel).not.toMatch(/Night Shift/);
  expect(result.status).toBe(COMPLIANCE.ON_TIME);
});

test("does not describe work duration", () => {
  const result = attendanceCompliance({
    dateKey: "2026-09-26",
    todayKey: "2026-09-26",
    record: {
      status: "Working",
      expectedStartTime: "2026-09-26T11:00:00+05:30",
      expectedEndTime: "2026-09-26T20:00:00+05:30",
      graceMinutes: 5,
      attendanceSubmittedAt: "2026-09-26T11:18:00+05:30",
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/worked/i);
  expect(JSON.stringify(result)).not.toMatch(/duration/i);
});

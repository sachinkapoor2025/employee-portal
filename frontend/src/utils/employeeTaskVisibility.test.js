import {
  compareEmployeeTasks,
  createRequestGate,
  dashboardTaskBuckets,
  employeeStatusCounts,
  employeeZone,
  employeeZoneCounts,
  formatEmployeeDeadline,
  assignmentInPeriod,
  assignmentPeriodRange,
  formatAssignmentPeriod,
  formatEmployeeDueDate,
  groupEmployeeTasks,
  sortEmployeeTasks,
  taskMatchesMyTasksView,
} from "./employeeTaskVisibility";

function task(partial) {
  return {
    taskId: partial.taskId,
    title: partial.title || partial.taskId,
    dueDate: partial.dueDate,
    zone: partial.zone,
    status: partial.status,
    myAssignment: {
      status: partial.status,
      zone: partial.zone,
      ...(partial.dueDate ? { dueDate: partial.dueDate } : {}),
      ...(partial.assignedAt ? { assignedAt: partial.assignedAt } : {}),
    },
    ...partial,
  };
}

test("groups by server zone and keeps tasks with no deadline", () => {
  const rows = [
    task({ taskId: "green", status: "TODO", zone: "GREEN", dueDate: "2099-01-02" }),
    task({ taskId: "none", status: "IN_PROGRESS", zone: "NONE" }),
    task({ taskId: "red", status: "TODO", zone: "RED", dueDate: "2026-11-01T18:30:00.000Z" }),
    task({
      taskId: "review",
      status: "REVIEW",
      zone: "ORANGE",
      dueDate: "2026-11-01T12:00:00.000Z",
    }),
    task({ taskId: "done", status: "DONE", zone: "RED", dueDate: "2026-10-01" }),
  ];
  const groups = groupEmployeeTasks(rows, { zone: "ALL", status: "ALL" });
  expect(groups.map((group) => group.key)).toEqual([
    "RED",
    "ORANGE",
    "GREEN",
    "NONE",
    "DONE",
  ]);
  expect(groups.find((group) => group.key === "ORANGE").tasks.map((row) => row.taskId)).toEqual([
    "review",
  ]);
  expect(groups.find((group) => group.key === "NONE").tasks.map((row) => row.taskId)).toEqual([
    "none",
  ]);
  expect(groups.find((group) => group.key === "DONE").tasks.map((row) => row.taskId)).toEqual([
    "done",
  ]);
});

test("status counts keep REVIEW separate from DONE", () => {
  const counts = employeeStatusCounts([
    task({ taskId: "a", status: "TODO", zone: "GREEN" }),
    task({ taskId: "b", status: "REVIEW", zone: "GREEN" }),
    task({ taskId: "c", status: "DONE", zone: "GREEN" }),
    task({ taskId: "d", status: "BACKLOG", zone: "NONE" }),
  ]);
  expect(counts).toMatchObject({
    ALL: 4,
    TODO: 2,
    REVIEW: 1,
    DONE: 1,
  });
  const zones = employeeZoneCounts([
    task({ taskId: "a", status: "TODO", zone: "GREEN" }),
    task({ taskId: "b", status: "REVIEW", zone: "ORANGE" }),
    task({ taskId: "c", status: "DONE", zone: "GREEN" }),
    task({ taskId: "d", status: "TODO", zone: "NONE" }),
  ]);
  expect(zones).toEqual({ ALL: 3, GREEN: 1, ORANGE: 1, RED: 0, NONE: 1 });
});

test("date-only deadlines sort at Asia/Kolkata end of day and are not recolored", () => {
  const earlier = task({
    taskId: "earlier",
    status: "TODO",
    zone: "RED",
    dueDate: "2026-11-01T10:00:00.000Z",
  });
  const dateOnly = task({
    taskId: "date-only",
    status: "TODO",
    zone: "RED",
    dueDate: "2026-11-01",
  });
  const noZone = task({
    taskId: "server-none",
    status: "TODO",
    zone: "NONE",
    dueDate: "2026-11-01",
  });
  expect(employeeZone(noZone)).toBe("NONE");
  expect(compareEmployeeTasks(dateOnly, earlier)).toBeGreaterThan(0);
  expect(formatEmployeeDeadline("2026-11-01")).toMatch(/1 Nov 2026/i);
  expect(formatEmployeeDeadline("2026-11-01")).toMatch(/11:59/i);
  expect(formatEmployeeDeadline("")).toBe("No deadline");
  const ist = new Date(Date.parse("2026-11-01T23:59:59+05:30"));
  expect(formatEmployeeDeadline("2026-11-01")).toBe(
    new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(ist)
  );
});

test("dashboard buckets do not count REVIEW or DONE as open work", () => {
  const buckets = dashboardTaskBuckets([
    task({ taskId: "open", status: "IN_PROGRESS", zone: "ORANGE", dueDate: "2026-11-02" }),
    task({ taskId: "review", status: "REVIEW", zone: "RED", dueDate: "2026-11-01" }),
    task({ taskId: "done", status: "DONE", zone: "GREEN" }),
    task({ taskId: "none", status: "TODO", zone: "NONE" }),
    task({ taskId: "open", status: "TODO", zone: "GREEN" }),
  ]);
  expect(buckets.actionable.map((row) => row.taskId)).toEqual(["open", "none"]);
  expect(buckets.inReview.map((row) => row.taskId)).toEqual(["review"]);
});

test("an older request id is not the latest", () => {
  const gate = createRequestGate();
  const first = gate.next();
  const second = gate.next();
  expect(gate.isLatest(first)).toBe(false);
  expect(gate.isLatest(second)).toBe(true);
});

test("my tasks view keeps open work, completed work, and no-deadline rows separate", () => {
  const rows = [
    task({ taskId: "todo", status: "TODO", zone: "RED", dueDate: "2026-10-01", projectName: "Alpha" }),
    task({ taskId: "review", status: "REVIEW", zone: "ORANGE", dueDate: "2026-11-01", projectName: "Beta" }),
    task({ taskId: "done", status: "DONE", zone: "GREEN", dueDate: "2026-09-01", projectName: "Alpha" }),
    task({ taskId: "none", status: "TODO", zone: "NONE", projectName: "Alpha" }),
  ];
  expect(rows.filter((row) => taskMatchesMyTasksView(row, { tab: "OPEN" })).map((row) => row.taskId)).toEqual([
    "todo",
    "review",
    "none",
  ]);
  expect(rows.filter((row) => taskMatchesMyTasksView(row, { tab: "DONE" })).map((row) => row.taskId)).toEqual([
    "done",
  ]);
  expect(
    rows.filter((row) => taskMatchesMyTasksView(row, { zone: "NONE", project: "Alpha" })).map((row) => row.taskId)
  ).toEqual(["none"]);
  expect(sortEmployeeTasks(rows).map((row) => row.taskId)).toEqual(["todo", "review", "none", "done"]);
  expect(sortEmployeeTasks(rows, "latest").map((row) => row.taskId)).toEqual([
    "review",
    "todo",
    "done",
    "none",
  ]);
  expect(formatEmployeeDueDate("2026-11-01")).toMatch(/01 Nov 2026/);
  expect(formatEmployeeDueDate("")).toBe("No deadline");
});

test("assignment periods use Asia/Kolkata days and ignore created or due dates", () => {
  const now = Date.parse("2026-11-02T12:00:00+05:30");
  const last7 = assignmentPeriodRange("LAST_7", { now });
  const thisMonth = assignmentPeriodRange("THIS_MONTH", { now });
  const lastMonth = assignmentPeriodRange("LAST_MONTH", { now });
  const custom = assignmentPeriodRange("CUSTOM", {
    now,
    start: "2026-10-01",
    end: "2026-10-31",
  });
  const weekStart = task({
    taskId: "week",
    status: "TODO",
    assignedAt: "2026-10-26T18:30:00.000Z",
  });
  const beforeWeek = task({
    taskId: "before",
    status: "TODO",
    assignedAt: "2026-10-26T18:29:59.999Z",
  });
  const monthStart = task({
    taskId: "nov",
    status: "TODO",
    assignedAt: "2026-10-31T18:30:00.000Z",
  });
  const monthEnd = task({
    taskId: "oct-end",
    status: "DONE",
    assignedAt: "2026-10-31T18:29:59.999Z",
  });
  const nextMonth = task({
    taskId: "dec",
    status: "TODO",
    assignedAt: "2026-11-30T18:30:00.000Z",
  });
  const missing = task({
    taskId: "missing",
    status: "TODO",
    createdAt: "2026-11-02T00:00:00.000Z",
    dueDate: "2026-11-02",
  });

  expect(formatAssignmentPeriod(last7)).toBe("Oct 27–Nov 2, 2026");
  expect(formatAssignmentPeriod(thisMonth)).toBe("Nov 1–30, 2026");
  expect(formatAssignmentPeriod(lastMonth)).toBe("Oct 1–31, 2026");
  expect(formatAssignmentPeriod(custom)).toBe("Oct 1–31, 2026");
  expect(assignmentPeriodRange("ALL", { now })).toBeNull();
  expect(
    [weekStart, beforeWeek, monthStart, monthEnd, nextMonth, missing]
      .filter((row) => assignmentInPeriod(row, last7))
      .map((row) => row.taskId)
  ).toEqual(["week", "nov", "oct-end"]);
  expect(
    [weekStart, beforeWeek, monthStart, monthEnd, nextMonth, missing]
      .filter((row) => assignmentInPeriod(row, thisMonth))
      .map((row) => row.taskId)
  ).toEqual(["nov"]);
  expect(
    [weekStart, beforeWeek, monthStart, monthEnd, nextMonth, missing]
      .filter((row) => assignmentInPeriod(row, lastMonth))
      .map((row) => row.taskId)
  ).toEqual(["week", "before", "oct-end"]);
  expect(
    [weekStart, monthEnd, missing].filter((row) => assignmentInPeriod(row, null)).map((row) => row.taskId)
  ).toEqual(["week", "oct-end", "missing"]);
  expect(assignmentInPeriod(missing, thisMonth)).toBe(false);

  const january = Date.parse("2026-01-01T00:30:00+05:30");
  expect(formatAssignmentPeriod(assignmentPeriodRange("LAST_MONTH", { now: january }))).toBe(
    "Dec 1–31, 2025"
  );
  expect(formatAssignmentPeriod(assignmentPeriodRange("LAST_7", { now: january }))).toBe(
    "Dec 26, 2025–Jan 1, 2026"
  );
  const yearEnd = task({
    taskId: "year-end",
    status: "TODO",
    assignedAt: "2025-12-31T18:29:59.999Z",
  });
  const newYear = task({
    taskId: "new-year",
    status: "TODO",
    assignedAt: "2025-12-31T18:30:00.000Z",
  });
  expect(assignmentInPeriod(yearEnd, assignmentPeriodRange("LAST_MONTH", { now: january }))).toBe(true);
  expect(assignmentInPeriod(newYear, assignmentPeriodRange("LAST_MONTH", { now: january }))).toBe(false);
  expect(assignmentInPeriod(newYear, assignmentPeriodRange("THIS_MONTH", { now: january }))).toBe(true);
  expect(assignmentInPeriod(yearEnd, assignmentPeriodRange("LAST_7", { now: january }))).toBe(true);
  expect(
    assignmentPeriodRange("CUSTOM", { start: "2026-11-02", end: "2026-11-01" }).invalid
  ).toBe(true);
  expect(
    assignmentPeriodRange("CUSTOM", { start: "2026-02-31", end: "2026-03-01" }).pending
  ).toBe(true);
});

import {
  isVisibleEmployeeTaskActivity,
  filterEmployeeTaskActivity,
} from "./taskActivityFilter";

const PRIYA = "priya@mydgv.com";
const LEAD = "rahul@mydgv.com";

test("own assignmentEmail events are visible", () => {
  expect(
    isVisibleEmployeeTaskActivity(
      { assignmentEmail: PRIYA, detail: "mine" },
      PRIYA
    )
  ).toBe(true);
});

test("another employee's assignmentEmail events are hidden", () => {
  expect(
    isVisibleEmployeeTaskActivity(
      { assignmentEmail: LEAD, detail: "theirs" },
      PRIYA
    )
  ).toBe(false);
});

test("events without assignmentEmail remain visible as task-wide", () => {
  expect(
    isVisibleEmployeeTaskActivity(
      { action: "task_created", detail: "created" },
      PRIYA
    )
  ).toBe(true);
  expect(
    isVisibleEmployeeTaskActivity(
      { action: "deadline_changed", assignmentEmail: "" },
      PRIYA
    )
  ).toBe(true);
});

test("filterEmployeeTaskActivity drops other-assignee rows only", () => {
  const rows = [
    { detail: "created" },
    { detail: "mine", assignmentEmail: PRIYA },
    { detail: "theirs", assignmentEmail: LEAD },
    { detail: "deadline", assignmentEmail: "  " },
  ];
  expect(filterEmployeeTaskActivity(rows, PRIYA).map((row) => row.detail)).toEqual([
    "created",
    "mine",
    "deadline",
  ]);
});

function normalizeActivityEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function isVisibleEmployeeTaskActivity(event, employeeEmail) {
  const assigned = normalizeActivityEmail(event?.assignmentEmail);
  if (!assigned) return true;
  return assigned === normalizeActivityEmail(employeeEmail);
}

export function filterEmployeeTaskActivity(events, employeeEmail) {
  return (Array.isArray(events) ? events : []).filter((event) =>
    isVisibleEmployeeTaskActivity(event, employeeEmail)
  );
}

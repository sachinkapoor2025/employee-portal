export function normalizeDepartmentNameKey(name) {
  return String(name || "")
    .trim()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function departmentIdsOf(user) {
  return Array.isArray(user?.departmentIds)
    ? user.departmentIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
}

export function summarizeDepartments(user, catalog) {
  const ids = departmentIdsOf(user);
  const byId = new Map((catalog || []).map((row) => [row.departmentId, row]));
  const memberships = ids.map((id) => {
    const row = byId.get(id);
    return {
      departmentId: id,
      name: row?.name || id,
      status: row?.status || "MISSING",
    };
  });
  const primary = String(user?.primaryDepartmentId || "").trim();
  const legacy = String(user?.department || "").trim();
  const legacyKey = normalizeDepartmentNameKey(legacy);
  const represented =
    memberships.some((row) => normalizeDepartmentNameKey(row.name) === legacyKey) ||
    (catalog || []).some(
      (row) => normalizeDepartmentNameKey(row.name) === legacyKey
    );
  return {
    memberships,
    primaryDepartmentId: ids.includes(primary) ? primary : ids[0] || "",
    legacyUnmatched: legacy && !represented ? legacy : "",
  };
}

export function formatDepartmentList(user, catalog) {
  const summary = summarizeDepartments(user, catalog);
  if (!summary.memberships.length) {
    const legacy = String(user?.department || "").trim();
    return legacy ? [legacy] : [];
  }
  const names = summary.memberships.map((row) => {
    const primary =
      summary.memberships.length > 1 &&
      row.departmentId === summary.primaryDepartmentId
        ? " (primary)"
        : "";
    const inactive =
      String(row.status).toUpperCase() === "ACTIVE" ? "" : " (inactive)";
    return `${row.name}${primary}${inactive}`;
  });
  if (summary.legacyUnmatched) {
    names.push(`${summary.legacyUnmatched} (unmatched)`);
  }
  return names;
}

export function departmentFilterOptions(users, catalog) {
  const options = (catalog || [])
    .map((row) => ({ value: row.departmentId, label: row.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const extras = new Set();
  for (const user of users || []) {
    const summary = summarizeDepartments(user, catalog);
    if (summary.legacyUnmatched && departmentIdsOf(user).length === 0) {
      extras.add(summary.legacyUnmatched);
    }
  }
  for (const text of [...extras].sort()) {
    options.push({ value: `legacy:${text}`, label: `${text} (unmatched)` });
  }
  return options;
}

export function employeeMatchesDepartmentFilter(user, filter, catalog) {
  if (!filter) return true;
  if (String(filter).startsWith("legacy:")) {
    const text = String(filter).slice("legacy:".length);
    const summary = summarizeDepartments(user, catalog);
    return (
      summary.legacyUnmatched === text && departmentIdsOf(user).length === 0
    );
  }
  const ids = departmentIdsOf(user);
  if (ids.includes(filter)) return true;
  if (ids.length) return false;
  const department = (catalog || []).find((row) => row.departmentId === filter);
  if (!department) return false;
  return (
    normalizeDepartmentNameKey(user?.department) ===
    normalizeDepartmentNameKey(department.name)
  );
}

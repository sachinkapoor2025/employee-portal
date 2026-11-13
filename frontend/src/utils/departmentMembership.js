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
  return {
    memberships,
    primaryDepartmentId: ids.includes(primary) ? primary : ids[0] || "",
  };
}

export function formatDepartmentList(user, catalog) {
  const summary = summarizeDepartments(user, catalog);
  if (!summary.memberships.length) return [];
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
  return names;
}

export function departmentFilterOptions(users, catalog) {
  const byId = new Map((catalog || []).map((row) => [row.departmentId, row]));
  const assignedIds = new Set(
    (users || []).flatMap((user) => departmentIdsOf(user))
  );
  const options = [];
  for (const row of catalog || []) {
    const active = String(row.status || "").toUpperCase() === "ACTIVE";
    if (!active && !assignedIds.has(row.departmentId)) continue;
    options.push({
      value: row.departmentId,
      label: active ? row.name : `${row.name} (inactive)`,
    });
  }
  for (const id of assignedIds) {
    if (byId.has(id)) continue;
    options.push({ value: id, label: `${id} (missing from catalog)` });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

function designationCatalogIds(designationsByDepartment, departmentId) {
  const selected = String(departmentId || "").trim();
  if (selected) return [selected];
  return Object.keys(designationsByDepartment || {});
}

export function designationForDepartment(user, departmentId, designationsByDepartment) {
  const ids = departmentIdsOf(user);
  if (!ids.length) return "—";
  const target =
    String(departmentId || "").trim() || summarizeDepartments(user, []).primaryDepartmentId;
  if (!target || !ids.includes(target)) return "No designation";
  const link = (user?.departmentDesignations || []).find(
    (row) => String(row?.departmentId || "").trim() === target
  );
  const designationId = String(link?.designationId || "").trim();
  if (!designationId) return "No designation";
  const designation = (designationsByDepartment?.[target] || []).find(
    (row) => row?.designationId === designationId
  );
  const name = String(designation?.name || "").trim();
  const owner = String(designation?.departmentId || "").trim();
  if (!designation || !name || (owner && owner !== target)) return "Designation unavailable";
  return String(designation.status || "").toUpperCase() === "ACTIVE"
    ? name
    : "Designation inactive";
}

export function designationFilterOptions(
  users,
  designationsByDepartment,
  { departmentId = "", departments = [] } = {}
) {
  const selected = String(departmentId || "").trim();
  const labels = new Set();
  for (const id of designationCatalogIds(designationsByDepartment, selected)) {
    for (const row of designationsByDepartment?.[id] || []) {
      const name = String(row?.name || "").trim();
      if (name && String(row?.status || "").toUpperCase() === "ACTIVE") {
        labels.add(name);
      }
    }
  }
  for (const user of users || []) {
    if (selected && !employeeMatchesDepartmentFilter(user, selected, departments)) continue;
    const label = designationForDepartment(user, selected, designationsByDepartment);
    if (label && label !== "—") labels.add(label);
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

export function employeeMatchesDesignationFilter(
  user,
  filter,
  designationsByDepartment,
  departmentId = ""
) {
  if (!filter) return true;
  return designationForDepartment(user, departmentId, designationsByDepartment) === filter;
}

export function employeeMatchesSearch(user, query, catalog, designationsByDepartment) {
  const text = String(query || "").trim().toLowerCase();
  if (!text) return true;
  const departments = employeeListDepartments(user, catalog)
    .map((row) => [row.name, row.note].filter(Boolean).join(" "))
    .join(" ");
  const designation = employeeListDesignation(user, designationsByDepartment);
  const hay = [
    user?.name,
    user?.email,
    user?.empId,
    departments,
    designation === "—" ? "" : designation,
    user?.role,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(text);
}

function describedMembership(row) {
  const missing = row.status === "MISSING";
  const inactive = !missing && String(row.status || "").toUpperCase() !== "ACTIVE";
  return {
    name: missing ? row.departmentId : row.name,
    note: missing ? "missing from catalog" : inactive ? "inactive" : "",
  };
}

export function structuredOrgLabels(user, catalog, designationsByDepartment) {
  const department = employeeListDepartments(user, catalog)
    .map((row) => [row.name, row.note].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
  const raw = employeeListDesignation(user, designationsByDepartment);
  const designation = !raw || raw === "—" || raw === "No designation" ? "" : raw;
  return { department, designation };
}

export function employeeListDepartments(user, catalog) {
  const summary = summarizeDepartments(user, catalog);
  if (!summary.memberships.length) return [];
  const main =
    summary.memberships.find((row) => row.departmentId === summary.primaryDepartmentId) ||
    summary.memberships[0];
  const subsidiaries = summary.memberships.filter(
    (row) => row.departmentId !== main.departmentId
  );
  return [
    { kind: "main", label: "Main Department", ...describedMembership(main) },
    ...subsidiaries.map((row, index) => ({
      kind: "subsidiary",
      label:
        subsidiaries.length > 1
          ? `Subsidiary Department ${index + 1}`
          : "Subsidiary Department",
      ...describedMembership(row),
    })),
  ];
}

export function employeeListDesignation(user, designationsByDepartment) {
  return designationForDepartment(user, "", designationsByDepartment);
}

export function employeeMatchesDepartmentFilter(user, filter) {
  if (!filter) return true;
  return departmentIdsOf(user).includes(filter);
}

export function departmentChoices(
  departments,
  assignedIds,
  { includeDepartmentId = "", preserveDepartmentId = "" } = {}
) {
  const assigned = new Set(
    (assignedIds || []).map((id) => String(id || "").trim()).filter(Boolean)
  );
  const currentId = String(includeDepartmentId || "").trim();
  const preservedId = String(preserveDepartmentId || "").trim();
  return (departments || []).filter((row) => {
    const id = String(row?.departmentId || "").trim();
    if (!id) return false;
    const current = Boolean(currentId) && id === currentId;
    if (assigned.has(id) && !current) return false;
    const active = String(row.status || "").toUpperCase() === "ACTIVE";
    if (!active && !current && id !== preservedId) return false;
    return true;
  });
}

function includeDesignation(row) {
  return String(row?.status || "").toUpperCase() === "ACTIVE";
}

export function tracksInDepartment(designations, { preserveTrack = "" } = {}) {
  const tracks = new Map();
  for (const row of designations || []) {
    if (!includeDesignation(row)) continue;
    const track = String(row?.track || "").trim();
    if (!track) continue;
    const sort = Number(row.trackSort) || 0;
    const current = tracks.get(track);
    if (!current || sort < current.sort) tracks.set(track, { track, sort });
  }
  const kept = String(preserveTrack || "").trim();
  if (
    kept &&
    !tracks.has(kept) &&
    (designations || []).some((row) => String(row?.track || "").trim() === kept)
  ) {
    tracks.set(kept, { track: kept, sort: Number.MAX_SAFE_INTEGER });
  }
  return [...tracks.values()]
    .sort((a, b) => a.sort - b.sort || a.track.localeCompare(b.track))
    .map((row) => row.track);
}

export function designationsInTrack(
  designations,
  track,
  { departmentId = "", preserveDesignationId = "" } = {}
) {
  const selectedTrack = String(track || "").trim();
  if (!selectedTrack) return [];
  const preservedId = String(preserveDesignationId || "").trim();
  return (designations || [])
    .filter((row) => {
      const kept = Boolean(preservedId) && row?.designationId === preservedId;
      if (!includeDesignation(row) && !kept) return false;
      if (String(row?.track || "").trim() !== selectedTrack) return false;
      const owner = String(row?.departmentId || "").trim();
      if (departmentId && owner && owner !== departmentId) return false;
      return Boolean(String(row?.name || "").trim());
    })
    .sort(
      (a, b) =>
        (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
        String(a.name).localeCompare(String(b.name))
    );
}

export function isSelectableDesignation(designation, { departmentId, track } = {}) {
  if (!designation) return false;
  const matches = designationsInTrack([designation], track, { departmentId });
  return matches.some((row) => row.designationId === designation.designationId);
}

function isPreservedAssignment(slot) {
  const departmentId = String(slot?.departmentId || "").trim();
  const designationId = String(slot?.designationId || "").trim();
  const track = String(slot?.track || "").trim();
  const preservedDepartmentId = String(slot?.preservedDepartmentId || "").trim();
  const preservedDesignationId = String(slot?.preservedDesignationId || "").trim();
  const preservedTrack = String(slot?.preservedTrack || "").trim();
  if (!departmentId || !designationId || !track) return false;
  if (departmentId !== preservedDepartmentId || designationId !== preservedDesignationId) {
    return false;
  }
  return !preservedTrack || track === preservedTrack;
}

export function buildSavedAssignments(
  main,
  subsidiaries,
  designationsByDepartment,
  departments
) {
  const slots = [main, ...(subsidiaries || [])];
  const departmentIds = [];
  const departmentDesignations = [];
  const seen = new Set();
  for (const slot of slots) {
    const departmentId = String(slot?.departmentId || "").trim();
    const track = String(slot?.track || "").trim();
    const designationId = String(slot?.designationId || "").trim();
    if (!departmentId || !track || !designationId) return { ok: false };
    if (seen.has(departmentId)) return { ok: false };
    const department = (departments || []).find((row) => row.departmentId === departmentId);
    if (!department) return { ok: false };
    const designation = (designationsByDepartment?.[departmentId] || []).find(
      (row) => row.designationId === designationId
    );
    const preserved = isPreservedAssignment(slot);
    if (preserved) {
      if (designation) {
        const owner = String(designation.departmentId || "").trim();
        const designationTrack = String(designation.track || "").trim();
        if (owner && owner !== departmentId) return { ok: false };
        if (designationTrack && designationTrack !== track) return { ok: false };
      }
    } else if (
      String(department.status || "").toUpperCase() !== "ACTIVE" ||
      !isSelectableDesignation(designation, { departmentId, track })
    ) {
      return { ok: false };
    }
    seen.add(departmentId);
    departmentIds.push(departmentId);
    departmentDesignations.push({ departmentId, designationId });
  }
  if (!departmentIds.length) return { ok: false };
  return {
    ok: true,
    departmentIds,
    primaryDepartmentId: departmentIds[0],
    departmentDesignations,
  };
}

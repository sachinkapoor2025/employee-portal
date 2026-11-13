import { summarizeDepartments } from "./departmentMembership";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatJoiningDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!match) return text;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day);
  if (
    month < 1 ||
    month > 12 ||
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return text;
  }
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

function catalogDesignationFor(profile, departmentId, designationsByDepartment) {
  const links = Array.isArray(profile?.departmentDesignations)
    ? profile.departmentDesignations
    : [];
  const link = links.find(
    (item) => String(item?.departmentId || "").trim() === departmentId
  );
  const designationId = String(link?.designationId || "").trim();
  if (!designationId) return null;
  const designation = (designationsByDepartment?.[departmentId] || []).find(
    (item) => item?.designationId === designationId
  );
  if (!designation) return null;
  const owner = String(designation.departmentId || "").trim();
  if (owner && owner !== departmentId) return null;
  const name = String(designation.name || "").trim();
  if (!name) return null;
  return {
    name,
    track: String(designation.track || "").trim(),
  };
}

export function formatDepartmentValue(membership) {
  const name = String(membership?.departmentName || "").trim();
  if (!name) return "";
  const notes = [];
  if (membership.isPrimary) notes.push("Primary");
  if (String(membership.status || "").toUpperCase() !== "ACTIVE") {
    notes.push("Inactive");
  }
  return [name, ...notes].join(" · ");
}

function roleDesignation(memberships) {
  const primary = memberships.find((row) => row.isPrimary && row.designation);
  if (primary) return primary.designation;
  const first = memberships.find((row) => row.designation);
  return first ? first.designation : "";
}

export function buildEmployeeWorkView(
  profile,
  departments,
  designationsByDepartment
) {
  const summary = summarizeDepartments(profile || {}, departments || []);
  const memberships = summary.memberships.map((row) => {
    const catalog = catalogDesignationFor(
      profile,
      row.departmentId,
      designationsByDepartment
    );
    return {
      departmentId: row.departmentId,
      departmentName: row.name,
      status: row.status,
      isPrimary:
        summary.memberships.length > 1 &&
        row.departmentId === summary.primaryDepartmentId,
      designation: catalog?.name || "",
      track: catalog?.track || "",
    };
  });
  const hasCatalogDesignation = memberships.some((row) => row.designation);
  return {
    memberships,
    hasCatalogDesignation,
    legacyDesignation: "",
    legacyDepartment: "",
    joiningDate: formatJoiningDate(profile?.doj),
    roleDesignation: roleDesignation(memberships),
  };
}

export function employmentFieldGroups(view) {
  const joining = {
    key: "doj",
    label: "Date of Joining",
    value: view.joiningDate,
  };

  if (!view.memberships.length) return [[joining]];

  if (view.memberships.length === 1) {
    const row = view.memberships[0];
    const fields = [
      {
        key: "department",
        label: "Department",
        value: formatDepartmentValue(row),
      },
    ];
    if (row.designation) {
      fields.push({
        key: "designation",
        label: "Designation",
        value: row.designation,
      });
    }
    if (row.track) {
      fields.push({ key: "track", label: "Track", value: row.track });
    }
    fields.push(joining);
    return [fields];
  }

  const groups = view.memberships.map((row) => {
    const fields = [
      {
        key: `department-${row.departmentId}`,
        label: "Department",
        value: formatDepartmentValue(row),
      },
    ];
    if (view.hasCatalogDesignation) {
      fields.push({
        key: `designation-${row.departmentId}`,
        label: "Designation",
        value: row.designation,
      });
    }
    if (row.track) {
      fields.push({
        key: `track-${row.departmentId}`,
        label: "Track",
        value: row.track,
      });
    }
    return fields;
  });
  const tail = [joining];
  groups.push(tail);
  return groups;
}

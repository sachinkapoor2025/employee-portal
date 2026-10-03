const PROJECT_TYPE_INTERNAL = "INTERNAL";
const PROJECT_TYPE_EXTERNAL = "EXTERNAL";
const PROJECT_TYPES = [PROJECT_TYPE_INTERNAL, PROJECT_TYPE_EXTERNAL];
const PROJECT_CODE_ENTITY_PK = "ENTITY#PROJECT_CODE";
const TYPE_PROJECT_CODE = "PROJECT_CODE";
const CODE_ALREADY_EXISTS =
  "A project with this code already exists. Choose a different project name.";
const CODE_ALREADY_EXISTS_CLASSIFY =
  "A project with this code already exists. Choose a different project code.";
const TYPE_AND_CODE_LOCKED = "Project type and code cannot be changed.";
const INVALID_PROJECT_TYPE = "Invalid projectType";
const PROJECT_TYPE_REQUIRED = "projectType is required";
const INVALID_PROJECT_CODE = "Invalid projectCode";
const CODE_PREFIX_MISMATCH = "projectCode prefix does not match projectType";
const UNABLE_TO_GENERATE_CODE =
  "Unable to generate a project code from this name. Choose a different project name.";

const CODE_BODY_RE = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

function normalizeProjectType(raw) {
  const value = String(raw || "")
    .trim()
    .toUpperCase();
  if (value === PROJECT_TYPE_INTERNAL || value === PROJECT_TYPE_EXTERNAL) {
    return value;
  }
  return "";
}

function parseProjectType(raw, { required = false } = {}) {
  if (raw == null || String(raw).trim() === "") {
    if (required) return { ok: false, error: PROJECT_TYPE_REQUIRED };
    return { ok: true, value: "" };
  }
  const value = normalizeProjectType(raw);
  if (!value) return { ok: false, error: INVALID_PROJECT_TYPE };
  return { ok: true, value };
}

function typeSegment(type) {
  const value = normalizeProjectType(type);
  if (value === PROJECT_TYPE_INTERNAL) return "INT";
  if (value === PROJECT_TYPE_EXTERNAL) return "EXT";
  return "";
}

function slugifyProjectName(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function generateProjectCode(type, name) {
  const normalizedType = normalizeProjectType(type);
  const segment = typeSegment(normalizedType);
  const slug = slugifyProjectName(name);
  if (!normalizedType || !segment || !slug) return "";
  return `DGV-${segment}-${slug}`;
}

function expectedPrefix(type) {
  const segment = typeSegment(type);
  return segment ? `DGV-${segment}-` : "";
}

function normalizeProjectCodeInput(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase();
}

function isValidProjectCodeShape(code) {
  const value = String(code || "");
  const parts = value.split("-");
  if (parts.length < 3) return false;
  if (parts[0] !== "DGV") return false;
  if (parts[1] !== "INT" && parts[1] !== "EXT") return false;
  const slug = parts.slice(2).join("-");
  return CODE_BODY_RE.test(slug);
}

function parseProjectCode(raw, type) {
  const value = normalizeProjectCodeInput(raw);
  if (!value) return { ok: false, error: INVALID_PROJECT_CODE };
  if (!isValidProjectCodeShape(value)) {
    return { ok: false, error: INVALID_PROJECT_CODE };
  }
  const prefix = expectedPrefix(type);
  if (!prefix || !value.startsWith(prefix)) {
    return { ok: false, error: CODE_PREFIX_MISMATCH };
  }
  return { ok: true, value };
}

function resolveProjectCode({ type, name, manualCode } = {}) {
  const normalizedType = normalizeProjectType(type);
  if (!normalizedType) return { ok: false, error: INVALID_PROJECT_TYPE };
  if (manualCode != null && String(manualCode).trim() !== "") {
    return parseProjectCode(manualCode, normalizedType);
  }
  const generated = generateProjectCode(normalizedType, name);
  if (!generated) return { ok: false, error: UNABLE_TO_GENERATE_CODE };
  return { ok: true, value: generated };
}

function isProjectClassified(project) {
  const type = normalizeProjectType(project?.projectType);
  const code = String(project?.projectCode || "").trim();
  return Boolean(type && code);
}

function projectCodePointerKey(projectCode) {
  return {
    PK: PROJECT_CODE_ENTITY_PK,
    SK: `CODE#${projectCode}`,
  };
}

function projectCodePointerItem({ projectCode, projectId, projectType }) {
  return {
    ...projectCodePointerKey(projectCode),
    type: TYPE_PROJECT_CODE,
    projectCode,
    projectId,
    projectType,
  };
}

function decorateProject(project) {
  if (!project) return project;
  const classified = isProjectClassified(project);
  return {
    ...project,
    projectType: classified ? normalizeProjectType(project.projectType) : null,
    projectCode: classified ? String(project.projectCode).trim() : null,
    classified,
  };
}

function cancellationFailedAt(result, index) {
  const reasons = result?.cancellationReasons || [];
  const code = String(reasons[index]?.Code || reasons[index]?.code || "");
  return code === "ConditionalCheckFailed";
}

function txErrorLooksLikeCondition(err) {
  const name = String(err?.name || "");
  if (name === "ConditionalCheckFailedException") return true;
  if (name !== "TransactionCanceledException") return false;
  const reasons = err.CancellationReasons || err.cancellationReasons || [];
  return reasons.some(
    (row) => String(row?.Code || row?.code || "") === "ConditionalCheckFailed"
  );
}

function duplicateCodeResponse({ classify = false } = {}) {
  return {
    statusCode: 409,
    body: {
      error: classify ? CODE_ALREADY_EXISTS_CLASSIFY : CODE_ALREADY_EXISTS,
    },
  };
}

module.exports = {
  PROJECT_TYPE_INTERNAL,
  PROJECT_TYPE_EXTERNAL,
  PROJECT_TYPES,
  PROJECT_CODE_ENTITY_PK,
  TYPE_PROJECT_CODE,
  CODE_ALREADY_EXISTS,
  CODE_ALREADY_EXISTS_CLASSIFY,
  TYPE_AND_CODE_LOCKED,
  INVALID_PROJECT_TYPE,
  PROJECT_TYPE_REQUIRED,
  INVALID_PROJECT_CODE,
  CODE_PREFIX_MISMATCH,
  UNABLE_TO_GENERATE_CODE,
  normalizeProjectType,
  parseProjectType,
  typeSegment,
  slugifyProjectName,
  generateProjectCode,
  parseProjectCode,
  resolveProjectCode,
  isProjectClassified,
  projectCodePointerKey,
  projectCodePointerItem,
  decorateProject,
  cancellationFailedAt,
  txErrorLooksLikeCondition,
  duplicateCodeResponse,
};

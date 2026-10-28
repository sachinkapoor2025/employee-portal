const { randomUUID } = require("crypto");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { requireSuperAdmin } = require("./portalAdminAuth");
const { normalizeEmail } = require("./projectAccess");
const {
  OWNER_DESIGNATION,
  OWNER_EMPLOYEE,
  listRateVersions,
  pickEffectiveVersion,
  versionsOrCatalog,
  versionPutsForMutation,
} = require("./costRateVersions");

const DESIGNATION_ENTITY_PK = "ENTITY#DESIGNATION";
const DESIGNATION_NAME_PK = "ENTITY#DESIGNATION_NAME";
const TYPE_DESIGNATION = "DESIGNATION";
const TYPE_DESIGNATION_NAME = "DESIGNATION_NAME";
const TYPE_EMPLOYEE_COST_RATES = "EMPLOYEE_COST_RATES";
const COST_RATES_SK = "COST_RATES";
const STATUS_ACTIVE = "ACTIVE";
const STATUS_INACTIVE = "INACTIVE";
const NAME_MAX = 80;
const RATE_INVALID =
  "Hourly rate must be a finite positive number in USD with at most two decimal places.";
const NAME_REQUIRED = "Designation name is required.";
const NAME_DUPLICATE = "A designation with this name already exists.";
const STATUS_INVALID = "Status must be ACTIVE or INACTIVE.";
const PROJECT_INTERNAL = "INTERNAL";
const PROJECT_EXTERNAL = "EXTERNAL";

const SOURCE_EMPLOYEE = "EMPLOYEE";
const SOURCE_DESIGNATION = "DESIGNATION";
const SOURCE_NONE = null;

const REASON = {
  EMPLOYEE_OVERRIDE: "EMPLOYEE_OVERRIDE",
  DESIGNATION_FALLBACK: "DESIGNATION_FALLBACK",
  NO_EMPLOYEE_RECORD: "NO_EMPLOYEE_RECORD",
  EMPLOYEE_INACTIVE: "EMPLOYEE_INACTIVE",
  DESIGNATION_MISSING: "DESIGNATION_MISSING",
  DESIGNATION_INACTIVE: "DESIGNATION_INACTIVE",
  RATE_UNSET: "RATE_UNSET",
  RATE_INVALID: "RATE_INVALID",
  UNCLASSIFIED_PROJECT: "UNCLASSIFIED_PROJECT",
  HISTORICAL_DESIGNATION_UNKNOWN: "HISTORICAL_DESIGNATION_UNKNOWN",
};

const PATH_INVALID = "Invalid path parameter.";
const NAME_POINTER_CONFLICT = "Conflict";

function normalizePath(path) {
  return String(path || "").replace(/\/+$/, "");
}

function decodePathSegment(raw) {
  try {
    return { ok: true, value: decodeURIComponent(String(raw)) };
  } catch {
    return { ok: false, malformed: true };
  }
}

function pathMatchResult(raw, { email = false } = {}) {
  const decoded = decodePathSegment(raw);
  if (!decoded.ok) return { malformed: true };
  if (email) {
    const value = normalizeEmail(decoded.value);
    return value ? { value } : null;
  }
  const value = decoded.value.trim();
  return value ? { value } : null;
}

function designationsListPathMatch(path) {
  return /\/admin\/cost-rates\/designations$/.test(normalizePath(path));
}

function designationIdPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  if (/\/status$/.test(normalized)) return null;
  const fromParams = pathParameters?.id ? String(pathParameters.id) : "";
  if (fromParams && /\/admin\/cost-rates\/designations\/[^/]+$/.test(normalized)) {
    return pathMatchResult(fromParams);
  }
  const match = normalized.match(/\/admin\/cost-rates\/designations\/([^/]+)$/);
  if (!match) return null;
  return pathMatchResult(match[1]);
}

function designationStatusPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  const fromParams = pathParameters?.id ? String(pathParameters.id) : "";
  if (
    fromParams &&
    /\/admin\/cost-rates\/designations\/[^/]+\/status$/.test(normalized)
  ) {
    return pathMatchResult(fromParams);
  }
  const match = normalized.match(
    /\/admin\/cost-rates\/designations\/([^/]+)\/status$/
  );
  if (!match) return null;
  return pathMatchResult(match[1]);
}

function employeesListPathMatch(path) {
  return /\/admin\/cost-rates\/employees$/.test(normalizePath(path));
}

function employeeEmailPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  if (/\/status$/.test(normalized)) return null;
  const fromParams = pathParameters?.email ? String(pathParameters.email) : "";
  if (fromParams && /\/admin\/cost-rates\/employees\/[^/]+$/.test(normalized)) {
    return pathMatchResult(fromParams, { email: true });
  }
  const match = normalized.match(/\/admin\/cost-rates\/employees\/([^/]+)$/);
  if (!match) return null;
  return pathMatchResult(match[1], { email: true });
}

function employeeStatusPathMatch(path, pathParameters) {
  const normalized = normalizePath(path);
  const fromParams = pathParameters?.email ? String(pathParameters.email) : "";
  if (
    fromParams &&
    /\/admin\/cost-rates\/employees\/[^/]+\/status$/.test(normalized)
  ) {
    return pathMatchResult(fromParams, { email: true });
  }
  const match = normalized.match(
    /\/admin\/cost-rates\/employees\/([^/]+)\/status$/
  );
  if (!match) return null;
  return pathMatchResult(match[1], { email: true });
}

function designationSk(id) {
  return `DESIGNATION#${id}`;
}

function designationNameSk(nameKey) {
  return `NAME#${nameKey}`;
}

function userPk(email) {
  return `USER#${email}`;
}

function profileSk() {
  return "PROFILE";
}

function displayDesignationName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeDesignationNameKey(name) {
  return displayDesignationName(name).toLowerCase();
}

function isBlankRate(raw) {
  if (raw == null) return true;
  if (typeof raw === "string" && !raw.trim()) return true;
  return false;
}

function isValidPositiveRate(value) {
  if (typeof value !== "number") return false;
  if (!Number.isFinite(value) || value <= 0) return false;
  const cents = value * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-8;
}

function parseHourlyRate(raw) {
  if (isBlankRate(raw)) return { ok: true, value: null };
  if (typeof raw === "number") {
    if (!isValidPositiveRate(raw)) {
      return { ok: false, error: RATE_INVALID };
    }
    return { ok: true, value: Math.round(raw * 100) / 100 };
  }
  const text = String(raw).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: RATE_INVALID };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: RATE_INVALID };
  }
  return { ok: true, value: n };
}

function parseStatus(raw, { required = true } = {}) {
  if (raw == null || (typeof raw === "string" && !raw.trim())) {
    if (required) return { ok: false, error: STATUS_INVALID };
    return { ok: true, value: undefined };
  }
  const status = String(raw).trim().toUpperCase();
  if (status !== STATUS_ACTIVE && status !== STATUS_INACTIVE) {
    return { ok: false, error: STATUS_INVALID };
  }
  return { ok: true, value: status };
}

function parseDesignationName(raw) {
  const name = displayDesignationName(raw);
  if (!name) return { ok: false, error: NAME_REQUIRED };
  if (name.length > NAME_MAX) {
    return { ok: false, error: `Designation name must be at most ${NAME_MAX} characters.` };
  }
  return { ok: true, value: name, nameKey: normalizeDesignationNameKey(name) };
}

function transactReasons(err) {
  return err?.CancellationReasons || err?.cancellationReasons || [];
}

function transactReasonCode(row) {
  return String(row?.Code || row?.code || "");
}

function isSingleConditionalCheckFailed(err) {
  return (
    err?.name === "ConditionalCheckFailedException" ||
    err?.code === "ConditionalCheckFailedException"
  );
}

function transactConditionFailedAt(err, index) {
  return transactReasonCode(transactReasons(err)[index]) === "ConditionalCheckFailed";
}

function transactHasConditionFailure(err) {
  return transactReasons(err).some(
    (row) => transactReasonCode(row) === "ConditionalCheckFailed"
  );
}

function mapCreateNameTransactError(err) {
  if (isSingleConditionalCheckFailed(err)) {
    return { statusCode: 409, body: { error: NAME_DUPLICATE } };
  }
  if (String(err?.name || "") !== "TransactionCanceledException") return null;
  if (transactConditionFailedAt(err, 1)) {
    return { statusCode: 409, body: { error: NAME_DUPLICATE } };
  }
  if (transactHasConditionFailure(err)) {
    return { statusCode: 409, body: { error: NAME_POINTER_CONFLICT } };
  }
  return { statusCode: 500, body: { error: "Internal server error" } };
}

function mapRenameTransactError(err) {
  if (String(err?.name || "") !== "TransactionCanceledException") return null;
  if (transactConditionFailedAt(err, 0)) {
    return { statusCode: 409, body: { error: NAME_DUPLICATE } };
  }
  if (transactHasConditionFailure(err)) {
    return { statusCode: 409, body: { error: NAME_POINTER_CONFLICT } };
  }
  return { statusCode: 500, body: { error: "Internal server error" } };
}

async function queryAll(ddb, params) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        ...params,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function scanAll(ddb, tableName) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function getDesignationItem(ddb, tableName, designationId) {
  const id = String(designationId || "").trim();
  if (!id) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: DESIGNATION_ENTITY_PK, SK: designationSk(id) },
    })
  );
  return res.Item || null;
}

async function getEmployeeRatesItem(ddb, tableName, email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: userPk(e), SK: COST_RATES_SK },
    })
  );
  return res.Item || null;
}

async function getAccessRow(ddb, accessTable, email) {
  const e = normalizeEmail(email);
  if (!e || !accessTable) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: accessTable,
      Key: { PK: e, SK: e },
    })
  );
  return res.Item || null;
}

async function getProfileRow(ddb, profileTable, email) {
  const e = normalizeEmail(email);
  if (!e || !profileTable) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: profileTable,
      Key: { PK: userPk(e), SK: profileSk() },
    })
  );
  return res.Item || null;
}

function publicDesignation(item) {
  if (!item) return null;
  const internalHourlyRate = isValidPositiveRate(item.internalHourlyRate)
    ? item.internalHourlyRate
    : null;
  const externalHourlyRate = isValidPositiveRate(item.externalHourlyRate)
    ? item.externalHourlyRate
    : null;
  return {
    designationId: item.designationId,
    name: item.name,
    currency: "USD",
    internalHourlyRate,
    externalHourlyRate,
    status: item.status,
    hasConfiguredRate: internalHourlyRate != null || externalHourlyRate != null,
    createdAt: item.createdAt || null,
    createdBy: item.createdBy || null,
    updatedAt: item.updatedAt || null,
    updatedBy: item.updatedBy || null,
  };
}

function resolveSide({ side, employeeRates, designation }) {
  const field =
    side === PROJECT_EXTERNAL ? "externalHourlyRate" : "internalHourlyRate";
  const employeeActive =
    employeeRates &&
    String(employeeRates.status || "").toUpperCase() === STATUS_ACTIVE;
  const employeeValue = employeeRates ? employeeRates[field] : undefined;

  if (employeeActive && isValidPositiveRate(employeeValue)) {
    return {
      rate: employeeValue,
      source: SOURCE_EMPLOYEE,
      reason: REASON.EMPLOYEE_OVERRIDE,
    };
  }

  if (!designation) {
    const linkedId = String(employeeRates?.designationId || "").trim();
    let reason = REASON.RATE_UNSET;
    if (linkedId) reason = REASON.DESIGNATION_MISSING;
    else if (!employeeRates) reason = REASON.NO_EMPLOYEE_RECORD;
    else if (!employeeActive) reason = REASON.EMPLOYEE_INACTIVE;
    return {
      rate: null,
      source: SOURCE_NONE,
      reason,
    };
  }

  if (String(designation.status || "").toUpperCase() !== STATUS_ACTIVE) {
    return {
      rate: null,
      source: SOURCE_NONE,
      reason: REASON.DESIGNATION_INACTIVE,
    };
  }

  const designationValue = designation[field];
  if (isValidPositiveRate(designationValue)) {
    return {
      rate: designationValue,
      source: SOURCE_DESIGNATION,
      reason: REASON.DESIGNATION_FALLBACK,
    };
  }
  if (!isBlankRate(designationValue) && designationValue != null) {
    return {
      rate: null,
      source: SOURCE_NONE,
      reason: REASON.RATE_INVALID,
    };
  }
  return {
    rate: null,
    source: SOURCE_NONE,
    reason: employeeRates
      ? employeeActive
        ? REASON.RATE_UNSET
        : REASON.EMPLOYEE_INACTIVE
      : REASON.NO_EMPLOYEE_RECORD,
  };
}

function resolveHourlyRates({
  projectType,
  employeeRates = null,
  designation = null,
} = {}) {
  const internal = resolveSide({
    side: PROJECT_INTERNAL,
    employeeRates,
    designation,
  });
  const external = resolveSide({
    side: PROJECT_EXTERNAL,
    employeeRates,
    designation,
  });
  const classified =
    String(projectType || "").toUpperCase() === PROJECT_INTERNAL ||
    String(projectType || "").toUpperCase() === PROJECT_EXTERNAL;
  const project = classified
    ? String(projectType).toUpperCase() === PROJECT_EXTERNAL
      ? {
          applies: true,
          projectType: PROJECT_EXTERNAL,
          ...external,
        }
      : {
          applies: true,
          projectType: PROJECT_INTERNAL,
          ...internal,
        }
    : {
        applies: false,
        projectType: projectType == null || projectType === ""
          ? null
          : String(projectType),
        rate: null,
        source: SOURCE_NONE,
        reason: REASON.UNCLASSIFIED_PROJECT,
      };
  return { internal, external, project };
}

function versionAsRateRecord(version) {
  if (!version) return null;
  return {
    internalHourlyRate: version.internalHourlyRate,
    externalHourlyRate: version.externalHourlyRate,
    status: version.status,
    designationId: version.designationId,
  };
}

/**
 * Historical rate resolution at an assignment instant.
 * Uses the employee record version effective at `atIso` (including its
 * designationId), then the designation rate version effective at that same
 * instant. The live employee catalog pointer is never used as historical
 * designation evidence. Current catalog ACTIVE flags are not applied
 * retroactively.
 */
async function resolveHourlyRatesAt({
  ddb,
  tableName,
  email,
  projectType,
  atIso,
  employeeRatesItem = undefined,
  designationItem = undefined,
} = {}) {
  const e = normalizeEmail(email);
  const at = atIso || new Date().toISOString();
  const employeeCatalog =
    employeeRatesItem === undefined
      ? await getEmployeeRatesItem(ddb, tableName, e)
      : employeeRatesItem;
  const employeeVersions = e
    ? versionsOrCatalog(
        await listRateVersions(ddb, tableName, OWNER_EMPLOYEE, e),
        employeeCatalog,
        OWNER_EMPLOYEE,
        e
      )
    : [];
  const employeeVersion = pickEffectiveVersion(employeeVersions, at);
  const employeeRates = versionAsRateRecord(employeeVersion);

  let designation = null;
  let designationVersion = null;
  const designationId = String(employeeRates?.designationId || "").trim();
  if (designationId) {
    const designationCatalog =
      designationItem === undefined
        ? await getDesignationItem(ddb, tableName, designationId)
        : designationItem;
    const designationVersions = versionsOrCatalog(
      await listRateVersions(ddb, tableName, OWNER_DESIGNATION, designationId),
      designationCatalog,
      OWNER_DESIGNATION,
      designationId
    );
    designationVersion = pickEffectiveVersion(designationVersions, at);
    designation = versionAsRateRecord(designationVersion);
    if (designation) {
      designation.designationId = designationId;
      // Historical costing uses the version that was in force at assignment
      // time. Later deactivation must not erase that version's rates.
      designation.status = STATUS_ACTIVE;
    }
  }

  const resolved = resolveHourlyRates({
    projectType,
    employeeRates,
    designation,
  });
  if (
    resolved.project.applies &&
    !isValidPositiveRate(resolved.project.rate)
  ) {
    const personalField =
      String(projectType || "").toUpperCase() === PROJECT_EXTERNAL
        ? "externalHourlyRate"
        : "internalHourlyRate";
    const hasPersonalRate = isValidPositiveRate(employeeRates?.[personalField]);
    if (!employeeVersion || (!hasPersonalRate && !designationId)) {
      resolved.project.source = SOURCE_NONE;
      resolved.project.reason = REASON.HISTORICAL_DESIGNATION_UNKNOWN;
    }
  }
  const project = resolved.project;
  const chosenVersion =
    project.source === SOURCE_EMPLOYEE
      ? employeeVersion
      : project.source === SOURCE_DESIGNATION
        ? designationVersion
        : null;
  return {
    ...resolved,
    employeeVersion,
    designationVersion,
    rateVersionId: chosenVersion?.versionId || null,
    designationId: designationId || null,
    assignedAt: at,
  };
}

/**
 * Current catalog resolution. Uses the live employee and designation records,
 * including ACTIVE/INACTIVE. Does not force a historical designation version
 * back to ACTIVE.
 */
async function resolveCurrentHourlyRates({
  ddb,
  tableName,
  email,
  projectType,
  atIso,
} = {}) {
  const now = atIso || new Date().toISOString();
  const employeeRates = await getEmployeeRatesItem(ddb, tableName, email);
  const designationId = String(employeeRates?.designationId || "").trim();
  const designation = designationId
    ? await getDesignationItem(ddb, tableName, designationId)
    : null;
  const resolved = resolveHourlyRates({ projectType, employeeRates, designation });
  let rateVersionId = null;
  const project = resolved.project;
  if (project?.applies && isValidPositiveRate(project.rate)) {
    const ownerType =
      project.source === SOURCE_EMPLOYEE ? OWNER_EMPLOYEE : OWNER_DESIGNATION;
    const ownerId =
      ownerType === OWNER_EMPLOYEE ? normalizeEmail(email) : designationId;
    const versions = ownerId
      ? await listRateVersions(ddb, tableName, ownerType, ownerId)
      : [];
    const chosen = pickEffectiveVersion(versions, now);
    const field =
      String(project.projectType || "").toUpperCase() === PROJECT_EXTERNAL
        ? "externalHourlyRate"
        : "internalHourlyRate";
    if (
      chosen &&
      String(chosen.status || "").toUpperCase() === STATUS_ACTIVE &&
      Number(chosen[field]) === Number(project.rate)
    ) {
      rateVersionId = chosen.versionId || null;
    }
  }
  return {
    ...resolved,
    rateVersionId,
    designationId: designationId || null,
  };
}

function publicEmployeeRates({
  email,
  accessRow,
  profile,
  ratesItem,
  designation,
  projectType,
}) {
  const resolved = resolveHourlyRates({
    projectType,
    employeeRates: ratesItem,
    designation,
  });
  const publicDes = publicDesignation(designation);
  return {
    email,
    name: profile?.name || accessRow?.name || "",
    empId: profile?.empId || "",
    profileDesignation: profile?.designation || "",
    accessStatus: accessRow?.status || null,
    designationId: ratesItem?.designationId || null,
    designationName: publicDes?.name || null,
    designationStatus: publicDes?.status || null,
    currency: "USD",
    internalHourlyRate: isValidPositiveRate(ratesItem?.internalHourlyRate)
      ? ratesItem.internalHourlyRate
      : null,
    externalHourlyRate: isValidPositiveRate(ratesItem?.externalHourlyRate)
      ? ratesItem.externalHourlyRate
      : null,
    status: ratesItem?.status || null,
    hasRateRecord: Boolean(ratesItem),
    resolved,
    createdAt: ratesItem?.createdAt || null,
    createdBy: ratesItem?.createdBy || null,
    updatedAt: ratesItem?.updatedAt || null,
    updatedBy: ratesItem?.updatedBy || null,
  };
}

async function requireRatesAdmin({ user, ddb, accessTable }) {
  return requireSuperAdmin({ user, ddb, accessTable });
}

async function handleMalformedPath({ user, ddb, accessTable }) {
  const auth = await requireRatesAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  return { statusCode: 400, body: { error: PATH_INVALID } };
}

async function listDesignationItems(ddb, tableName) {
  return queryAll(ddb, {
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": DESIGNATION_ENTITY_PK,
      ":sk": "DESIGNATION#",
    },
  });
}

async function handleListDesignations({ user, ddb, tableName, accessTable }) {
  const auth = await requireRatesAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const items = await listDesignationItems(ddb, tableName);
  const designations = items
    .map(publicDesignation)
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { statusCode: 200, body: { designations } };
}

async function handleCreateDesignation({
  user,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
}) {
  const auth = await requireRatesAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const parsedName = parseDesignationName(body?.name);
  if (!parsedName.ok) {
    return { statusCode: 400, body: { error: parsedName.error } };
  }
  const internal = parseHourlyRate(body?.internalHourlyRate);
  if (!internal.ok) return { statusCode: 400, body: { error: internal.error } };
  const external = parseHourlyRate(body?.externalHourlyRate);
  if (!external.ok) return { statusCode: 400, body: { error: external.error } };
  const designationId = randomUUID();
  const now = nowIso || new Date().toISOString();
  const item = {
    PK: DESIGNATION_ENTITY_PK,
    SK: designationSk(designationId),
    type: TYPE_DESIGNATION,
    designationId,
    name: parsedName.value,
    nameKey: parsedName.nameKey,
    internalHourlyRate: internal.value,
    externalHourlyRate: external.value,
    status: STATUS_ACTIVE,
    createdAt: now,
    createdBy: auth.email,
    updatedAt: now,
    updatedBy: auth.email,
  };
  const pointer = {
    PK: DESIGNATION_NAME_PK,
    SK: designationNameSk(parsedName.nameKey),
    type: TYPE_DESIGNATION_NAME,
    designationId,
    nameKey: parsedName.nameKey,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: pointer,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          ...(
            await versionPutsForMutation({
              ddb,
              tableName,
              ownerType: OWNER_DESIGNATION,
              ownerId: designationId,
              existingItem: null,
              nextSnapshot: item,
              nowIso: now,
              actor: auth.email,
            })
          ),
        ],
      })
    );
  } catch (err) {
    const mapped = mapCreateNameTransactError(err);
    if (mapped) return mapped;
    throw err;
  }
  return { statusCode: 201, body: { designation: publicDesignation(item) } };
}

async function handlePatchDesignation({
  user,
  designationId,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
}) {
  const auth = await requireRatesAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const id = String(designationId || "").trim();
  if (!id) return { statusCode: 400, body: { error: "designationId required" } };
  const existing = await getDesignationItem(ddb, tableName, id);
  if (!existing) {
    return { statusCode: 404, body: { error: "Designation not found." } };
  }
  const nextName =
    body?.name !== undefined
      ? parseDesignationName(body.name)
      : {
          ok: true,
          value: existing.name,
          nameKey: existing.nameKey || normalizeDesignationNameKey(existing.name),
        };
  if (!nextName.ok) return { statusCode: 400, body: { error: nextName.error } };
  const internal =
    body?.internalHourlyRate !== undefined
      ? parseHourlyRate(body.internalHourlyRate)
      : { ok: true, value: existing.internalHourlyRate ?? null };
  if (!internal.ok) return { statusCode: 400, body: { error: internal.error } };
  const external =
    body?.externalHourlyRate !== undefined
      ? parseHourlyRate(body.externalHourlyRate)
      : { ok: true, value: existing.externalHourlyRate ?? null };
  if (!external.ok) return { statusCode: 400, body: { error: external.error } };
  if (body?.status !== undefined) {
    return {
      statusCode: 400,
      body: { error: "Use the status endpoint to activate or deactivate a designation." },
    };
  }
  const now = nowIso || new Date().toISOString();
  const item = {
    ...existing,
    name: nextName.value,
    nameKey: nextName.nameKey,
    internalHourlyRate: internal.value,
    externalHourlyRate: external.value,
    status: existing.status || STATUS_ACTIVE,
    updatedAt: now,
    updatedBy: auth.email,
  };
  const oldKey = existing.nameKey || normalizeDesignationNameKey(existing.name);
  const renamed = oldKey !== nextName.nameKey;
  const versionPuts = await versionPutsForMutation({
    ddb,
    tableName,
    ownerType: OWNER_DESIGNATION,
    ownerId: id,
    existingItem: existing,
    nextSnapshot: item,
    nowIso: now,
    actor: auth.email,
  });
  try {
    if (!renamed) {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: item,
                ConditionExpression: "attribute_exists(PK)",
              },
            },
            ...versionPuts,
          ],
        })
      );
    } else {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: DESIGNATION_NAME_PK,
                  SK: designationNameSk(nextName.nameKey),
                  type: TYPE_DESIGNATION_NAME,
                  designationId: id,
                  nameKey: nextName.nameKey,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: {
                  PK: DESIGNATION_NAME_PK,
                  SK: designationNameSk(oldKey),
                },
                ConditionExpression:
                  "attribute_exists(PK) AND designationId = :designationId",
                ExpressionAttributeValues: { ":designationId": id },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: item,
                ConditionExpression: "attribute_exists(PK)",
              },
            },
            ...versionPuts,
          ],
        })
      );
    }
  } catch (err) {
    if (!renamed && isSingleConditionalCheckFailed(err)) {
      return { statusCode: 404, body: { error: "Designation not found." } };
    }
    const mapped = mapRenameTransactError(err);
    if (mapped) return mapped;
    throw err;
  }
  return { statusCode: 200, body: { designation: publicDesignation(item) } };
}

async function handleDesignationStatus({
  user,
  designationId,
  body,
  ddb,
  tableName,
  accessTable,
  nowIso,
}) {
  const auth = await requireRatesAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const id = String(designationId || "").trim();
  if (!id) return { statusCode: 400, body: { error: "designationId required" } };
  const parsed = parseStatus(body?.status);
  if (!parsed.ok) return { statusCode: 400, body: { error: parsed.error } };
  const existing = await getDesignationItem(ddb, tableName, id);
  if (!existing) {
    return { statusCode: 404, body: { error: "Designation not found." } };
  }
  const now = nowIso || new Date().toISOString();
  const updated = {
    ...existing,
    status: parsed.value,
    updatedAt: now,
    updatedBy: auth.email,
  };
  const versionPuts = await versionPutsForMutation({
    ddb,
    tableName,
    ownerType: OWNER_DESIGNATION,
    ownerId: id,
    existingItem: existing,
    nextSnapshot: updated,
    nowIso: now,
    actor: auth.email,
  });
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: updated,
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          ...versionPuts,
        ],
      })
    );
  } catch (err) {
    if (isSingleConditionalCheckFailed(err) || transactHasConditionFailure(err)) {
      return { statusCode: 404, body: { error: "Designation not found." } };
    }
    throw err;
  }
  return { statusCode: 200, body: { designation: publicDesignation(updated) } };
}

async function buildEmployeePayload({
  ddb,
  tableName,
  profileTable,
  accessRow,
  email,
  projectType,
  designationCache,
}) {
  const ratesItem = await getEmployeeRatesItem(ddb, tableName, email);
  let designation = null;
  const designationId = String(ratesItem?.designationId || "").trim();
  if (designationId) {
    if (designationCache && designationCache.has(designationId)) {
      designation = designationCache.get(designationId);
    } else {
      designation = await getDesignationItem(ddb, tableName, designationId);
      if (designationCache) designationCache.set(designationId, designation);
    }
  }
  const profile = await getProfileRow(ddb, profileTable, email);
  return publicEmployeeRates({
    email,
    accessRow,
    profile,
    ratesItem,
    designation,
    projectType,
  });
}

async function handleListEmployees({
  user,
  ddb,
  tableName,
  accessTable,
  profileTable,
  query,
}) {
  const auth = await requireRatesAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const rows = await scanAll(ddb, accessTable);
  const seen = new Set();
  const employees = [];
  const designationCache = new Map();
  const projectType = query?.projectType;
  for (const row of rows) {
    const email = normalizeEmail(row.email || row.PK);
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    employees.push(
      await buildEmployeePayload({
        ddb,
        tableName,
        profileTable,
        accessRow: row,
        email,
        projectType,
        designationCache,
      })
    );
  }
  employees.sort((a, b) => String(a.email).localeCompare(String(b.email)));
  return { statusCode: 200, body: { employees } };
}

async function handleGetEmployee({
  user,
  email,
  ddb,
  tableName,
  accessTable,
  profileTable,
  query,
}) {
  const auth = await requireRatesAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const target = normalizeEmail(email);
  if (!target) return { statusCode: 400, body: { error: "email required" } };
  const accessRow = await getAccessRow(ddb, accessTable, target);
  if (!accessRow) {
    return { statusCode: 404, body: { error: "Employee not found." } };
  }
  const employee = await buildEmployeePayload({
    ddb,
    tableName,
    profileTable,
    accessRow,
    email: target,
    projectType: query?.projectType,
  });
  return { statusCode: 200, body: { employee } };
}

async function handlePutEmployee({
  user,
  email,
  body,
  ddb,
  tableName,
  accessTable,
  profileTable,
  nowIso,
}) {
  const auth = await requireRatesAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const target = normalizeEmail(email);
  if (!target) return { statusCode: 400, body: { error: "email required" } };
  const accessRow = await getAccessRow(ddb, accessTable, target);
  if (!accessRow) {
    return { statusCode: 404, body: { error: "Employee not found." } };
  }
  const existing = await getEmployeeRatesItem(ddb, tableName, target);
  let designationId = existing?.designationId || null;
  if (body?.designationId !== undefined) {
    const raw = body.designationId;
    if (raw == null || String(raw).trim() === "") {
      designationId = null;
    } else {
      designationId = String(raw).trim();
      const designation = await getDesignationItem(ddb, tableName, designationId);
      if (!designation) {
        return { statusCode: 404, body: { error: "Designation not found." } };
      }
    }
  }
  if (!designationId) {
    return {
      statusCode: 400,
      body: { error: "Select a managed designation." },
    };
  }
  const designation = await getDesignationItem(ddb, tableName, designationId);
  if (!designation) {
    return { statusCode: 404, body: { error: "Designation not found." } };
  }
  const internal =
    body?.internalHourlyRate !== undefined
      ? parseHourlyRate(body.internalHourlyRate)
      : { ok: true, value: existing?.internalHourlyRate ?? null };
  if (!internal.ok) return { statusCode: 400, body: { error: internal.error } };
  const external =
    body?.externalHourlyRate !== undefined
      ? parseHourlyRate(body.externalHourlyRate)
      : { ok: true, value: existing?.externalHourlyRate ?? null };
  if (!external.ok) return { statusCode: 400, body: { error: external.error } };
  if (body?.status !== undefined) {
    return {
      statusCode: 400,
      body: {
        error: "Use the status endpoint to activate or deactivate employee rates.",
      },
    };
  }
  const now = nowIso || new Date().toISOString();
  const item = {
    PK: userPk(target),
    SK: COST_RATES_SK,
    type: TYPE_EMPLOYEE_COST_RATES,
    email: target,
    designationId,
    internalHourlyRate: internal.value,
    externalHourlyRate: external.value,
    status: existing?.status || STATUS_ACTIVE,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || auth.email,
    updatedAt: now,
    updatedBy: auth.email,
  };
  const versionPuts = await versionPutsForMutation({
    ddb,
    tableName,
    ownerType: OWNER_EMPLOYEE,
    ownerId: target,
    existingItem: existing,
    nextSnapshot: item,
    nowIso: now,
    actor: auth.email,
  });
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: item,
          },
        },
        ...versionPuts,
      ],
    })
  );
  const employee = publicEmployeeRates({
    email: target,
    accessRow,
    profile: await getProfileRow(ddb, profileTable, target),
    ratesItem: item,
    designation,
  });
  return { statusCode: existing ? 200 : 201, body: { employee } };
}

async function handleEmployeeStatus({
  user,
  email,
  body,
  ddb,
  tableName,
  accessTable,
  profileTable,
  nowIso,
}) {
  const auth = await requireRatesAdmin({ user, ddb, accessTable });
  if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };
  const target = normalizeEmail(email);
  if (!target) return { statusCode: 400, body: { error: "email required" } };
  const parsed = parseStatus(body?.status);
  if (!parsed.ok) return { statusCode: 400, body: { error: parsed.error } };
  const accessRow = await getAccessRow(ddb, accessTable, target);
  if (!accessRow) {
    return { statusCode: 404, body: { error: "Employee not found." } };
  }
  const existing = await getEmployeeRatesItem(ddb, tableName, target);
  if (!existing) {
    return { statusCode: 404, body: { error: "Employee rate record not found." } };
  }
  const now = nowIso || new Date().toISOString();
  const ratesItem = {
    ...existing,
    status: parsed.value,
    updatedAt: now,
    updatedBy: auth.email,
  };
  const versionPuts = await versionPutsForMutation({
    ddb,
    tableName,
    ownerType: OWNER_EMPLOYEE,
    ownerId: target,
    existingItem: existing,
    nextSnapshot: ratesItem,
    nowIso: now,
    actor: auth.email,
  });
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: ratesItem,
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          ...versionPuts,
        ],
      })
    );
  } catch (err) {
    if (isSingleConditionalCheckFailed(err) || transactHasConditionFailure(err)) {
      return { statusCode: 404, body: { error: "Employee rate record not found." } };
    }
    throw err;
  }
  const designation = ratesItem.designationId
    ? await getDesignationItem(ddb, tableName, ratesItem.designationId)
    : null;
  const employee = publicEmployeeRates({
    email: target,
    accessRow,
    profile: await getProfileRow(ddb, profileTable, target),
    ratesItem,
    designation,
  });
  return { statusCode: 200, body: { employee } };
}

module.exports = {
  DESIGNATION_ENTITY_PK,
  DESIGNATION_NAME_PK,
  TYPE_DESIGNATION,
  TYPE_EMPLOYEE_COST_RATES,
  COST_RATES_SK,
  RATE_INVALID,
  NAME_DUPLICATE,
  NAME_POINTER_CONFLICT,
  PATH_INVALID,
  REASON,
  SOURCE_EMPLOYEE,
  SOURCE_DESIGNATION,
  designationsListPathMatch,
  designationIdPathMatch,
  designationStatusPathMatch,
  employeesListPathMatch,
  employeeEmailPathMatch,
  employeeStatusPathMatch,
  normalizeDesignationNameKey,
  displayDesignationName,
  parseHourlyRate,
  isValidPositiveRate,
  resolveHourlyRates,
  resolveHourlyRatesAt,
  resolveCurrentHourlyRates,
  publicDesignation,
  publicEmployeeRates,
  handleMalformedPath,
  handleListDesignations,
  handleCreateDesignation,
  handlePatchDesignation,
  handleDesignationStatus,
  handleListEmployees,
  handleGetEmployee,
  handlePutEmployee,
  handleEmployeeStatus,
};

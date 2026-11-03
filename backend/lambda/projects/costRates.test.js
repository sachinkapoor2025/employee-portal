const assert = require("assert");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  COST_RATES_SK,
  DESIGNATION_ENTITY_PK,
  DESIGNATION_NAME_PK,
  NAME_DUPLICATE,
  NAME_POINTER_CONFLICT,
  PATH_INVALID,
  CREATED_ON_DEPARTMENT_PAGE,
  RATE_INVALID,
  RATES_FOR_ACTIVE,
  RETIRED_ON_DEPARTMENT_PAGE,
  REASON,
  SOURCE_DESIGNATION,
  SOURCE_EMPLOYEE,
  TYPE_EMPLOYEE_COST_RATES,
  designationIdPathMatch,
  designationStatusPathMatch,
  designationsListPathMatch,
  employeeEmailPathMatch,
  employeeStatusPathMatch,
  employeesListPathMatch,
  handleCreateDesignation,
  handleDesignationStatus,
  handleMalformedPath,
  handleEmployeeStatus,
  handleGetEmployee,
  handleListDesignations,
  handleListEmployees,
  handlePatchDesignation,
  handlePutEmployee,
  parseHourlyRate,
  publicEmployeeRates,
  resolveHourlyRates,
} = require("./costRates");

function keyOf(table, pk, sk) {
  return `${table}\0${pk}\0${sk}`;
}

function evalItemCondition(existing, cond, values = {}) {
  if (!cond) return true;
  if (cond.includes("attribute_not_exists(PK)") && existing) return false;
  if (cond.includes("attribute_exists(PK)") && !existing) return false;
  if (cond.includes("designationId = :designationId")) {
    const expected = values[":designationId"];
    if (!existing || existing.designationId !== expected) return false;
  }
  return true;
}

function memoryDdb(seed = {}) {
  const items = Object.fromEntries(
    Object.entries(seed).map(([k, v]) => [k, { ...v }])
  );
  const ddb = {
    items,
    puts: [],
    async send(command) {
      if (command instanceof GetCommand) {
        const k = keyOf(
          command.input.TableName,
          command.input.Key.PK,
          command.input.Key.SK
        );
        const found = items[k];
        return found ? { Item: { ...found } } : {};
      }
      if (command instanceof PutCommand) {
        const item = command.input.Item;
        const k = keyOf(command.input.TableName, item.PK, item.SK);
        const cond = command.input.ConditionExpression || "";
        if (!evalItemCondition(items[k], cond, command.input.ExpressionAttributeValues)) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        items[k] = { ...item };
        ddb.puts.push({ table: command.input.TableName, item: { ...item } });
        return {};
      }
      if (command instanceof DeleteCommand) {
        const k = keyOf(
          command.input.TableName,
          command.input.Key.PK,
          command.input.Key.SK
        );
        const cond = command.input.ConditionExpression || "";
        if (
          !evalItemCondition(
            items[k],
            cond,
            command.input.ExpressionAttributeValues
          )
        ) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        delete items[k];
        return {};
      }
      if (command instanceof UpdateCommand) {
        const k = keyOf(
          command.input.TableName,
          command.input.Key.PK,
          command.input.Key.SK
        );
        if (!items[k]) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        const values = command.input.ExpressionAttributeValues || {};
        if (values[":status"] !== undefined) items[k].status = values[":status"];
        if (values[":now"] !== undefined) items[k].updatedAt = values[":now"];
        if (values[":by"] !== undefined) items[k].updatedBy = values[":by"];
        return { Attributes: { ...items[k] } };
      }
      if (command instanceof QueryCommand) {
        const table = command.input.TableName;
        const pk = command.input.ExpressionAttributeValues[":pk"];
        const skPrefix = command.input.ExpressionAttributeValues[":sk"];
        const found = Object.entries(items)
          .filter(([k]) => k.startsWith(`${table}\0`))
          .map(([, item]) => item)
          .filter((item) => {
            if (item.PK !== pk) return false;
            if (!skPrefix) return true;
            return String(item.SK || "").startsWith(skPrefix);
          });
        return { Items: found.map((item) => ({ ...item })) };
      }
      if (command instanceof ScanCommand) {
        const table = command.input.TableName;
        const found = Object.entries(items)
          .filter(([k]) => k.startsWith(`${table}\0`))
          .map(([, item]) => ({ ...item }));
        return { Items: found };
      }
      if (command instanceof TransactWriteCommand) {
        const ops = command.input.TransactItems || [];
        const reasons = ops.map((op) => {
          if (op.Put) {
            const item = op.Put.Item;
            const k = keyOf(op.Put.TableName, item.PK, item.SK);
            const ok = evalItemCondition(
              items[k],
              op.Put.ConditionExpression || "",
              op.Put.ExpressionAttributeValues
            );
            return { Code: ok ? "None" : "ConditionalCheckFailed" };
          }
          if (op.Delete) {
            const k = keyOf(
              op.Delete.TableName,
              op.Delete.Key.PK,
              op.Delete.Key.SK
            );
            const ok = evalItemCondition(
              items[k],
              op.Delete.ConditionExpression || "",
              op.Delete.ExpressionAttributeValues
            );
            return { Code: ok ? "None" : "ConditionalCheckFailed" };
          }
          return { Code: "None" };
        });
        if (reasons.some((row) => row.Code === "ConditionalCheckFailed")) {
          const err = new Error("Transaction cancelled");
          err.name = "TransactionCanceledException";
          err.CancellationReasons = reasons;
          throw err;
        }
        for (const op of ops) {
          if (op.Put) {
            const item = op.Put.Item;
            const k = keyOf(op.Put.TableName, item.PK, item.SK);
            items[k] = { ...item };
            ddb.puts.push({ table: op.Put.TableName, item: { ...item } });
          } else if (op.Delete) {
            const k = keyOf(
              op.Delete.TableName,
              op.Delete.Key.PK,
              op.Delete.Key.SK
            );
            delete items[k];
          }
        }
        return {};
      }
      throw new Error(`unexpected ${command?.constructor?.name}`);
    },
  };
  return ddb;
}

const WORK = "WorkTasks";
const ACCESS = "UserAccess";
const PROFILE = "UserProfile";
const NOW = "2026-10-13T06:00:00.000Z";
const SUPER = { email: "boss@mydgv.com", groups: ["Admin"], isAdmin: true };
const ADMIN = { email: "admin@mydgv.com", groups: ["Admin"], isAdmin: true };
const MANAGER = { email: "manager@mydgv.com", groups: ["Admin"], isAdmin: true };
const EMPLOYEE = { email: "rahul@mydgv.com", groups: ["Employee"], isAdmin: false };

function seedAccess(extra = {}) {
  return {
    [keyOf(ACCESS, "boss@mydgv.com", "boss@mydgv.com")]: {
      PK: "boss@mydgv.com",
      SK: "boss@mydgv.com",
      email: "boss@mydgv.com",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    },
    [keyOf(ACCESS, "admin@mydgv.com", "admin@mydgv.com")]: {
      PK: "admin@mydgv.com",
      SK: "admin@mydgv.com",
      email: "admin@mydgv.com",
      role: "ADMIN",
      status: "ACTIVE",
    },
    [keyOf(ACCESS, "manager@mydgv.com", "manager@mydgv.com")]: {
      PK: "manager@mydgv.com",
      SK: "manager@mydgv.com",
      email: "manager@mydgv.com",
      role: "MANAGER",
      status: "ACTIVE",
    },
    [keyOf(ACCESS, "rahul@mydgv.com", "rahul@mydgv.com")]: {
      PK: "rahul@mydgv.com",
      SK: "rahul@mydgv.com",
      email: "rahul@mydgv.com",
      role: "EMPLOYEE",
      status: "ACTIVE",
    },
    [keyOf(ACCESS, "blocked@mydgv.com", "blocked@mydgv.com")]: {
      PK: "blocked@mydgv.com",
      SK: "blocked@mydgv.com",
      email: "blocked@mydgv.com",
      role: "SUPER_ADMIN",
      status: "INACTIVE",
    },
    [keyOf(PROFILE, "USER#rahul@mydgv.com", "PROFILE")]: {
      PK: "USER#rahul@mydgv.com",
      SK: "PROFILE",
      email: "rahul@mydgv.com",
      name: "Rahul",
      empId: "E1",
      designation: "Free text SEO",
      departmentIds: ["seo-digital-marketing"],
      primaryDepartmentId: "seo-digital-marketing",
      departmentDesignations: [
        {
          departmentId: "seo-digital-marketing",
          designationId: "seo-specialist",
        },
      ],
    },
    ...extra,
  };
}

function ctx(user, extraSeed = {}) {
  const ddb = memoryDdb(seedAccess(extraSeed));
  return {
    user,
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    profileTable: PROFILE,
    nowIso: NOW,
  };
}

assert.strictEqual(designationsListPathMatch("/prod/admin/cost-rates/designations"), true);
assert.deepStrictEqual(
  designationIdPathMatch("/prod/admin/cost-rates/designations/d1"),
  { value: "d1" }
);
assert.deepStrictEqual(
  designationStatusPathMatch("/prod/admin/cost-rates/designations/d1/status"),
  { value: "d1" }
);
assert.strictEqual(employeesListPathMatch("/prod/admin/cost-rates/employees"), true);
assert.deepStrictEqual(
  employeeEmailPathMatch("/prod/admin/cost-rates/employees/Rahul%40mydgv.com"),
  { value: "rahul@mydgv.com" }
);
assert.deepStrictEqual(
  employeeStatusPathMatch("/prod/admin/cost-rates/employees/Rahul%40mydgv.com/status"),
  { value: "rahul@mydgv.com" }
);
assert.deepStrictEqual(
  designationIdPathMatch("/prod/admin/cost-rates/designations/%E0%A4%A"),
  { malformed: true }
);
assert.deepStrictEqual(
  designationIdPathMatch("/prod/admin/cost-rates/designations/%ZZ"),
  { malformed: true }
);
assert.deepStrictEqual(
  employeeEmailPathMatch("/prod/admin/cost-rates/employees/%E0%A4%A"),
  { malformed: true }
);
assert.deepStrictEqual(
  employeeStatusPathMatch(
    "/prod/admin/cost-rates/employees/%E0%A4%A/status",
    { email: "%E0%A4%A" }
  ),
  { malformed: true }
);
assert.deepStrictEqual(
  employeeEmailPathMatch("/prod/admin/cost-rates/employees/Rahul%40mydgv.com", {
    email: "Rahul%40mydgv.com",
  }),
  { value: "rahul@mydgv.com" }
);

assert.strictEqual(parseHourlyRate("").value, null);
assert.strictEqual(parseHourlyRate("  ").value, null);
assert.strictEqual(parseHourlyRate(null).value, null);
assert.strictEqual(parseHourlyRate("2.25").value, 2.25);
assert.strictEqual(parseHourlyRate(2.25).ok, true);
assert.strictEqual(parseHourlyRate("0").ok, false);
assert.strictEqual(parseHourlyRate(0).ok, false);
assert.strictEqual(parseHourlyRate(-1).ok, false);
assert.strictEqual(parseHourlyRate("1.234").ok, false);
assert.strictEqual(parseHourlyRate(1.234).ok, false);
assert.strictEqual(parseHourlyRate(Number.POSITIVE_INFINITY).ok, false);
assert.strictEqual(parseHourlyRate("abc").ok, false);
assert.strictEqual(parseHourlyRate("0.00").ok, false);

const des = {
  designationId: "seo",
  name: "SEO Executive",
  status: "ACTIVE",
  internalHourlyRate: 2,
  externalHourlyRate: 3,
};

const mixed = resolveHourlyRates({
  employeeRates: {
    status: "ACTIVE",
    internalHourlyRate: 2.25,
    externalHourlyRate: null,
    designationId: "seo",
  },
  designation: des,
});
assert.strictEqual(mixed.internal.rate, 2.25);
assert.strictEqual(mixed.internal.source, SOURCE_EMPLOYEE);
assert.strictEqual(mixed.external.rate, 3);
assert.strictEqual(mixed.external.source, SOURCE_DESIGNATION);

const mixedExt = resolveHourlyRates({
  employeeRates: {
    status: "ACTIVE",
    internalHourlyRate: null,
    externalHourlyRate: 4.5,
    designationId: "seo",
  },
  designation: des,
});
assert.strictEqual(mixedExt.internal.rate, 2);
assert.strictEqual(mixedExt.internal.source, SOURCE_DESIGNATION);
assert.strictEqual(mixedExt.external.rate, 4.5);
assert.strictEqual(mixedExt.external.source, SOURCE_EMPLOYEE);

const bothEmp = resolveHourlyRates({
  employeeRates: {
    status: "ACTIVE",
    internalHourlyRate: 9,
    externalHourlyRate: 10,
    designationId: "seo",
  },
  designation: des,
});
assert.strictEqual(bothEmp.internal.source, SOURCE_EMPLOYEE);
assert.strictEqual(bothEmp.external.source, SOURCE_EMPLOYEE);

const bothDes = resolveHourlyRates({
  employeeRates: {
    status: "ACTIVE",
    internalHourlyRate: null,
    externalHourlyRate: null,
    designationId: "seo",
  },
  designation: des,
});
assert.strictEqual(bothDes.internal.source, SOURCE_DESIGNATION);
assert.strictEqual(bothDes.external.source, SOURCE_DESIGNATION);

const missingEmp = resolveHourlyRates({ designation: des });
assert.strictEqual(missingEmp.internal.source, SOURCE_DESIGNATION);
assert.strictEqual(missingEmp.internal.reason, REASON.DESIGNATION_FALLBACK);

const missingBoth = resolveHourlyRates({});
assert.strictEqual(missingBoth.internal.rate, null);
assert.strictEqual(missingBoth.internal.reason, REASON.NO_EMPLOYEE_RECORD);

const inactiveEmp = resolveHourlyRates({
  employeeRates: {
    status: "INACTIVE",
    internalHourlyRate: 9,
    externalHourlyRate: 10,
    designationId: "seo",
  },
  designation: des,
});
assert.strictEqual(inactiveEmp.internal.rate, 2);
assert.strictEqual(inactiveEmp.internal.source, SOURCE_DESIGNATION);

const inactiveDesKeepEmp = resolveHourlyRates({
  employeeRates: {
    status: "ACTIVE",
    internalHourlyRate: 2.25,
    externalHourlyRate: null,
    designationId: "seo",
  },
  designation: { ...des, status: "INACTIVE" },
});
assert.strictEqual(inactiveDesKeepEmp.internal.rate, 2.25);
assert.strictEqual(inactiveDesKeepEmp.internal.source, SOURCE_EMPLOYEE);
assert.strictEqual(inactiveDesKeepEmp.external.rate, null);
assert.strictEqual(inactiveDesKeepEmp.external.reason, REASON.DESIGNATION_INACTIVE);

const inactiveDesNoPersonal = resolveHourlyRates({
  employeeRates: {
    status: "ACTIVE",
    internalHourlyRate: null,
    externalHourlyRate: null,
    designationId: "seo",
  },
  designation: { ...des, status: "INACTIVE" },
});
assert.strictEqual(inactiveDesNoPersonal.internal.rate, null);
assert.strictEqual(inactiveDesNoPersonal.internal.reason, REASON.DESIGNATION_INACTIVE);

const missingDes = resolveHourlyRates({
  employeeRates: {
    status: "ACTIVE",
    internalHourlyRate: null,
    designationId: "gone",
  },
  designation: null,
});
assert.strictEqual(missingDes.internal.reason, REASON.DESIGNATION_MISSING);

const blankRates = resolveHourlyRates({
  employeeRates: {
    status: "ACTIVE",
    internalHourlyRate: null,
    externalHourlyRate: "",
    designationId: "seo",
  },
  designation: {
    ...des,
    internalHourlyRate: null,
    externalHourlyRate: null,
  },
});
assert.strictEqual(blankRates.internal.reason, REASON.RATE_UNSET);
assert.strictEqual(blankRates.external.rate, null);

const invalidDesRate = resolveHourlyRates({
  employeeRates: { status: "ACTIVE", designationId: "seo" },
  designation: { ...des, internalHourlyRate: 0, externalHourlyRate: -3 },
});
assert.strictEqual(invalidDesRate.internal.rate, null);
assert.notStrictEqual(invalidDesRate.internal.source, SOURCE_DESIGNATION);

const unclassified = resolveHourlyRates({
  projectType: "OTHER",
  employeeRates: {
    status: "ACTIVE",
    internalHourlyRate: 2.25,
    designationId: "seo",
  },
  designation: des,
});
assert.strictEqual(unclassified.project.applies, false);
assert.strictEqual(unclassified.project.reason, REASON.UNCLASSIFIED_PROJECT);
assert.strictEqual(unclassified.internal.rate, 2.25);

const classified = resolveHourlyRates({
  projectType: "INTERNAL",
  employeeRates: {
    status: "ACTIVE",
    internalHourlyRate: 2.25,
    designationId: "seo",
  },
  designation: des,
});
assert.strictEqual(classified.project.applies, true);
assert.strictEqual(classified.project.rate, 2.25);

(async () => {
  const created = await handleCreateDesignation({
    ...ctx(SUPER),
    body: { name: "  SEO Executive  ", internalHourlyRate: "2.00", externalHourlyRate: "" },
  });
  assert.strictEqual(created.statusCode, 400);
  assert.strictEqual(created.body.error, CREATED_ON_DEPARTMENT_PAGE);
  const designationId = "seo-specialist";

  const dupCase = await handleCreateDesignation({
    ...ctx(SUPER, {
      [keyOf(WORK, DESIGNATION_NAME_PK, "NAME#seo executive")]: {
        PK: DESIGNATION_NAME_PK,
        SK: "NAME#seo executive",
        designationId: "x",
      },
    }),
    body: { name: "SEO EXECUTIVE" },
  });
  assert.strictEqual(dupCase.statusCode, 400);
  assert.strictEqual(dupCase.body.error, CREATED_ON_DEPARTMENT_PAGE);

  const dupSpace = await handleCreateDesignation({
    ...ctx(SUPER, {
      [keyOf(WORK, DESIGNATION_NAME_PK, "NAME#seo executive")]: {
        PK: DESIGNATION_NAME_PK,
        SK: "NAME#seo executive",
        designationId: "x",
      },
    }),
    body: { name: "seo   executive" },
  });
  assert.strictEqual(dupSpace.statusCode, 400);

  const badRate = await handleCreateDesignation({
    ...ctx(SUPER),
    body: { name: "QA", internalHourlyRate: "1.234" },
  });
  assert.strictEqual(badRate.statusCode, 400);
  assert.strictEqual(badRate.body.error, CREATED_ON_DEPARTMENT_PAGE);

  const zeroRate = await handleCreateDesignation({
    ...ctx(SUPER),
    body: { name: "QA", internalHourlyRate: 0 },
  });
  assert.strictEqual(zeroRate.statusCode, 400);

  const adminCreate = await handleCreateDesignation({
    ...ctx(ADMIN),
    body: { name: "QA" },
  });
  assert.strictEqual(adminCreate.statusCode, 403);

  const managerCreate = await handleCreateDesignation({
    ...ctx(MANAGER),
    body: { name: "QA" },
  });
  assert.strictEqual(managerCreate.statusCode, 403);

  const empCreate = await handleCreateDesignation({
    ...ctx(EMPLOYEE),
    body: { name: "QA" },
  });
  assert.strictEqual(empCreate.statusCode, 403);

  const missingAccess = await handleCreateDesignation({
    user: { email: "ghost@mydgv.com", isAdmin: true },
    ddb: memoryDdb(seedAccess()),
    tableName: WORK,
    accessTable: ACCESS,
    body: { name: "QA" },
  });
  assert.strictEqual(missingAccess.statusCode, 403);

  const inactiveAccess = await handleCreateDesignation({
    user: { email: "blocked@mydgv.com", isAdmin: true, groups: ["Admin"] },
    ddb: memoryDdb(seedAccess()),
    tableName: WORK,
    accessTable: ACCESS,
    body: { name: "QA" },
  });
  assert.strictEqual(inactiveAccess.statusCode, 403);

  const listDenied = await handleListDesignations(ctx(ADMIN));
  assert.strictEqual(listDenied.statusCode, 403);

  const seedDes = {
    [keyOf(WORK, "ENTITY#ORG_DESIGNATION", `DESIGNATION#${designationId}`)]: {
      PK: "ENTITY#ORG_DESIGNATION",
      SK: `DESIGNATION#${designationId}`,
      type: "ORG_DESIGNATION",
      designationId,
      departmentId: "seo-digital-marketing",
      track: "SEO",
      trackSort: 1,
      sortOrder: 3,
      name: "SEO Specialist",
      nameKey: "seo specialist",
      internalHourlyRate: 2,
      externalHourlyRate: 3,
      status: "ACTIVE",
      createdAt: NOW,
      createdBy: "boss@mydgv.com",
      updatedAt: NOW,
      updatedBy: "boss@mydgv.com",
    },
    [keyOf(WORK, DESIGNATION_ENTITY_PK, "DESIGNATION#legacy-seo")]: {
      PK: DESIGNATION_ENTITY_PK,
      SK: "DESIGNATION#legacy-seo",
      type: "DESIGNATION",
      designationId: "legacy-seo",
      name: "SEO Executive",
      nameKey: "seo executive",
      internalHourlyRate: 4,
      externalHourlyRate: 5,
      status: "ACTIVE",
    },
  };

  const listed = await handleListDesignations({
    ...ctx(SUPER, seedDes),
  });
  assert.strictEqual(listed.statusCode, 200);
  assert.strictEqual(listed.body.designations.length, 1);
  assert.strictEqual(listed.body.designations[0].designationId, designationId);
  assert.strictEqual(listed.body.legacyReport.unmatched.length, 1);
  assert.strictEqual(listed.body.legacyReport.unmatched[0].name, "SEO Executive");

  const patched = await handlePatchDesignation({
    ...ctx(SUPER, seedDes),
    designationId,
    body: { internalHourlyRate: "", externalHourlyRate: 3.5 },
  });
  assert.strictEqual(patched.statusCode, 200);
  assert.strictEqual(patched.body.designation.name, "SEO Specialist");
  assert.strictEqual(patched.body.designation.designationId, designationId);
  assert.strictEqual(patched.body.designation.internalHourlyRate, null);
  assert.strictEqual(patched.body.designation.externalHourlyRate, 3.5);
  assert.strictEqual(patched.body.designation.status, "ACTIVE");

  const renameBlocked = await handlePatchDesignation({
    ...ctx(SUPER, seedDes),
    designationId,
    body: { name: "SEO Lead" },
  });
  assert.strictEqual(renameBlocked.statusCode, 400);

  const patchStatusBlocked = await handlePatchDesignation({
    ...ctx(SUPER, seedDes),
    designationId,
    body: { status: "INACTIVE" },
  });
  assert.strictEqual(patchStatusBlocked.statusCode, 400);

  const deactivated = await handleDesignationStatus({
    ...ctx(SUPER, seedDes),
    designationId,
    body: { status: "INACTIVE" },
  });
  assert.strictEqual(deactivated.statusCode, 400);
  assert.strictEqual(deactivated.body.error, RETIRED_ON_DEPARTMENT_PAGE);

  const missingEmp = await handlePutEmployee({
    ...ctx(SUPER, seedDes),
    email: "nobody@mydgv.com",
    body: { designationId },
  });
  assert.strictEqual(missingEmp.statusCode, 404);

  const missingDesRef = await handlePutEmployee({
    ...ctx(SUPER, seedDes),
    email: "rahul@mydgv.com",
    body: { designationId: "missing" },
  });
  assert.strictEqual(missingDesRef.statusCode, 400);
  assert.strictEqual(
    missingDesRef.body.error,
    "Costing designation must be an active designation assigned to this employee."
  );

  const createdEmp = await handlePutEmployee({
    ...ctx(SUPER, seedDes),
    email: "Rahul@mydgv.com",
    body: {
      designationId,
      internalHourlyRate: "2.25",
      externalHourlyRate: "",
    },
  });
  assert.strictEqual(createdEmp.statusCode, 201);
  assert.strictEqual(createdEmp.body.employee.email, "rahul@mydgv.com");
  assert.strictEqual(createdEmp.body.employee.internalHourlyRate, 2.25);
  assert.strictEqual(createdEmp.body.employee.externalHourlyRate, null);
  assert.strictEqual(createdEmp.body.employee.profileDesignation, "Free text SEO");
  assert.strictEqual(createdEmp.body.employee.resolved.internal.source, SOURCE_EMPLOYEE);
  assert.strictEqual(createdEmp.body.employee.resolved.external.source, SOURCE_DESIGNATION);
  assert.strictEqual(createdEmp.body.employee.status, "ACTIVE");

  const empRecord = createdEmp.body.employee;
  const storedRates = {
    [keyOf(WORK, "USER#rahul@mydgv.com", COST_RATES_SK)]: {
      PK: "USER#rahul@mydgv.com",
      SK: COST_RATES_SK,
      type: TYPE_EMPLOYEE_COST_RATES,
      email: "rahul@mydgv.com",
      designationId,
      internalHourlyRate: 2.25,
      externalHourlyRate: null,
      status: "INACTIVE",
      createdAt: NOW,
      createdBy: "boss@mydgv.com",
      updatedAt: NOW,
      updatedBy: "boss@mydgv.com",
    },
  };
  const profileBefore = seedAccess(seedDes)[keyOf(PROFILE, "USER#rahul@mydgv.com", "PROFILE")];
  const putOnInactive = await handlePutEmployee({
    ...ctx(SUPER, { ...seedDes, ...storedRates }),
    email: "rahul@mydgv.com",
    body: { designationId, internalHourlyRate: 5 },
  });
  assert.strictEqual(putOnInactive.statusCode, 200);
  assert.strictEqual(putOnInactive.body.employee.status, "INACTIVE");
  assert.strictEqual(putOnInactive.body.employee.internalHourlyRate, 5);
  const profileAfterPut = putOnInactive.ddb
    ? null
    : profileBefore;
  const env = ctx(SUPER, { ...seedDes, ...storedRates });
  await handlePutEmployee({
    ...env,
    email: "rahul@mydgv.com",
    body: { designationId, internalHourlyRate: 5, externalHourlyRate: null },
  });
  const profileKey = keyOf(PROFILE, "USER#rahul@mydgv.com", "PROFILE");
  assert.deepStrictEqual(env.ddb.items[profileKey].designation, "Free text SEO");
  assert.strictEqual(
    env.ddb.items[keyOf(ACCESS, "rahul@mydgv.com", "rahul@mydgv.com")].role,
    "EMPLOYEE"
  );
  assert.strictEqual(
    env.ddb.items[keyOf(WORK, "USER#rahul@mydgv.com", COST_RATES_SK)].status,
    "INACTIVE"
  );

  const cleared = await handlePutEmployee({
    ...ctx(SUPER, {
      ...seedDes,
      [keyOf(WORK, "USER#rahul@mydgv.com", COST_RATES_SK)]: {
        PK: "USER#rahul@mydgv.com",
        SK: COST_RATES_SK,
        type: TYPE_EMPLOYEE_COST_RATES,
        email: "rahul@mydgv.com",
        designationId,
        internalHourlyRate: 2.25,
        externalHourlyRate: 8,
        status: "ACTIVE",
        createdAt: NOW,
        createdBy: "boss@mydgv.com",
        updatedAt: NOW,
        updatedBy: "boss@mydgv.com",
      },
    }),
    email: "rahul@mydgv.com",
    body: { designationId, internalHourlyRate: "", externalHourlyRate: 8 },
  });
  assert.strictEqual(cleared.body.employee.internalHourlyRate, null);
  assert.strictEqual(cleared.body.employee.externalHourlyRate, 8);
  assert.strictEqual(cleared.body.employee.resolved.internal.source, SOURCE_DESIGNATION);

  const adminPut = await handlePutEmployee({
    ...ctx(ADMIN, seedDes),
    email: "rahul@mydgv.com",
    body: { designationId },
  });
  assert.strictEqual(adminPut.statusCode, 403);

  const empGet = await handleGetEmployee({
    ...ctx(SUPER, {
      ...seedDes,
      [keyOf(WORK, "USER#rahul@mydgv.com", COST_RATES_SK)]: {
        PK: "USER#rahul@mydgv.com",
        SK: COST_RATES_SK,
        type: TYPE_EMPLOYEE_COST_RATES,
        email: "rahul@mydgv.com",
        designationId,
        internalHourlyRate: 2.25,
        status: "ACTIVE",
      },
    }),
    email: "rahul@mydgv.com",
    query: { projectType: "OTHER" },
  });
  assert.strictEqual(empGet.statusCode, 200);
  assert.strictEqual(empGet.body.employee.resolved.project.applies, false);

  const listedEmp = await handleListEmployees({
    ...ctx(SUPER, seedDes),
  });
  assert.strictEqual(listedEmp.statusCode, 200);
  assert.ok(listedEmp.body.employees.some((e) => e.email === "rahul@mydgv.com"));

  const statusEmp = await handleEmployeeStatus({
    ...ctx(SUPER, {
      ...seedDes,
      [keyOf(WORK, "USER#rahul@mydgv.com", COST_RATES_SK)]: {
        PK: "USER#rahul@mydgv.com",
        SK: COST_RATES_SK,
        type: TYPE_EMPLOYEE_COST_RATES,
        email: "rahul@mydgv.com",
        designationId,
        internalHourlyRate: 2.25,
        status: "ACTIVE",
      },
    }),
    email: "rahul@mydgv.com",
    body: { status: "INACTIVE" },
  });
  assert.strictEqual(statusEmp.statusCode, 200);
  assert.strictEqual(statusEmp.body.employee.status, "INACTIVE");

  const statusMissing = await handleEmployeeStatus({
    ...ctx(SUPER),
    email: "rahul@mydgv.com",
    body: { status: "ACTIVE" },
  });
  assert.strictEqual(statusMissing.statusCode, 404);

  const preview = publicEmployeeRates({
    email: "rahul@mydgv.com",
    accessRow: { status: "ACTIVE" },
    profile: { designation: "Free text" },
    ratesItem: {
      status: "ACTIVE",
      internalHourlyRate: 2.25,
      designationId: "seo",
    },
    designation: des,
  });
  assert.strictEqual(preview.profileDesignation, "Free text");
  assert.notStrictEqual(preview.designationId, preview.profileDesignation);

  function snapshotWork(items) {
    return JSON.stringify(
      Object.entries(items)
        .filter(([k]) => k.startsWith(`${WORK}\0`))
        .sort(([a], [b]) => a.localeCompare(b))
    );
  }

  const renameEnv = ctx(SUPER, seedDes);
  const beforeRename = snapshotWork(renameEnv.ddb.items);
  const renamedOk = await handlePatchDesignation({
    ...renameEnv,
    designationId,
    body: { name: "SEO Lead", internalHourlyRate: 2 },
  });
  assert.strictEqual(renamedOk.statusCode, 400);
  assert.strictEqual(snapshotWork(renameEnv.ddb.items), beforeRename);

  const inactiveDes = {
    ...seedDes,
    [keyOf(WORK, "ENTITY#ORG_DESIGNATION", `DESIGNATION#${designationId}`)]: {
      ...seedDes[keyOf(WORK, "ENTITY#ORG_DESIGNATION", `DESIGNATION#${designationId}`)],
      status: "INACTIVE",
    },
  };
  const inactiveRate = await handlePatchDesignation({
    ...ctx(SUPER, inactiveDes),
    designationId,
    body: { internalHourlyRate: 9 },
  });
  assert.strictEqual(inactiveRate.statusCode, 400);
  assert.strictEqual(inactiveRate.body.error, RATES_FOR_ACTIVE);
  const newInactive = await handlePutEmployee({
    ...ctx(SUPER, inactiveDes),
    email: "rahul@mydgv.com",
    body: { designationId },
  });
  assert.strictEqual(newInactive.statusCode, 400);

  const legacyRates = await handleGetEmployee({
    ...ctx(SUPER, {
      ...seedDes,
      [keyOf(WORK, "USER#rahul@mydgv.com", COST_RATES_SK)]: {
        PK: "USER#rahul@mydgv.com",
        SK: COST_RATES_SK,
        type: TYPE_EMPLOYEE_COST_RATES,
        email: "rahul@mydgv.com",
        designationId: "legacy-seo",
        internalHourlyRate: null,
        externalHourlyRate: null,
        status: "ACTIVE",
      },
    }),
    email: "rahul@mydgv.com",
  });
  assert.strictEqual(legacyRates.body.employee.resolved.internal.rate, 4);
  assert.strictEqual(legacyRates.body.employee.designationName, "SEO Executive");

  const createDupEnv = ctx(SUPER, seedDes);
  const beforeCreateDup = snapshotWork(createDupEnv.ddb.items);
  const createDup = await handleCreateDesignation({
    ...createDupEnv,
    body: { name: "SEO Executive" },
  });
  assert.strictEqual(createDup.statusCode, 400);
  assert.strictEqual(createDup.body.error, CREATED_ON_DEPARTMENT_PAGE);
  assert.strictEqual(snapshotWork(createDupEnv.ddb.items), beforeCreateDup);

  const txConflictEnv = ctx(SUPER, seedDes);
  const beforeTxConflict = snapshotWork(txConflictEnv.ddb.items);
  const origSend = txConflictEnv.ddb.send.bind(txConflictEnv.ddb);
  txConflictEnv.ddb.send = async (command) => {
    if (command instanceof TransactWriteCommand) {
      const err = new Error("tx conflict");
      err.name = "TransactionCanceledException";
      err.CancellationReasons = [
        { Code: "TransactionConflict" },
        { Code: "None" },
        { Code: "None" },
      ];
      throw err;
    }
    return origSend(command);
  };
  const txConflict = await handlePatchDesignation({
    ...txConflictEnv,
    designationId,
    body: { internalHourlyRate: 6 },
  });
  assert.strictEqual(txConflict.statusCode, 500);
  assert.notStrictEqual(txConflict.body.error, NAME_DUPLICATE);
  assert.strictEqual(snapshotWork(txConflictEnv.ddb.items), beforeTxConflict);

  const defaulted = await handlePutEmployee({
    ...ctx(SUPER, seedDes),
    email: "rahul@mydgv.com",
    body: { internalHourlyRate: 1.5, externalHourlyRate: 2.5 },
  });
  assert.strictEqual(defaulted.statusCode, 201);
  assert.strictEqual(defaulted.body.employee.designationId, designationId);
  assert.strictEqual(defaulted.body.employee.internalHourlyRate, 1.5);

  const secondId = "seo-lead";
  const twoPairs = {
    ...seedDes,
    [keyOf(WORK, "ENTITY#ORG_DESIGNATION", `DESIGNATION#${secondId}`)]: {
      PK: "ENTITY#ORG_DESIGNATION",
      SK: `DESIGNATION#${secondId}`,
      type: "ORG_DESIGNATION",
      designationId: secondId,
      departmentId: "seo-digital-marketing",
      track: "SEO",
      name: "SEO Lead",
      status: "ACTIVE",
      internalHourlyRate: 7,
      externalHourlyRate: 9,
    },
    [keyOf(PROFILE, "USER#rahul@mydgv.com", "PROFILE")]: {
      ...seedAccess()[keyOf(PROFILE, "USER#rahul@mydgv.com", "PROFILE")],
      departmentDesignations: [
        { departmentId: "seo-digital-marketing", designationId },
        { departmentId: "seo-digital-marketing", designationId: secondId },
      ],
    },
  };
  const ambiguous = await handlePutEmployee({
    ...ctx(SUPER, twoPairs),
    email: "rahul@mydgv.com",
    body: { internalHourlyRate: 3 },
  });
  assert.strictEqual(ambiguous.statusCode, 201);
  assert.strictEqual(ambiguous.body.employee.designationId, null);
  assert.strictEqual(ambiguous.body.employee.internalHourlyRate, 3);

  const staleEnv = ctx(SUPER, {
    ...twoPairs,
    [keyOf(WORK, "USER#rahul@mydgv.com", COST_RATES_SK)]: {
      PK: "USER#rahul@mydgv.com",
      SK: COST_RATES_SK,
      type: TYPE_EMPLOYEE_COST_RATES,
      email: "rahul@mydgv.com",
      designationId: "legacy-seo",
      internalHourlyRate: 3,
      externalHourlyRate: 4,
      status: "ACTIVE",
    },
  });
  const stale = await handlePutEmployee({
    ...staleEnv,
    email: "rahul@mydgv.com",
    body: { internalHourlyRate: 3.5 },
  });
  assert.strictEqual(stale.statusCode, 400);
  assert.ok(stale.body.error.includes("Choose an assigned costing designation"));
  assert.strictEqual(
    staleEnv.ddb.items[keyOf(WORK, "USER#rahul@mydgv.com", COST_RATES_SK)].internalHourlyRate,
    3
  );

  const chosen = await handlePutEmployee({
    ...ctx(SUPER, twoPairs),
    email: "rahul@mydgv.com",
    body: {
      designationId: secondId,
      internalHourlyRate: 3,
      externalHourlyRate: 4,
    },
  });
  assert.strictEqual(chosen.statusCode, 201);
  assert.strictEqual(chosen.body.employee.designationId, secondId);
  assert.strictEqual(chosen.body.employee.externalHourlyRate, 4);

  const clearedChoice = await handlePutEmployee({
    ...ctx(SUPER, {
      ...twoPairs,
      [keyOf(WORK, "USER#rahul@mydgv.com", COST_RATES_SK)]: {
        PK: "USER#rahul@mydgv.com",
        SK: COST_RATES_SK,
        type: TYPE_EMPLOYEE_COST_RATES,
        email: "rahul@mydgv.com",
        designationId: secondId,
        internalHourlyRate: 3,
        externalHourlyRate: 4,
        status: "ACTIVE",
      },
    }),
    email: "rahul@mydgv.com",
    body: { designationId: "" },
  });
  assert.strictEqual(clearedChoice.statusCode, 200);
  assert.strictEqual(clearedChoice.body.employee.designationId, null);
  assert.strictEqual(clearedChoice.body.employee.internalHourlyRate, 3);
  assert.strictEqual(clearedChoice.body.employee.externalHourlyRate, 4);

  const legacyPatch = await handlePatchDesignation({
    ...ctx(SUPER, seedDes),
    designationId: "legacy-seo",
    body: { internalHourlyRate: 11 },
  });
  assert.strictEqual(legacyPatch.statusCode, 400);
  assert.strictEqual(
    legacyPatch.body.error,
    "Rates can only be edited for designations managed on the Department page."
  );

  const snapshotEnv = ctx(SUPER, {
    ...seedDes,
    [keyOf(WORK, "TASK#t-costed", "COST#rahul@mydgv.com")]: {
      PK: "TASK#t-costed",
      SK: "COST#rahul@mydgv.com",
      status: "COSTED",
      designationId,
      hourlyRateUsd: 2.25,
      amountUsd: 6.75,
    },
  });
  const beforeSnapshot = JSON.stringify(
    snapshotEnv.ddb.items[keyOf(WORK, "TASK#t-costed", "COST#rahul@mydgv.com")]
  );
  const afterSnapshotPut = await handlePutEmployee({
    ...snapshotEnv,
    email: "rahul@mydgv.com",
    body: { designationId, internalHourlyRate: 9 },
  });
  assert.strictEqual(afterSnapshotPut.statusCode, 201);
  assert.strictEqual(
    JSON.stringify(
      snapshotEnv.ddb.items[keyOf(WORK, "TASK#t-costed", "COST#rahul@mydgv.com")]
    ),
    beforeSnapshot
  );

  const malformedAdmin = await handleMalformedPath(ctx(ADMIN));
  assert.strictEqual(malformedAdmin.statusCode, 403);
  const malformedEnv = ctx(SUPER);
  const putsBefore = malformedEnv.ddb.puts.length;
  const malformedOk = await handleMalformedPath(malformedEnv);
  assert.strictEqual(malformedOk.statusCode, 400);
  assert.strictEqual(malformedOk.body.error, PATH_INVALID);
  assert.strictEqual(malformedEnv.ddb.puts.length, putsBefore);

  console.log("costRates.test.js ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

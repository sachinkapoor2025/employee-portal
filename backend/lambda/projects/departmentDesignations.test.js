const assert = require("assert");
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { handleCreateDepartment } = require("./departments");
const {
  INACTIVE_ASSIGN,
  NAME_DUPLICATE,
  WRONG_DEPARTMENT,
  handleCreateDesignation,
  handleDesignationStatus,
  handleListDesignations,
  handlePatchDesignation,
  resolveDepartmentDesignations,
} = require("./departmentDesignations");
const { mergeProfileForSave, profileFieldsForActor } = require("./departments");

const WORK = "work";
const ACCESS = "access";

function keyOf(table, pk, sk) {
  return `${table}\0${pk}\0${sk}`;
}

function memoryDdb(seed = {}) {
  const items = { ...seed };
  return {
    async send(command) {
      if (command instanceof GetCommand) {
        const key = keyOf(
          command.input.TableName,
          command.input.Key.PK,
          command.input.Key.SK
        );
        return items[key] ? { Item: { ...items[key] } } : {};
      }
      if (command instanceof PutCommand) {
        const item = command.input.Item;
        items[keyOf(command.input.TableName, item.PK, item.SK)] = { ...item };
        return {};
      }
      if (command instanceof QueryCommand) {
        const pk = command.input.ExpressionAttributeValues[":pk"];
        const sk = command.input.ExpressionAttributeValues[":sk"] || "";
        const found = Object.entries(items)
          .filter(([key]) => key.startsWith(`${command.input.TableName}\0${pk}\0`))
          .map(([, item]) => item)
          .filter((item) => !sk || String(item.SK).startsWith(sk));
        return { Items: found };
      }
      if (command instanceof TransactWriteCommand) {
        for (const entry of command.input.TransactItems) {
          if (!entry.Put) continue;
          const item = entry.Put.Item;
          const key = keyOf(entry.Put.TableName, item.PK, item.SK);
          if (
            String(entry.Put.ConditionExpression || "").includes("attribute_not_exists") &&
            items[key]
          ) {
            const err = new Error("conditional");
            err.name = "TransactionCanceledException";
            err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
            throw err;
          }
        }
        for (const entry of command.input.TransactItems) {
          if (entry.Put) {
            const item = entry.Put.Item;
            items[keyOf(entry.Put.TableName, item.PK, item.SK)] = { ...item };
          }
          if (entry.Delete) {
            delete items[
              keyOf(entry.Delete.TableName, entry.Delete.Key.PK, entry.Delete.Key.SK)
            ];
          }
        }
        return {};
      }
      throw new Error(command.constructor.name);
    },
  };
}

const admin = { email: "admin@mydgv.com", isAdmin: true };
const employee = { email: "person@mydgv.com", isAdmin: false };

function access(email, role) {
  return {
    [keyOf(ACCESS, email, email)]: {
      PK: email,
      SK: email,
      email,
      role,
      status: "ACTIVE",
    },
  };
}

(async () => {
  const ddb = memoryDdb({
    ...access(admin.email, "ADMIN"),
    ...access(employee.email, "EMPLOYEE"),
  });
  const created = await handleCreateDepartment({
    user: admin,
    body: { name: "Research", description: "Labs" },
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
  });
  const departmentId = created.body.department.departmentId;
  const other = await handleCreateDepartment({
    user: admin,
    body: { name: "Operations", description: "" },
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
  });
  const otherId = other.body.department.departmentId;

  const empty = await handleListDesignations({
    user: admin,
    departmentId,
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    admin: true,
  });
  assert.strictEqual(empty.statusCode, 200);
  assert.deepStrictEqual(empty.body.designations, []);

  const denied = await handleCreateDesignation({
    user: employee,
    departmentId,
    body: { name: "Analyst", track: "Research", sortOrder: 1 },
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
  });
  assert.strictEqual(denied.statusCode, 403);

  const first = await handleCreateDesignation({
    user: admin,
    departmentId,
    body: { name: "Analyst", track: "Research", sortOrder: 1 },
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
  });
  assert.strictEqual(first.statusCode, 201);
  const designationId = first.body.designation.designationId;
  assert.strictEqual(first.body.designation.departmentId, departmentId);

  const duplicate = await handleCreateDesignation({
    user: admin,
    departmentId,
    body: { name: " analyst ", track: "Research" },
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
  });
  assert.strictEqual(duplicate.statusCode, 409);
  assert.strictEqual(duplicate.body.error, NAME_DUPLICATE);

  const sameNameOtherDepartment = await handleCreateDesignation({
    user: admin,
    departmentId: otherId,
    body: { name: "Analyst", track: "Research", sortOrder: 1 },
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
  });
  assert.strictEqual(sameNameOtherDepartment.statusCode, 201);

  const renamed = await handlePatchDesignation({
    user: admin,
    departmentId,
    designationId,
    body: { name: "Senior Analyst" },
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
  });
  assert.strictEqual(renamed.body.designation.designationId, designationId);
  assert.strictEqual(renamed.body.designation.name, "Senior Analyst");

  const inactive = await handleDesignationStatus({
    user: admin,
    departmentId,
    designationId,
    body: { status: "INACTIVE" },
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
  });
  assert.strictEqual(inactive.body.designation.status, "INACTIVE");
  const stillThere = await handleListDesignations({
    user: admin,
    departmentId,
    ddb,
    tableName: WORK,
    accessTable: ACCESS,
    admin: true,
  });
  assert.strictEqual(stillThere.body.designations.length, 1);

  const freshInactive = await resolveDepartmentDesignations({
    ddb,
    tableName: WORK,
    departmentIds: [departmentId],
    requested: [{ departmentId, designationId }],
    existingProfile: {},
  });
  assert.strictEqual(freshInactive.ok, false);
  assert.strictEqual(freshInactive.error, INACTIVE_ASSIGN);

  const kept = await resolveDepartmentDesignations({
    ddb,
    tableName: WORK,
    departmentIds: [departmentId, otherId],
    requested: [
      { departmentId, designationId },
      {
        departmentId: otherId,
        designationId: sameNameOtherDepartment.body.designation.designationId,
      },
    ],
    existingProfile: {
      departmentDesignations: [{ departmentId, designationId }],
    },
  });
  assert.strictEqual(kept.ok, true);
  assert.strictEqual(kept.departmentDesignations.length, 2);

  const wrong = await resolveDepartmentDesignations({
    ddb,
    tableName: WORK,
    departmentIds: [otherId],
    requested: [{ departmentId: otherId, designationId }],
    existingProfile: {},
  });
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(wrong.error, WRONG_DEPARTMENT);

  const existing = {
    name: "Person",
    designation: "Free text",
    imageS3Key: "profiles/a.jpg",
    hrDocuments: [{ documentId: "doc" }],
    resignations: [{ id: "exit" }],
    department: "Engineering",
  };
  const saved = mergeProfileForSave({
    existing,
    profileData: profileFieldsForActor({
      isAdmin: true,
      profileData: { name: "Person Updated" },
    }),
    email: "person@mydgv.com",
    membership: {
      departmentIds: [departmentId, otherId],
      primaryDepartmentId: departmentId,
      departmentDesignations: kept.departmentDesignations,
    },
  });
  assert.strictEqual(saved.imageS3Key, "profiles/a.jpg");
  assert.strictEqual(saved.hrDocuments[0].documentId, "doc");
  assert.strictEqual(saved.resignations[0].id, "exit");
  assert.strictEqual(saved.designation, "Free text");
  assert.strictEqual(saved.departmentDesignations.length, 2);
  assert.strictEqual(saved.primaryDepartmentId, departmentId);

  console.log("departmentDesignations.test.js ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

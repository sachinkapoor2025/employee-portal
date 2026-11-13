const assert = require("assert");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  INACTIVE_ASSIGN,
  NAME_DUPLICATE,
  PRIMARY_INVALID,
  SEED_DEPARTMENTS,
  adminDepartmentsPathMatch,
  departmentIdPathMatch,
  handleCreateDepartment,
  handleDepartmentStatus,
  handleGetMembership,
  handleListDepartments,
  handlePatchDepartment,
  handlePutMembership,
  membershipPathMatch,
  mergeProfileForSave,
  migrationPatch,
  planProfileDepartmentMigration,
  profileFieldsForActor,
  publicDepartmentsPathMatch,
  resolveMembership,
} = require("./departments");

const WORK = "work";
const ACCESS = "access";
const PROFILE = "profile";

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
        const key = keyOf(command.input.TableName, item.PK, item.SK);
        const cond = command.input.ConditionExpression || "";
        if (cond.includes("attribute_not_exists") && items[key]) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        if (cond.includes("attribute_exists") && !items[key]) {
          const err = new Error("conditional");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        items[key] = { ...item };
        return {};
      }
      if (command instanceof DeleteCommand) {
        const key = keyOf(
          command.input.TableName,
          command.input.Key.PK,
          command.input.Key.SK
        );
        const cond = command.input.ConditionExpression || "";
        const existing = items[key];
        if (cond.includes("attribute_exists") && !existing) {
          const err = new Error("conditional");
          err.name = "TransactionCanceledException";
          err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
          throw err;
        }
        if (
          cond.includes("departmentId = :departmentId") &&
          existing?.departmentId !==
            command.input.ExpressionAttributeValues[":departmentId"]
        ) {
          const err = new Error("conditional");
          err.name = "TransactionCanceledException";
          err.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
          throw err;
        }
        delete items[key];
        return {};
      }
      if (command instanceof QueryCommand) {
        const pk = command.input.ExpressionAttributeValues[":pk"];
        const sk = command.input.ExpressionAttributeValues[":sk"] || "";
        const found = Object.entries(items)
          .filter(([key]) => key.startsWith(`${command.input.TableName}\0${pk}\0`))
          .map(([, item]) => item)
          .filter((item) => !sk || String(item.SK).startsWith(sk));
        return { Items: found.map((item) => ({ ...item })) };
      }
      if (command instanceof ScanCommand) {
        const found = Object.entries(items)
          .filter(([key]) => key.startsWith(`${command.input.TableName}\0`))
          .map(([, item]) => ({ ...item }));
        return { Items: found };
      }
      if (command instanceof TransactWriteCommand) {
        const staged = [];
        for (const entry of command.input.TransactItems) {
          if (entry.Put) {
            const item = entry.Put.Item;
            const key = keyOf(entry.Put.TableName, item.PK, item.SK);
            if (
              String(entry.Put.ConditionExpression || "").includes(
                "attribute_not_exists"
              ) &&
              items[key]
            ) {
              const err = new Error("conditional");
              err.name = "TransactionCanceledException";
              err.CancellationReasons = command.input.TransactItems.map(() => ({
                Code: "None",
              }));
              err.CancellationReasons[staged.length] = {
                Code: "ConditionalCheckFailed",
              };
              throw err;
            }
            staged.push({ key, item });
          } else if (entry.Delete) {
            const key = keyOf(
              entry.Delete.TableName,
              entry.Delete.Key.PK,
              entry.Delete.Key.SK
            );
            staged.push({ key, item: null });
          }
        }
        for (const row of staged) {
          if (row.item) items[row.key] = { ...row.item };
          else delete items[row.key];
        }
        return {};
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    },
  };
}

function accessRow(email, role) {
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

const admin = { email: "admin@mydgv.com", isAdmin: true };
const employee = { email: "person@mydgv.com", isAdmin: false };
const manager = { email: "manager@mydgv.com", isAdmin: true };

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`fail ${name}`);
    throw err;
  }
}

(async () => {
  await test("paths distinguish catalog and membership", () => {
    assert.strictEqual(publicDepartmentsPathMatch("/departments"), true);
    assert.strictEqual(publicDepartmentsPathMatch("/admin/departments"), false);
    assert.strictEqual(adminDepartmentsPathMatch("/admin/departments"), true);
    assert.strictEqual(
      departmentIdPathMatch("/admin/departments/it-software-development/status"),
      null
    );
    assert.strictEqual(
      membershipPathMatch("/admin/employees/a%40mydgv.com/departments").value,
      "a@mydgv.com"
    );
  });

  await test("admin can create, reject duplicate names, edit, and deactivate", async () => {
    const ddb = memoryDdb(accessRow(admin.email, "ADMIN"));
    const created = await handleCreateDepartment({
      user: admin,
      body: { name: "Research", description: "Labs" },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
    });
    assert.strictEqual(created.statusCode, 201);
    const id = created.body.department.departmentId;
    const duplicate = await handleCreateDepartment({
      user: admin,
      body: { name: " research " },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
    });
    assert.strictEqual(duplicate.statusCode, 409);
    assert.strictEqual(duplicate.body.error, NAME_DUPLICATE);
    const renamed = await handlePatchDepartment({
      user: admin,
      departmentId: id,
      body: { name: "Research Lab", description: "Updated" },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
    });
    assert.strictEqual(renamed.statusCode, 200);
    assert.strictEqual(renamed.body.department.departmentId, id);
    assert.strictEqual(renamed.body.department.name, "Research Lab");
    const inactive = await handleDepartmentStatus({
      user: admin,
      departmentId: id,
      body: { status: "INACTIVE" },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
    });
    assert.strictEqual(inactive.body.department.status, "INACTIVE");
    assert.strictEqual(inactive.body.department.departmentId, id);
  });

  await test("employees and managers cannot manage departments", async () => {
    const ddb = memoryDdb({
      ...accessRow(employee.email, "EMPLOYEE"),
      ...accessRow(manager.email, "MANAGER"),
    });
    const denied = await handleListDepartments({
      user: employee,
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      profileTable: PROFILE,
    });
    assert.strictEqual(denied.statusCode, 403);
    const managerDenied = await handleCreateDepartment({
      user: manager,
      body: { name: "Nope" },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
    });
    assert.strictEqual(managerDenied.statusCode, 403);
  });

  await test("membership accepts several departments and keeps an inactive one", async () => {
    const ddb = memoryDdb({
      ...accessRow(admin.email, "SUPER_ADMIN"),
      [keyOf(WORK, "ENTITY#DEPARTMENT", "DEPARTMENT#active")]: {
        PK: "ENTITY#DEPARTMENT",
        SK: "DEPARTMENT#active",
        type: "DEPARTMENT",
        departmentId: "active",
        name: "Active",
        status: "ACTIVE",
      },
      [keyOf(WORK, "ENTITY#DEPARTMENT", "DEPARTMENT#old")]: {
        PK: "ENTITY#DEPARTMENT",
        SK: "DEPARTMENT#old",
        type: "DEPARTMENT",
        departmentId: "old",
        name: "Old",
        status: "INACTIVE",
      },
      [keyOf(PROFILE, "USER#person@mydgv.com", "PROFILE")]: {
        PK: "USER#person@mydgv.com",
        SK: "PROFILE",
        email: "person@mydgv.com",
        name: "Person",
        department: "Legacy IT",
        departmentIds: ["old"],
        primaryDepartmentId: "old",
        imageS3Key: "profiles/person.jpg",
        hrDocuments: [{ documentId: "doc-1" }],
        resignations: [{ id: "r1" }],
      },
    });
    const freshInactive = resolveMembership({
      departmentIds: ["old"],
      primaryDepartmentId: "old",
      existingIds: [],
      departmentsById: new Map([
        ["old", { departmentId: "old", status: "INACTIVE" }],
      ]),
    });
    assert.strictEqual(freshInactive.ok, false);
    assert.strictEqual(freshInactive.error, INACTIVE_ASSIGN);
    const saved = await handlePutMembership({
      user: admin,
      email: "person@mydgv.com",
      body: {
        departmentIds: ["old", "active", "active"],
        primaryDepartmentId: "active",
      },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      profileTable: PROFILE,
    });
    assert.strictEqual(saved.statusCode, 200);
    assert.deepStrictEqual(saved.body.membership.departmentIds, ["old", "active"]);
    assert.strictEqual(saved.body.membership.primaryDepartmentId, "active");
    assert.strictEqual(saved.body.membership.legacyDepartment, "");
    const stored = await ddb.send(
      new GetCommand({
        TableName: PROFILE,
        Key: { PK: "USER#person@mydgv.com", SK: "PROFILE" },
      })
    );
    assert.strictEqual(stored.Item.imageS3Key, "profiles/person.jpg");
    assert.strictEqual(stored.Item.hrDocuments[0].documentId, "doc-1");
    assert.strictEqual(stored.Item.resignations[0].id, "r1");
    assert.strictEqual(stored.Item.name, "Person");
    const badPrimary = await handlePutMembership({
      user: admin,
      email: "person@mydgv.com",
      body: { departmentIds: ["active"], primaryDepartmentId: "old" },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      profileTable: PROFILE,
    });
    assert.strictEqual(badPrimary.statusCode, 400);
    assert.strictEqual(badPrimary.body.error, PRIMARY_INVALID);
    const read = await handleGetMembership({
      user: admin,
      email: "person@mydgv.com",
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      profileTable: PROFILE,
    });
    assert.strictEqual(read.statusCode, 200);
    const employeeDenied = await handlePutMembership({
      user: employee,
      email: "person@mydgv.com",
      body: { departmentIds: [] },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      profileTable: PROFILE,
    });
    assert.strictEqual(employeeDenied.statusCode, 403);
  });

  await test("profile save merges unrelated fields and ignores employee department edits", () => {
    const existing = {
      PK: "USER#person@mydgv.com",
      SK: "PROFILE",
      email: "person@mydgv.com",
      name: "Old",
      department: "Engineering",
      departmentIds: ["finance-accounting"],
      primaryDepartmentId: "finance-accounting",
      imageS3Key: "profiles/a.jpg",
      hrDocuments: [{ documentId: "pan" }],
      resignations: [{ id: "exit" }],
      designation: "Analyst",
    };
    const stripped = profileFieldsForActor({
      isAdmin: false,
      profileData: {
        name: "New",
        department: "Finance & Accounting",
        departmentIds: ["it-software-development"],
        primaryDepartmentId: "it-software-development",
        designation: "Lead",
      },
    });
    const saved = mergeProfileForSave({
      existing,
      profileData: stripped,
      email: "person@mydgv.com",
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    assert.strictEqual(saved.department, "Engineering");
    assert.deepStrictEqual(saved.departmentIds, ["finance-accounting"]);
    assert.strictEqual(saved.imageS3Key, "profiles/a.jpg");
    assert.strictEqual(saved.hrDocuments[0].documentId, "pan");
    assert.strictEqual(saved.resignations[0].id, "exit");
    assert.strictEqual(saved.designation, "Analyst");
    assert.strictEqual(saved.name, "New");
    const adminSaved = mergeProfileForSave({
      existing,
      profileData: { name: "Admin Edit", skill: "seo" },
      email: "person@mydgv.com",
      membership: {
        departmentIds: ["ai-automation", "finance-accounting"],
        primaryDepartmentId: "ai-automation",
      },
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    assert.deepStrictEqual(adminSaved.departmentIds, [
      "ai-automation",
      "finance-accounting",
    ]);
    assert.strictEqual(adminSaved.primaryDepartmentId, "ai-automation");
    assert.strictEqual(adminSaved.department, "Engineering");
    assert.strictEqual(adminSaved.designation, "Analyst");
    assert.strictEqual(adminSaved.imageS3Key, "profiles/a.jpg");
    assert.strictEqual(adminSaved.skill, "SEO");
  });

  await test("legacy department text matches only the full catalog name", () => {
    const catalog = SEED_DEPARTMENTS;
    const exact = planProfileDepartmentMigration(
      { department: "it - software development" },
      catalog
    );
    assert.strictEqual(exact.action, "match");
    assert.deepStrictEqual(exact.departmentIds, ["it-software-development"]);
    const shortName = planProfileDepartmentMigration({ department: "IT" }, catalog);
    assert.strictEqual(shortName.action, "unmatched");
    const title = planProfileDepartmentMigration(
      { department: "Software Engineer", designation: "Software Engineer", skill: "SEO" },
      catalog
    );
    assert.strictEqual(title.action, "unmatched");
    assert.strictEqual(migrationPatch(title).departmentIds, undefined);
    const already = planProfileDepartmentMigration(
      { department: "IT", departmentIds: ["finance-accounting"] },
      catalog
    );
    assert.strictEqual(already.action, "skip");
    const blank = planProfileDepartmentMigration({ department: "  " }, catalog);
    assert.strictEqual(blank.action, "skip");
  });

  await test("list counts employees in every assigned department", async () => {
    const ddb = memoryDdb({
      ...accessRow(admin.email, "ADMIN"),
      [keyOf(PROFILE, "USER#a@mydgv.com", "PROFILE")]: {
        PK: "USER#a@mydgv.com",
        SK: "PROFILE",
        departmentIds: ["it-software-development", "ai-automation"],
      },
      [keyOf(PROFILE, "USER#b@mydgv.com", "PROFILE")]: {
        PK: "USER#b@mydgv.com",
        SK: "PROFILE",
        departmentIds: ["ai-automation"],
      },
    });
    const listed = await handleListDepartments({
      user: admin,
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      profileTable: PROFILE,
    });
    assert.strictEqual(listed.statusCode, 200);
    const ai = listed.body.departments.find(
      (row) => row.departmentId === "ai-automation"
    );
    const it = listed.body.departments.find(
      (row) => row.departmentId === "it-software-development"
    );
    assert.strictEqual(ai.employeeCount, 2);
    assert.strictEqual(it.employeeCount, 1);
    assert.strictEqual(listed.body.departments.length >= 8, true);
  });

  await test("membership preserves a valid costing designation and rejects a silent substitute", async () => {
    const ddb = memoryDdb({
      ...accessRow(admin.email, "ADMIN"),
      ...accessRow("person@mydgv.com", "EMPLOYEE"),
      [keyOf(WORK, "ENTITY#DEPARTMENT", "DEPARTMENT#seo")]: {
        PK: "ENTITY#DEPARTMENT",
        SK: "DEPARTMENT#seo",
        type: "DEPARTMENT",
        departmentId: "seo",
        name: "SEO",
        status: "ACTIVE",
      },
      [keyOf(WORK, "ENTITY#DEPARTMENT", "DEPARTMENT#sales")]: {
        PK: "ENTITY#DEPARTMENT",
        SK: "DEPARTMENT#sales",
        type: "DEPARTMENT",
        departmentId: "sales",
        name: "Sales",
        status: "ACTIVE",
      },
      [keyOf(WORK, "ENTITY#ORG_DESIGNATION", "DESIGNATION#seo-role")]: {
        PK: "ENTITY#ORG_DESIGNATION",
        SK: "DESIGNATION#seo-role",
        type: "ORG_DESIGNATION",
        designationId: "seo-role",
        departmentId: "seo",
        name: "SEO Specialist",
        status: "ACTIVE",
      },
      [keyOf(WORK, "ENTITY#ORG_DESIGNATION", "DESIGNATION#sales-role")]: {
        PK: "ENTITY#ORG_DESIGNATION",
        SK: "DESIGNATION#sales-role",
        type: "ORG_DESIGNATION",
        designationId: "sales-role",
        departmentId: "sales",
        name: "Sales Executive",
        status: "ACTIVE",
      },
      [keyOf(PROFILE, "USER#person@mydgv.com", "PROFILE")]: {
        PK: "USER#person@mydgv.com",
        SK: "PROFILE",
        email: "person@mydgv.com",
        name: "Person",
        imageS3Key: "profiles/person.jpg",
        departmentIds: ["seo", "sales"],
        primaryDepartmentId: "seo",
        departmentDesignations: [
          { departmentId: "seo", designationId: "seo-role" },
          { departmentId: "sales", designationId: "sales-role" },
        ],
      },
      [keyOf(WORK, "USER#person@mydgv.com", "COST_RATES")]: {
        PK: "USER#person@mydgv.com",
        SK: "COST_RATES",
        type: "EMPLOYEE_COST_RATES",
        email: "person@mydgv.com",
        designationId: "seo-role",
        internalHourlyRate: 4,
        externalHourlyRate: 8,
        status: "ACTIVE",
      },
    });
    const kept = await handlePutMembership({
      user: admin,
      email: "person@mydgv.com",
      body: { departmentIds: ["seo", "sales"], primaryDepartmentId: "sales" },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      profileTable: PROFILE,
    });
    assert.strictEqual(kept.statusCode, 200);
    assert.strictEqual(kept.body.membership.costingDesignationId, "seo-role");
    const keptRates = await ddb.send(
      new GetCommand({
        TableName: WORK,
        Key: { PK: "USER#person@mydgv.com", SK: "COST_RATES" },
      })
    );
    assert.strictEqual(keptRates.Item.internalHourlyRate, 4);
    const removed = await handlePutMembership({
      user: admin,
      email: "person@mydgv.com",
      body: { departmentIds: ["sales"], primaryDepartmentId: "sales" },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      profileTable: PROFILE,
    });
    assert.strictEqual(removed.statusCode, 400);
    const unchangedProfile = await ddb.send(
      new GetCommand({
        TableName: PROFILE,
        Key: { PK: "USER#person@mydgv.com", SK: "PROFILE" },
      })
    );
    assert.strictEqual(unchangedProfile.Item.departmentIds[0], "seo");
    const chosen = await handlePutMembership({
      user: admin,
      email: "person@mydgv.com",
      body: {
        departmentIds: ["sales"],
        primaryDepartmentId: "sales",
        costingDesignationId: "sales-role",
      },
      ddb,
      tableName: WORK,
      accessTable: ACCESS,
      profileTable: PROFILE,
    });
    assert.strictEqual(chosen.statusCode, 200);
    assert.strictEqual(chosen.body.membership.costingDesignationId, "sales-role");
    const chosenRates = await ddb.send(
      new GetCommand({
        TableName: WORK,
        Key: { PK: "USER#person@mydgv.com", SK: "COST_RATES" },
      })
    );
    assert.strictEqual(chosenRates.Item.externalHourlyRate, 8);
    assert.strictEqual(chosenRates.Item.designationId, "sales-role");
    const chosenProfile = await ddb.send(
      new GetCommand({
        TableName: PROFILE,
        Key: { PK: "USER#person@mydgv.com", SK: "PROFILE" },
      })
    );
    assert.strictEqual(chosenProfile.Item.imageS3Key, "profiles/person.jpg");
    const managerDenied = await handlePutMembership({
      user: manager,
      email: "person@mydgv.com",
      body: { departmentIds: ["sales"] },
      ddb: memoryDdb(accessRow(manager.email, "MANAGER")),
      tableName: WORK,
      accessTable: ACCESS,
      profileTable: PROFILE,
    });
    assert.strictEqual(managerDenied.statusCode, 403);
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

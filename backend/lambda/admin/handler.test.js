process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.WORK_TABLE = "WorkTasks";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.USER_POOL_ID = "test-pool";
process.env.AWS_REGION = "ap-south-1";

const assert = require("assert");
const { handler, setClientsForTests } = require("./handler");
const {
  canManageUserAccessLifecycle,
  canAssignPortalRole,
  ROLES,
} = require("../common/roles");

assert.strictEqual(canManageUserAccessLifecycle(ROLES.SUPER_ADMIN), true);
assert.strictEqual(canManageUserAccessLifecycle(ROLES.ADMIN), false);
assert.strictEqual(canManageUserAccessLifecycle(ROLES.MANAGER), false);
assert.strictEqual(canAssignPortalRole(ROLES.ADMIN, ROLES.SUPER_ADMIN), false);
assert.strictEqual(canAssignPortalRole(ROLES.ADMIN, ROLES.ADMIN), true);
assert.strictEqual(canAssignPortalRole(ROLES.SUPER_ADMIN, ROLES.SUPER_ADMIN), true);

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function adminEvent(actorEmail, body) {
  return {
    httpMethod: "POST",
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: {
          email: actorEmail,
          "cognito:groups": ["Admin"],
        },
      },
    },
  };
}

function createFake({ access = {} } = {}) {
  const updates = [];
  const deletes = [];
  const cognitoCalls = [];
  return {
    updates,
    deletes,
    cognitoCalls,
    ddb: {
      send: async (cmd) => {
        const input = cmd.input || {};
        if (input.UpdateExpression) {
          updates.push(input);
          return {};
        }
        if (cmd.constructor?.name === "DeleteCommand") {
          deletes.push(input);
          return {};
        }
        if (input.Key) {
          return { Item: access[String(input.Key.PK || "").toLowerCase()] || null };
        }
        return { Items: [] };
      },
    },
    cognito: {
      send: async (cmd) => {
        cognitoCalls.push(cmd.constructor?.name || "CognitoCommand");
        return {};
      },
    },
  };
}

function useFake(access) {
  const fake = createFake({ access });
  setClientsForTests({ ddb: fake.ddb, cognitoClient: fake.cognito });
  return fake;
}

function employeeGetUsersEvent() {
  return {
    httpMethod: "GET",
    requestContext: {
      authorizer: {
        claims: {
          email: "rahul@mydgv.com",
          "cognito:groups": ["Employee"],
        },
      },
    },
  };
}

(async () => {
  const adminAccess = {
    "admin@mydgv.com": { role: "ADMIN", status: "ACTIVE" },
    "boss@mydgv.com": { role: "SUPER_ADMIN", status: "ACTIVE" },
    "active@mydgv.com": { role: "EMPLOYEE", status: "ACTIVE" },
    "blocked@mydgv.com": { role: "EMPLOYEE", status: "BLOCKED" },
    "peer@mydgv.com": { role: "EMPLOYEE", status: "ACTIVE" },
  };

  {
    const fake = useFake(adminAccess);
    const res = parse(await handler(employeeGetUsersEvent()));
    assert.strictEqual(res.statusCode, 403, "employee GET /admin/users is denied");
    assert.strictEqual(res.body.error, "Admin access required");
    assert.strictEqual(fake.updates.length, 0);
  }

  {
    const links = [{ departmentId: "ai", designationId: "ai-eng" }];
    setClientsForTests({
      ddb: {
        send: async (cmd) => {
          const table = cmd.input?.TableName;
          if (table === process.env.USER_ACCESS_TABLE) {
            return {
              Items: [
                {
                  PK: "aisha@mydgv.com",
                  email: "aisha@mydgv.com",
                  role: "EMPLOYEE",
                  status: "ACTIVE",
                },
              ],
            };
          }
          if (table === process.env.USER_PROFILE_TABLE) {
            return {
              Items: [
                {
                  PK: "USER#aisha@mydgv.com",
                  email: "aisha@mydgv.com",
                  name: "Aisha",
                  empId: "DGV014",
                  department: "Engineering",
                  departmentIds: ["it", "ai"],
                  primaryDepartmentId: "ai",
                  departmentDesignations: links,
                  designation: "Old Title",
                  skill: "SKILL#X",
                },
              ],
            };
          }
          if (table === process.env.WORK_TABLE) {
            const pk = cmd.input?.ExpressionAttributeValues?.[":pk"];
            if (pk === "ENTITY#DEPARTMENT") {
              return {
                Items: [
                  {
                    type: "DEPARTMENT",
                    departmentId: "it",
                    name: "IT — Software Development",
                    status: "ACTIVE",
                  },
                  {
                    type: "DEPARTMENT",
                    departmentId: "ai",
                    name: "AI & Automation",
                    status: "ACTIVE",
                  },
                ],
              };
            }
            if (pk === "ENTITY#ORG_DESIGNATION") {
              return {
                Items: [
                  {
                    type: "ORG_DESIGNATION",
                    designationId: "ai-eng",
                    departmentId: "ai",
                    name: "AI Engineer",
                    status: "ACTIVE",
                  },
                ],
              };
            }
          }
          return { Items: [] };
        },
      },
      cognitoClient: { send: async () => ({}) },
    });
    const res = parse(
      await handler({
        httpMethod: "GET",
        requestContext: {
          authorizer: {
            claims: {
              email: "boss@mydgv.com",
              "cognito:groups": ["Admin"],
            },
          },
        },
      })
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].email, "aisha@mydgv.com");
    assert.strictEqual(res.body[0].name, "Aisha");
    assert.strictEqual(res.body[0].empId, "DGV014");
    assert.deepStrictEqual(res.body[0].departmentIds, ["it", "ai"]);
    assert.strictEqual(res.body[0].primaryDepartmentId, "ai");
    assert.deepStrictEqual(res.body[0].departmentDesignations, links);
    assert.strictEqual(res.body[0].department, "AI & Automation, IT — Software Development");
    assert.strictEqual(res.body[0].designation, "AI Engineer");
    assert.notStrictEqual(res.body[0].department, "Engineering");
    assert.notStrictEqual(res.body[0].designation, "Old Title");
    assert.strictEqual(res.body[0].skill, "SKILL#X");
  }

  {
    setClientsForTests({
      ddb: {
        send: async (cmd) => {
          const table = cmd.input?.TableName;
          if (table === process.env.USER_ACCESS_TABLE) {
            return {
              Items: [
                {
                  PK: "akash.yadav@mydgv.com",
                  SK: "akash.yadav@mydgv.com",
                  email: "akash.yadav@mydgv.com",
                  role: "EMPLOYEE",
                  status: "ACTIVE",
                },
                {
                  PK: "EMAIL#akash.yadav@mydgv.com",
                  SK: "EMAIL#akash.yadav@mydgv.com",
                  loginEmail: "akash.yadav@mydgv.com",
                },
                {
                  PK: "ankit.verma@mydgv.com",
                  SK: "ankit.verma@mydgv.com",
                  email: "ankit.verma@mydgv.com",
                  role: "ADMIN",
                  status: "BLOCKED",
                },
                {
                  PK: "EMAIL#ankit.verma@mydgv.com",
                  SK: "EMAIL#ankit.verma@mydgv.com",
                  loginEmail: "ankit.verma@mydgv.com",
                },
              ],
            };
          }
          if (table === process.env.USER_PROFILE_TABLE) {
            return {
              Items: [
                {
                  PK: "USER#akash.yadav@mydgv.com",
                  SK: "PROFILE",
                  email: "akash.yadav@mydgv.com",
                  name: "Akash",
                  empId: "DGV010",
                  designation: "Engineer",
                },
                {
                  PK: "USER#ankit.verma@mydgv.com",
                  SK: "PROFILE",
                  email: "ankit.verma@mydgv.com",
                  name: "Ankit",
                  empId: "DGV011",
                  designation: "Lead",
                },
              ],
            };
          }
          return { Items: [] };
        },
      },
      cognitoClient: { send: async () => ({}) },
    });
    const res = parse(
      await handler({
        httpMethod: "GET",
        requestContext: {
          authorizer: {
            claims: {
              email: "boss@mydgv.com",
              "cognito:groups": ["Admin"],
            },
          },
        },
      })
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
      res.body.map((user) => user.email),
      ["akash.yadav@mydgv.com", "ankit.verma@mydgv.com"]
    );
    assert.strictEqual(res.body.some((user) => user.email.startsWith("email#")), false);
    const akash = res.body.find((user) => user.email === "akash.yadav@mydgv.com");
    const ankit = res.body.find((user) => user.email === "ankit.verma@mydgv.com");
    assert.strictEqual(akash.role, "EMPLOYEE");
    assert.strictEqual(akash.status, "ACTIVE");
    assert.strictEqual(akash.name, "Akash");
    assert.strictEqual(akash.empId, "DGV010");
    assert.strictEqual(akash.designation, "");
    assert.strictEqual(ankit.role, "ADMIN");
    assert.strictEqual(ankit.status, "BLOCKED");
    assert.strictEqual(ankit.name, "Ankit");
    assert.strictEqual(ankit.empId, "DGV011");
    assert.strictEqual(ankit.designation, "");
  }

  {
    const fake = useFake(adminAccess);
    const res = parse(
      await handler(
        adminEvent("admin@mydgv.com", {
          email: "active@mydgv.com",
          action: "deactivate",
        })
      )
    );
    assert.strictEqual(res.statusCode, 403, "A: ADMIN cannot deactivate");
    assert.strictEqual(fake.updates.length, 0);
  }

  {
    const fake = useFake(adminAccess);
    const res = parse(
      await handler(
        adminEvent("admin@mydgv.com", {
          email: "blocked@mydgv.com",
          action: "activate",
        })
      )
    );
    assert.strictEqual(res.statusCode, 403, "B: ADMIN cannot activate");
    assert.strictEqual(fake.updates.length, 0);
  }

  {
    const fake = useFake(adminAccess);
    const res = parse(
      await handler(
        adminEvent("admin@mydgv.com", {
          email: "peer@mydgv.com",
          action: "delete",
        })
      )
    );
    assert.strictEqual(res.statusCode, 403, "C: ADMIN cannot delete");
    assert.strictEqual(fake.deletes.length, 0);
    assert.strictEqual(fake.cognitoCalls.length, 0);
  }

  {
    const fake = useFake(adminAccess);
    const res = parse(
      await handler(
        adminEvent("boss@mydgv.com", {
          email: "active@mydgv.com",
          action: "deactivate",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200, "D: SUPER_ADMIN can deactivate");
    assert.strictEqual(fake.updates.length, 1);
    assert.ok(
      Object.values(fake.updates[0].ExpressionAttributeValues || {}).includes(
        "BLOCKED"
      )
    );
  }

  {
    const fake = useFake(adminAccess);
    const res = parse(
      await handler(
        adminEvent("boss@mydgv.com", {
          email: "blocked@mydgv.com",
          action: "activate",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200, "E: SUPER_ADMIN can activate");
    assert.strictEqual(fake.updates.length, 1);
    assert.ok(
      Object.values(fake.updates[0].ExpressionAttributeValues || {}).includes(
        "ACTIVE"
      )
    );
  }

  {
    const fake = useFake(adminAccess);
    const res = parse(
      await handler(
        adminEvent("boss@mydgv.com", {
          email: "peer@mydgv.com",
          action: "delete",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200, "F: SUPER_ADMIN can delete");
    assert.ok(fake.deletes.length >= 1);
    assert.ok(fake.cognitoCalls.includes("AdminDeleteUserCommand"));
  }

  {
    const fake = useFake(adminAccess);
    const res = parse(
      await handler(
        adminEvent("admin@mydgv.com", {
          email: "peer@mydgv.com",
          action: "changeRole",
          role: "SUPER_ADMIN",
        })
      )
    );
    assert.strictEqual(res.statusCode, 403, "G: ADMIN cannot promote user");
    assert.strictEqual(fake.updates.length, 0);
  }

  {
    const fake = useFake(adminAccess);
    const res = parse(
      await handler(
        adminEvent("admin@mydgv.com", {
          email: "admin@mydgv.com",
          action: "changeRole",
          role: "SUPER_ADMIN",
        })
      )
    );
    assert.strictEqual(res.statusCode, 403, "H: ADMIN cannot self-promote");
    assert.strictEqual(fake.updates.length, 0);
  }

  {
    const fake = useFake(adminAccess);
    const res = parse(
      await handler(
        adminEvent("boss@mydgv.com", {
          email: "peer@mydgv.com",
          action: "changeRole",
          role: "SUPER_ADMIN",
        })
      )
    );
    assert.strictEqual(res.statusCode, 200, "I: SUPER_ADMIN can assign SUPER_ADMIN");
    assert.strictEqual(fake.updates.length, 1);
    assert.ok(
      Object.values(fake.updates[0].ExpressionAttributeValues || {}).includes(
        "SUPER_ADMIN"
      )
    );
  }

  console.log("admin user-management authorization tests passed");

  const { authorizeTaskRead } = require("../projects/taskReadAccess");
  const WORK = process.env.WORK_TABLE;
  const ACCESS_TABLE = process.env.USER_ACCESS_TABLE;
  const BOSS = "boss@mydgv.com";
  const SOLE = "sole-admin@mydgv.com";
  const OTHER_ADMIN = "other-admin@mydgv.com";
  const MEMBER = "member@mydgv.com";
  const PROJECT = "proj-restricted-1";

  function createStore() {
    const items = [];
    const updates = [];
    const deletes = [];
    return {
      items,
      updates,
      deletes,
      seed(tableName, item) {
        const idx = items.findIndex(
          (row) =>
            row.TableName === tableName &&
            row.Item.PK === item.PK &&
            row.Item.SK === item.SK
        );
        const entry = { TableName: tableName, Item: { ...item } };
        if (idx >= 0) items[idx] = entry;
        else items.push(entry);
      },
      ddb: {
        send: async (cmd) => {
          const input = cmd.input || {};
          const name = cmd.constructor?.name || "";
          if (input.UpdateExpression) {
            updates.push(input);
            const row = items.find(
              (entry) =>
                entry.TableName === input.TableName &&
                entry.Item.PK === input.Key.PK &&
                entry.Item.SK === input.Key.SK
            );
            if (row && Object.values(input.ExpressionAttributeValues || {}).includes("BLOCKED")) {
              row.Item.status = "BLOCKED";
            }
            return {};
          }
          if (name === "DeleteCommand") {
            deletes.push(input);
            return {};
          }
          if (input.KeyConditionExpression) {
            const pk = input.ExpressionAttributeValues[":pk"];
            const sk = input.ExpressionAttributeValues[":sk"];
            return {
              Items: items
                .filter(
                  (entry) =>
                    entry.TableName === input.TableName &&
                    entry.Item.PK === pk &&
                    String(entry.Item.SK).startsWith(sk)
                )
                .map((entry) => ({ ...entry.Item })),
            };
          }
          if (input.Key) {
            const found = items.find(
              (entry) =>
                entry.TableName === input.TableName &&
                entry.Item.PK === input.Key.PK &&
                entry.Item.SK === input.Key.SK
            );
            return { Item: found ? { ...found.Item } : null };
          }
          return { Items: [] };
        },
      },
    };
  }

  function seedAccess(store, email, role, status = "ACTIVE") {
    store.seed(ACCESS_TABLE, {
      PK: email,
      SK: email,
      email,
      role,
      status,
    });
  }

  function seedRestrictedProject(store) {
    store.seed(WORK, {
      PK: "ENTITY#PROJECT",
      SK: `PROJECT#${PROJECT}`,
      projectId: PROJECT,
      name: "Restricted vault",
      status: "ACTIVE",
      accessMode: "RESTRICTED",
    });
  }

  function seedProjectAdmin(store, email) {
    store.seed(WORK, {
      PK: `USER#${email}`,
      SK: `PROJECT_ADMIN#${PROJECT}`,
      type: "PROJECT_ADMIN",
      projectId: PROJECT,
      email,
      status: "ACTIVE",
      taskVisibility: "ALL_PROJECT_TASKS",
    });
    seedProjectSideAdmin(store, email);
  }

  function seedProjectSideAdmin(store, email) {
    store.seed(WORK, {
      PK: `PROJECT#${PROJECT}`,
      SK: `PROJECT_ADMIN#${email}`,
      type: "PROJECT_ADMIN",
      projectId: PROJECT,
      email,
      status: "ACTIVE",
      taskVisibility: "ALL_PROJECT_TASKS",
    });
  }

  {
    const store = createStore();
    seedAccess(store, BOSS, "SUPER_ADMIN");
    seedAccess(store, SOLE, "ADMIN");
    seedRestrictedProject(store);
    seedProjectAdmin(store, SOLE);
    setClientsForTests({ ddb: store.ddb, cognitoClient: { send: async () => ({}) } });
    const res = parse(
      await handler(adminEvent(BOSS, { email: SOLE, action: "deactivate" }))
    );
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(store.updates.length, 0);
    assert.strictEqual(store.deletes.length, 0);
    const access = store.items.find(
      (row) => row.TableName === ACCESS_TABLE && row.Item.PK === SOLE
    );
    assert.strictEqual(access.Item.status, "ACTIVE");
  }

  {
    const store = createStore();
    seedAccess(store, BOSS, "SUPER_ADMIN");
    seedAccess(store, SOLE, "ADMIN");
    seedAccess(store, OTHER_ADMIN, "SUPER_ADMIN");
    seedRestrictedProject(store);
    seedProjectAdmin(store, SOLE);
    seedProjectAdmin(store, OTHER_ADMIN);
    setClientsForTests({ ddb: store.ddb, cognitoClient: { send: async () => ({}) } });
    const res = parse(
      await handler(adminEvent(BOSS, { email: SOLE, action: "deactivate" }))
    );
    assert.strictEqual(res.statusCode, 200);
    const access = store.items.find(
      (row) => row.TableName === ACCESS_TABLE && row.Item.PK === SOLE
    );
    const other = store.items.find(
      (row) => row.TableName === ACCESS_TABLE && row.Item.PK === OTHER_ADMIN
    );
    assert.strictEqual(access.Item.status, "BLOCKED");
    assert.strictEqual(other.Item.status, "ACTIVE");
    assert.ok(
      store.items.some(
        (row) => row.Item.PK === `PROJECT#${PROJECT}` && row.Item.SK === `PROJECT_ADMIN#${OTHER_ADMIN}`
      )
    );
  }

  {
    const store = createStore();
    seedAccess(store, BOSS, "SUPER_ADMIN");
    seedAccess(store, MEMBER, "EMPLOYEE");
    seedRestrictedProject(store);
    store.seed(WORK, {
      PK: `PROJECT#${PROJECT}`,
      SK: `MEMBER#${MEMBER}`,
      type: "PROJECT_MEMBER",
      projectId: PROJECT,
      email: MEMBER,
      status: "ACTIVE",
    });
    store.seed(WORK, {
      PK: "ENTITY#TASK",
      SK: "TASK#task-member-1",
      taskId: "task-member-1",
      projectId: PROJECT,
      title: "Member vault task",
      assignee: MEMBER,
      assignees: [MEMBER],
      archived: false,
    });
    store.seed(WORK, {
      PK: "TASK#task-member-1",
      SK: `ASSIGNMENT#${MEMBER}`,
      type: "ASSIGNMENT",
      taskId: "task-member-1",
      email: MEMBER,
      status: "TODO",
      removed: false,
    });
    setClientsForTests({ ddb: store.ddb, cognitoClient: { send: async () => ({}) } });
    const res = parse(
      await handler(adminEvent(BOSS, { email: MEMBER, action: "deactivate" }))
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(store.deletes.length, 0);
    const assignment = store.items.find(
      (row) => row.Item.PK === "TASK#task-member-1" && row.Item.SK === `ASSIGNMENT#${MEMBER}`
    );
    assert.ok(assignment);
    assert.strictEqual(assignment.Item.status, "TODO");
    const read = await authorizeTaskRead({
      ddb: store.ddb,
      tableName: WORK,
      accessTable: ACCESS_TABLE,
      user: { email: MEMBER },
      task: {
        taskId: "task-member-1",
        projectId: PROJECT,
        title: "Member vault task",
        assignee: MEMBER,
        assignees: [MEMBER],
      },
    });
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.allowed, false);
  }

  {
    const store = createStore();
    seedAccess(store, BOSS, "SUPER_ADMIN");
    seedAccess(store, SOLE, "ADMIN");
    seedRestrictedProject(store);
    seedProjectSideAdmin(store, SOLE);
    setClientsForTests({ ddb: store.ddb, cognitoClient: { send: async () => ({}) } });
    const res = parse(
      await handler(adminEvent(BOSS, { email: SOLE, action: "deactivate" }))
    );
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(store.updates.length, 0);
    const access = store.items.find(
      (row) => row.TableName === ACCESS_TABLE && row.Item.PK === SOLE
    );
    assert.strictEqual(access.Item.status, "ACTIVE");
    assert.ok(
      !store.items.some(
        (row) => row.Item.PK === `USER#${SOLE}` && String(row.Item.SK).startsWith("PROJECT_ADMIN#")
      )
    );
  }

  {
    const store = createStore();
    seedAccess(store, BOSS, "SUPER_ADMIN");
    seedAccess(store, SOLE, "ADMIN");
    seedAccess(store, OTHER_ADMIN, "SUPER_ADMIN");
    seedRestrictedProject(store);
    seedProjectSideAdmin(store, SOLE);
    seedProjectSideAdmin(store, OTHER_ADMIN);
    setClientsForTests({ ddb: store.ddb, cognitoClient: { send: async () => ({}) } });
    const res = parse(
      await handler(adminEvent(BOSS, { email: SOLE, action: "deactivate" }))
    );
    assert.strictEqual(res.statusCode, 200);
    const access = store.items.find(
      (row) => row.TableName === ACCESS_TABLE && row.Item.PK === SOLE
    );
    assert.strictEqual(access.Item.status, "BLOCKED");
    assert.ok(
      !store.items.some((row) => String(row.Item.PK).startsWith("USER#") && String(row.Item.SK).startsWith("PROJECT_ADMIN#"))
    );
  }

  {
    const store = createStore();
    seedAccess(store, BOSS, "SUPER_ADMIN");
    seedAccess(store, SOLE, "ADMIN");
    seedRestrictedProject(store);
    seedProjectSideAdmin(store, SOLE);
    const realSend = store.ddb.send.bind(store.ddb);
    store.ddb.send = async (cmd) => {
      const input = cmd.input || {};
      if (input.ExpressionAttributeValues && input.ExpressionAttributeValues[":pk"] === "ENTITY#PROJECT") {
        throw new Error("catalog query failed");
      }
      return realSend(cmd);
    };
    setClientsForTests({ ddb: store.ddb, cognitoClient: { send: async () => ({}) } });
    const res = parse(
      await handler(adminEvent(BOSS, { email: SOLE, action: "deactivate" }))
    );
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(store.updates.length, 0);
    const access = store.items.find(
      (row) => row.TableName === ACCESS_TABLE && row.Item.PK === SOLE
    );
    assert.strictEqual(access.Item.status, "ACTIVE");
  }

  function accessItem(store, email) {
    return store.items.find(
      (row) => row.TableName === ACCESS_TABLE && row.Item.PK === email
    );
  }

  function seedCatalog(store, projectId, extra = {}) {
    store.seed(WORK, {
      PK: "ENTITY#PROJECT",
      SK: `PROJECT#${projectId}`,
      projectId,
      name: projectId,
      status: "ACTIVE",
      accessMode: extra.accessMode || "OPEN",
      ...(extra.deletionStatus ? { deletionStatus: extra.deletionStatus } : {}),
    });
  }

  function seedSideAdmin(store, projectId, email) {
    store.seed(WORK, {
      PK: `PROJECT#${projectId}`,
      SK: `PROJECT_ADMIN#${email}`,
      type: "PROJECT_ADMIN",
      projectId,
      email,
      status: "ACTIVE",
      taskVisibility: "ALL_PROJECT_TASKS",
    });
  }

  {
    const store = createStore();
    const openId = "proj-open-1";
    const deletingId = "proj-deleting-1";
    seedAccess(store, BOSS, "SUPER_ADMIN");
    seedAccess(store, SOLE, "ADMIN");
    seedCatalog(store, openId, { accessMode: "OPEN" });
    seedCatalog(store, deletingId, {
      accessMode: "RESTRICTED",
      deletionStatus: "DELETING",
    });
    seedSideAdmin(store, openId, SOLE);
    seedSideAdmin(store, deletingId, SOLE);
    setClientsForTests({ ddb: store.ddb, cognitoClient: { send: async () => ({}) } });
    const res = parse(
      await handler(adminEvent(BOSS, { email: SOLE, action: "deactivate" }))
    );
    assert.strictEqual(res.statusCode, 200);
    assert.ok(
      Object.values(store.updates[0].ExpressionAttributeValues || {}).includes("BLOCKED")
    );
    assert.strictEqual(accessItem(store, SOLE).Item.status, "BLOCKED");
  }

  {
    const store = createStore();
    seedAccess(store, BOSS, "SUPER_ADMIN");
    seedAccess(store, SOLE, "ADMIN");
    seedRestrictedProject(store);
    seedProjectSideAdmin(store, SOLE);
    const realSend = store.ddb.send.bind(store.ddb);
    store.ddb.send = async (cmd) => {
      const values = (cmd.input || {}).ExpressionAttributeValues || {};
      if (String(values[":pk"] || "").startsWith("PROJECT#") && values[":sk"] === "PROJECT_ADMIN#") {
        throw new Error("project admin query failed");
      }
      return realSend(cmd);
    };
    setClientsForTests({ ddb: store.ddb, cognitoClient: { send: async () => ({}) } });
    const res = parse(
      await handler(adminEvent(BOSS, { email: SOLE, action: "deactivate" }))
    );
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(store.updates.length, 0);
    assert.strictEqual(accessItem(store, SOLE).Item.status, "ACTIVE");
  }

  {
    const store = createStore();
    seedAccess(store, BOSS, "SUPER_ADMIN");
    seedAccess(store, SOLE, "ADMIN");
    seedRestrictedProject(store);
    seedProjectSideAdmin(store, SOLE);
    const realSend = store.ddb.send.bind(store.ddb);
    store.ddb.send = async (cmd) => {
      const input = cmd.input || {};
      if (input.Key && input.Key.PK === SOLE && input.TableName === ACCESS_TABLE) {
        throw new Error("user access lookup failed");
      }
      return realSend(cmd);
    };
    setClientsForTests({ ddb: store.ddb, cognitoClient: { send: async () => ({}) } });
    const res = parse(
      await handler(adminEvent(BOSS, { email: SOLE, action: "deactivate" }))
    );
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(store.updates.length, 0);
    assert.strictEqual(accessItem(store, SOLE).Item.status, "ACTIVE");
  }

  {
    const store = createStore();
    const openId = "proj-open-page";
    seedAccess(store, BOSS, "SUPER_ADMIN");
    seedAccess(store, SOLE, "ADMIN");
    seedCatalog(store, openId, { accessMode: "OPEN" });
    seedRestrictedProject(store);
    seedProjectSideAdmin(store, SOLE);
    const realSend = store.ddb.send.bind(store.ddb);
    store.ddb.send = async (cmd) => {
      const input = cmd.input || {};
      const values = input.ExpressionAttributeValues || {};
      if (values[":pk"] === "ENTITY#PROJECT" && values[":sk"] === "PROJECT#") {
        const rows = store.items
          .filter(
            (entry) =>
              entry.TableName === WORK &&
              entry.Item.PK === "ENTITY#PROJECT" &&
              String(entry.Item.SK).startsWith("PROJECT#")
          )
          .map((entry) => entry.Item)
          .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
        if (!input.ExclusiveStartKey) {
          return {
            Items: [rows[0]],
            LastEvaluatedKey: { PK: rows[1].PK, SK: rows[1].SK },
          };
        }
        assert.strictEqual(input.ExclusiveStartKey.SK, `PROJECT#${PROJECT}`);
        return { Items: rows.slice(1) };
      }
      return realSend(cmd);
    };
    setClientsForTests({ ddb: store.ddb, cognitoClient: { send: async () => ({}) } });
    const res = parse(
      await handler(adminEvent(BOSS, { email: SOLE, action: "deactivate" }))
    );
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(store.updates.length, 0);
    assert.strictEqual(accessItem(store, SOLE).Item.status, "ACTIVE");
  }

  console.log("restricted project admin deactivation tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

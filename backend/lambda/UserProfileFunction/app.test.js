process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.WORK_TABLE = "WorkTasks";
process.env.USER_POOL_ID = "test-pool";
process.env.AWS_REGION = "ap-south-1";

const assert = require("assert");
const { handler, setClientsForTests } = require("./app");

const ACTOR = "admin@mydgv.com";
const EMPLOYEE = "notify@mydgv.com";
const LOGIN = "dgv@mydgv.com";
const ORDINARY = "employee@mydgv.com";
const DEPARTMENT_ID = "leadership";
const DESIGNATION_ID = "office-lead";

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function event(profile, extra = {}) {
  return {
    httpMethod: "POST",
    body: JSON.stringify({
      mode: "EDIT",
      email: EMPLOYEE,
      role: "SUPER_ADMIN",
      ...extra,
      profile,
    }),
    requestContext: {
      authorizer: {
        claims: {
          email: ACTOR,
          "cognito:groups": ["Admin"],
        },
      },
    },
  };
}

function keyOf(table, pk, sk) {
  return `${table}|${pk}|${sk}`;
}

function createFake({
  designationDepartmentId = DEPARTMENT_ID,
  actorRole = "ADMIN",
  actorStatus = "ACTIVE",
  includeActor = true,
  accessKey = EMPLOYEE,
  accessRole = "EMPLOYEE",
  profileLoginEmail = LOGIN,
  empId = "",
} = {}) {
  const store = new Map();
  if (includeActor) {
    store.set(keyOf("UserAccess", ACTOR, ACTOR), {
      PK: ACTOR,
      SK: ACTOR,
      email: ACTOR,
      role: actorRole,
      status: actorStatus,
    });
  }
  store.set(keyOf("UserAccess", accessKey, accessKey), {
    PK: accessKey,
    SK: accessKey,
    email: EMPLOYEE,
    role: accessRole,
    status: "ACTIVE",
  });
  store.set(keyOf("UserProfile", `USER#${EMPLOYEE}`, "PROFILE"), {
    PK: `USER#${EMPLOYEE}`,
    SK: "PROFILE",
    email: EMPLOYEE,
    empId,
    departmentIds: [DEPARTMENT_ID],
    primaryDepartmentId: DEPARTMENT_ID,
    department: "Leadership & Management",
    designation: "Coordinator",
    ...(profileLoginEmail ? { loginEmail: profileLoginEmail } : {}),
    phone: "000",
  });
  store.set(keyOf("UserAccess", ORDINARY, ORDINARY), {
    PK: ORDINARY,
    SK: ORDINARY,
    email: ORDINARY,
    role: "EMPLOYEE",
    status: "ACTIVE",
  });
  store.set(keyOf("UserProfile", `USER#${ORDINARY}`, "PROFILE"), {
    PK: `USER#${ORDINARY}`,
    SK: "PROFILE",
    email: ORDINARY,
    empId: "DGV100",
    name: "Ordinary Employee",
    phone: "111",
    department: "Delivery",
    departmentIds: [DEPARTMENT_ID],
    primaryDepartmentId: DEPARTMENT_ID,
    designation: "Coordinator",
  });
  store.set(keyOf("WorkTasks", "ENTITY#DEPARTMENT", `DEPARTMENT#${DEPARTMENT_ID}`), {
    PK: "ENTITY#DEPARTMENT",
    SK: `DEPARTMENT#${DEPARTMENT_ID}`,
    type: "DEPARTMENT",
    departmentId: DEPARTMENT_ID,
    status: "ACTIVE",
    name: "Leadership & Management",
  });
  store.set(
    keyOf("WorkTasks", "ENTITY#ORG_DESIGNATION", `DESIGNATION#${DESIGNATION_ID}`),
    {
      PK: "ENTITY#ORG_DESIGNATION",
      SK: `DESIGNATION#${DESIGNATION_ID}`,
      type: "ORG_DESIGNATION",
      designationId: DESIGNATION_ID,
      departmentId: designationDepartmentId,
      status: "ACTIVE",
      name: "Office Lead",
    }
  );
  const puts = [];
  const cognitoCalls = [];
  const commands = [];
  return {
    store,
    puts,
    cognitoCalls,
    commands,
    ddb: {
      send: async (cmd) => {
        const input = cmd.input || {};
        const name = cmd.constructor?.name;
        commands.push({
          name,
          table: input.TableName,
          pk: input.Key && input.Key.PK,
          sk: input.Key && input.Key.SK,
        });
        if (name === "GetCommand") {
          const item = store.get(keyOf(input.TableName, input.Key.PK, input.Key.SK));
          return { Item: item || null };
        }
        if (name === "QueryCommand") return { Items: [] };
        if (name === "PutCommand") {
          puts.push(input);
          return {};
        }
        if (name === "TransactWriteCommand") return {};
        return {};
      },
    },
    cognito: {
      send: async (cmd) => {
        cognitoCalls.push(cmd?.constructor?.name || "Cognito");
        const err = new Error("User does not exist.");
        err.name = "UserNotFoundException";
        throw err;
      },
    },
  };
}

function useFake(options) {
  const fake = createFake(options);
  setClientsForTests({ ddb: fake.ddb, cognitoClient: fake.cognito });
  return fake;
}

function designationProfile(extra = {}) {
  return {
    email: EMPLOYEE,
    departmentIds: [DEPARTMENT_ID],
    primaryDepartmentId: DEPARTMENT_ID,
    departmentDesignations: [
      { departmentId: DEPARTMENT_ID, designationId: DESIGNATION_ID },
    ],
    ...extra,
  };
}

function assertActorOnlyAccessRead(fake) {
  const access = fake.commands.filter((command) => command.table === "UserAccess");
  assert.ok(access.length > 0);
  assert.ok(
    access.every(
      (command) => command.name === "GetCommand" && command.pk === ACTOR && command.sk === ACTOR
    )
  );
  assert.strictEqual(access.some((command) => command.pk === EMPLOYEE), false);
  assert.strictEqual(fake.cognitoCalls.length, 0);
}

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
  await test("designation save does not require a Cognito user", async () => {
    const fake = useFake();
    const res = parse(
      await handler(
        event(
          designationProfile({
            department: "Injected Department",
            designation: "Injected Title",
          })
        )
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.message, "User saved successfully");
    assertActorOnlyAccessRead(fake);
    const profilePut = fake.puts.find(
      (input) => input.TableName === "UserProfile" && input.Item.SK === "PROFILE"
    );
    assert.ok(profilePut);
    assert.strictEqual(profilePut.Item.PK, `USER#${EMPLOYEE}`);
    assert.deepStrictEqual(profilePut.Item.departmentIds, [DEPARTMENT_ID]);
    assert.strictEqual(profilePut.Item.primaryDepartmentId, DEPARTMENT_ID);
    assert.deepStrictEqual(profilePut.Item.departmentDesignations, [
      { departmentId: DEPARTMENT_ID, designationId: DESIGNATION_ID },
    ]);
    assert.strictEqual(profilePut.Item.department, "Leadership & Management");
    assert.strictEqual(profilePut.Item.designation, "Coordinator");
    assert.strictEqual(profilePut.Item.loginEmail, "dgv@mydgv.com");
    assert.strictEqual(profilePut.Item.phone, "000");
  });

  await test("a submitted role does not update access or Cognito", async () => {
    const fake = useFake();
    const res = parse(
      await handler(
        event(
          {
            email: EMPLOYEE,
            loginEmail: "other@mydgv.com",
            departmentIds: [DEPARTMENT_ID],
            primaryDepartmentId: DEPARTMENT_ID,
            departmentDesignations: [
              { departmentId: DEPARTMENT_ID, designationId: DESIGNATION_ID },
            ],
          },
          { role: "SUPER_ADMIN" }
        )
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assertActorOnlyAccessRead(fake);
    const profilePut = fake.puts.find((input) => input.TableName === "UserProfile");
    assert.strictEqual(profilePut.Item.loginEmail, "dgv@mydgv.com");
    assert.strictEqual(
      fake.commands.some(
        (command) => command.table === "UserAccess" && command.name !== "GetCommand"
      ),
      false
    );
  });

  await test("an active super admin can edit a designation", async () => {
    const fake = useFake({ actorRole: "SUPER_ADMIN" });
    const res = parse(await handler(event(designationProfile())));
    assert.strictEqual(res.statusCode, 200);
    assertActorOnlyAccessRead(fake);
    const profilePut = fake.puts.find((input) => input.TableName === "UserProfile");
    assert.deepStrictEqual(profilePut.Item.departmentDesignations, [
      { departmentId: DEPARTMENT_ID, designationId: DESIGNATION_ID },
    ]);
    assert.strictEqual(profilePut.Item.loginEmail, "dgv@mydgv.com");
  });

  async function expectIneligible(options) {
    const fake = useFake(options);
    const res = parse(await handler(event(designationProfile({ loginEmail: "other@mydgv.com" }))));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "Admin required");
    assert.strictEqual(fake.puts.some((input) => input.TableName === "UserProfile"), false);
    assertActorOnlyAccessRead(fake);
  }

  await test("a blocked admin cannot edit a designation", async () => {
    await expectIneligible({ actorStatus: "BLOCKED" });
  });

  await test("a pending admin cannot edit a designation", async () => {
    await expectIneligible({ actorStatus: "PENDING" });
  });

  await test("an active manager cannot edit a designation", async () => {
    await expectIneligible({ actorRole: "MANAGER" });
  });

  await test("a missing actor access record cannot edit a designation", async () => {
    await expectIneligible({ includeActor: false });
  });

  await test("a designation from another department is rejected", async () => {
    const fake = useFake({ designationDepartmentId: "other-department" });
    const res = parse(
      await handler(
        event({
          email: EMPLOYEE,
          departmentIds: [DEPARTMENT_ID],
          primaryDepartmentId: DEPARTMENT_ID,
          departmentDesignations: [
            { departmentId: DEPARTMENT_ID, designationId: DESIGNATION_ID },
          ],
        })
      )
    );
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /does not belong to the selected department/i);
    assert.strictEqual(
      fake.puts.some((input) => input.TableName === "UserProfile"),
      false
    );
    assertActorOnlyAccessRead(fake);
  });

  function accessWrites(fake) {
    return fake.commands.filter(
      (command) => command.table === "UserAccess" && command.name !== "GetCommand"
    );
  }

  await test("DGV001 profile save keeps the login access row and skips Cognito", async () => {
    const fake = useFake({
      accessKey: LOGIN,
      accessRole: "SUPER_ADMIN",
      profileLoginEmail: null,
      empId: "DGV001",
    });
    const accessKey = keyOf("UserAccess", LOGIN, LOGIN);
    const beforeAccess = structuredClone(fake.store.get(accessKey));
    const res = parse(
      await handler(
        event(
          {
            ...designationProfile(),
            name: "DGV Admin",
            empId: "DGV001",
            phone: "000",
          },
          { role: "SUPER_ADMIN" }
        )
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fake.cognitoCalls, []);
    assert.deepStrictEqual(accessWrites(fake), []);
    assert.deepStrictEqual(fake.store.get(accessKey), beforeAccess);
    assert.strictEqual(fake.store.has(keyOf("UserAccess", EMPLOYEE, EMPLOYEE)), false);
    assertActorOnlyAccessRead(fake);
    const profilePut = fake.puts.find((input) => input.TableName === "UserProfile");
    assert.strictEqual(profilePut.Item.PK, `USER#${EMPLOYEE}`);
    assert.strictEqual(profilePut.Item.SK, "PROFILE");
    assert.strictEqual(profilePut.Item.email, EMPLOYEE);
    assert.strictEqual(profilePut.Item.empId, "DGV001");
    assert.strictEqual(profilePut.Item.phone, "000");
    assert.strictEqual(Object.hasOwn(profilePut.Item, "loginEmail"), false);
    assert.strictEqual(Object.hasOwn(profilePut.Item, "role"), false);
    assert.strictEqual(Object.hasOwn(profilePut.Item, "cognitoUsername"), false);
    assert.deepStrictEqual(profilePut.Item.departmentDesignations, [
      { departmentId: DEPARTMENT_ID, designationId: DESIGNATION_ID },
    ]);
  });

  await test("an ordinary employee profile save does not call Cognito", async () => {
    const fake = useFake();
    const res = parse(
      await handler(
        event(
          {
            email: ORDINARY,
            name: "Ordinary Employee",
            empId: "DGV100",
            phone: "222",
          },
          { email: ORDINARY, role: "EMPLOYEE" }
        )
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fake.cognitoCalls, []);
    assert.deepStrictEqual(accessWrites(fake), []);
    assert.deepStrictEqual(
      fake.commands.filter((command) => command.table === "UserAccess"),
      []
    );
    const profilePut = fake.puts.find((input) => input.TableName === "UserProfile");
    assert.strictEqual(profilePut.Item.PK, `USER#${ORDINARY}`);
    assert.strictEqual(profilePut.Item.email, ORDINARY);
    assert.strictEqual(profilePut.Item.empId, "DGV100");
    assert.strictEqual(profilePut.Item.phone, "222");
    assert.strictEqual(profilePut.Item.name, "Ordinary Employee");
  });

  await test("an ordinary designation update does not look up Cognito", async () => {
    const fake = useFake();
    const res = parse(
      await handler(
        event(
          {
            email: ORDINARY,
            departmentIds: [DEPARTMENT_ID],
            primaryDepartmentId: DEPARTMENT_ID,
            departmentDesignations: [
              { departmentId: DEPARTMENT_ID, designationId: DESIGNATION_ID },
            ],
          },
          { email: ORDINARY, role: "EMPLOYEE" }
        )
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fake.cognitoCalls, []);
    assert.deepStrictEqual(accessWrites(fake), []);
    assertActorOnlyAccessRead(fake);
    const profilePut = fake.puts.find((input) => input.TableName === "UserProfile");
    assert.strictEqual(profilePut.Item.PK, `USER#${ORDINARY}`);
    assert.deepStrictEqual(profilePut.Item.departmentDesignations, [
      { departmentId: DEPARTMENT_ID, designationId: DESIGNATION_ID },
    ]);
    assert.strictEqual(
      fake.store.get(keyOf("UserAccess", ORDINARY, ORDINARY)).role,
      "EMPLOYEE"
    );
  });

  await test("a different submitted role does not change DGV001 access or Cognito", async () => {
    const fake = useFake({
      accessKey: LOGIN,
      accessRole: "SUPER_ADMIN",
      profileLoginEmail: null,
      empId: "DGV001",
    });
    const accessKey = keyOf("UserAccess", LOGIN, LOGIN);
    const beforeAccess = structuredClone(fake.store.get(accessKey));
    const res = parse(
      await handler(
        event(
          { email: EMPLOYEE, name: "DGV Admin", empId: "DGV001", phone: "000" },
          { role: "EMPLOYEE" }
        )
      )
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fake.cognitoCalls, []);
    assert.deepStrictEqual(accessWrites(fake), []);
    assert.deepStrictEqual(fake.store.get(accessKey), beforeAccess);
    assert.strictEqual(beforeAccess.role, "SUPER_ADMIN");
    assert.strictEqual(beforeAccess.email, EMPLOYEE);
  });

  console.log("UserProfileFunction designation save tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

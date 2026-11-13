process.env.USER_ACCESS_TABLE = "UserAccess";
process.env.USER_PROFILE_TABLE = "UserProfile";
process.env.WORK_TABLE = "WorkTasks";
process.env.USER_POOL_ID = "test-pool";
process.env.AWS_REGION = "ap-south-1";

const assert = require("assert");
const { handler, setClientsForTests } = require("./app");

const ACTOR = "admin@mydgv.com";
const EMPLOYEE = "notify@mydgv.com";
const DEPARTMENT_ID = "leadership";
const DESIGNATION_ID = "office-lead";

function parse(res) {
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

function event(profile) {
  return {
    httpMethod: "POST",
    body: JSON.stringify({
      mode: "EDIT",
      email: EMPLOYEE,
      role: "EMPLOYEE",
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

function createFake({ designationDepartmentId = DEPARTMENT_ID } = {}) {
  const store = new Map();
  store.set(keyOf("UserAccess", ACTOR, ACTOR), {
    PK: ACTOR,
    SK: ACTOR,
    email: ACTOR,
    role: "ADMIN",
    status: "ACTIVE",
  });
  store.set(keyOf("UserAccess", EMPLOYEE, EMPLOYEE), {
    PK: EMPLOYEE,
    SK: EMPLOYEE,
    email: EMPLOYEE,
    role: "EMPLOYEE",
    status: "ACTIVE",
  });
  store.set(keyOf("UserProfile", `USER#${EMPLOYEE}`, "PROFILE"), {
    PK: `USER#${EMPLOYEE}`,
    SK: "PROFILE",
    email: EMPLOYEE,
    departmentIds: [DEPARTMENT_ID],
    primaryDepartmentId: DEPARTMENT_ID,
    department: "Leadership & Management",
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
  return {
    puts,
    cognitoCalls,
    ddb: {
      send: async (cmd) => {
        const input = cmd.input || {};
        const name = cmd.constructor?.name;
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
      send: async () => {
        cognitoCalls.push("AdminAddUserToGroup");
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
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fake.cognitoCalls.length, 0);
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
    assert.strictEqual(fake.cognitoCalls.length, 0);
  });

  console.log("UserProfileFunction designation save tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

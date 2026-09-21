process.env.USER_ACCESS_TABLE = "UserAccess";
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
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

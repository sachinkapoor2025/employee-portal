/**
 * Shared ACTIVE UserAccess ADMIN/SUPER_ADMIN gate for project lifecycle,
 * OPEN administrative task/import access, and admin time-entry lookup.
 * Cognito isAdmin is not sufficient.
 */
const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { isEligibleProjectAdmin, normalizeEmail } = require("./projectAccess");

async function loadUserAccessRow(ddb, accessTable, email) {
  const e = normalizeEmail(email);
  if (!e) return { ok: true, item: null };
  if (!accessTable || !ddb || typeof ddb.send !== "function") {
    return { ok: true, item: null, missingConfig: true };
  }
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: accessTable,
        Key: { PK: e, SK: e },
      })
    );
    return { ok: true, item: res.Item || null };
  } catch (err) {
    return { ok: false };
  }
}

async function requireEligiblePortalAdmin({ user, ddb, accessTable } = {}) {
  const email = normalizeEmail(user?.email);
  if (!email) {
    return { statusCode: 401, body: { error: "Unauthorized" } };
  }
  if (!ddb || typeof ddb.send !== "function" || !accessTable) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  const loaded = await loadUserAccessRow(ddb, accessTable, email);
  if (!loaded.ok) {
    return { statusCode: 500, body: { error: "Internal server error" } };
  }
  if (!isEligibleProjectAdmin(loaded.item)) {
    return { statusCode: 403, body: { error: "Admin required" } };
  }
  return { ok: true, email, accessRow: loaded.item };
}

module.exports = {
  loadUserAccessRow,
  requireEligiblePortalAdmin,
};

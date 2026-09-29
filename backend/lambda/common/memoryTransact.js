function conditionPasses(existing, expr) {
  const text = String(expr || "");
  if (!text) return true;
  if (text.includes("attribute_not_exists(PK)")) return !existing;
  if (text.includes("attribute_not_exists(submittedAt)")) return !existing?.submittedAt;
  return true;
}

function applyTransactWrite(input, tableStores) {
  const items = Array.isArray(input?.TransactItems) ? input.TransactItems : [];
  const reasons = [];
  let failed = false;
  for (const op of items) {
    if (op.Put) {
      const store = tableStores[op.Put.TableName] || {};
      const key = `${op.Put.Item.PK}|${op.Put.Item.SK}`;
      const existing = store[key];
      if (!conditionPasses(existing, op.Put.ConditionExpression)) {
        reasons.push({ Code: "ConditionalCheckFailed" });
        failed = true;
      } else {
        reasons.push({ Code: "None" });
      }
    } else {
      reasons.push({ Code: "None" });
    }
  }
  if (failed) {
    const err = new Error("Transaction cancelled");
    err.name = "TransactionCanceledException";
    err.CancellationReasons = reasons;
    throw err;
  }
  const puts = [];
  for (const op of items) {
    if (op.Put) {
      const store = tableStores[op.Put.TableName];
      if (!store) continue;
      const item = { ...op.Put.Item };
      store[`${item.PK}|${item.SK}`] = item;
      puts.push({ table: op.Put.TableName, item });
    }
    if (op.Delete?.Key) {
      const store = tableStores[op.Delete.TableName];
      if (!store) continue;
      delete store[`${op.Delete.Key.PK}|${op.Delete.Key.SK}`];
    }
  }
  return puts;
}

function queryStore(store, input) {
  const values = input?.ExpressionAttributeValues || {};
  const pk = values[":pk"];
  const start = values[":start"];
  const end = values[":end"];
  const skPrefix = values[":sk"];
  return Object.values(store || {}).filter((row) => {
    if (!row || row.PK !== pk) return false;
    if (skPrefix) return String(row.SK || "").startsWith(String(skPrefix));
    if (start != null && end != null) {
      const sk = String(row.SK || "");
      return sk >= String(start) && sk <= String(end);
    }
    return true;
  });
}

function isTransactWrite(cmd, input) {
  const name = cmd?.constructor?.name || "";
  return name === "TransactWriteCommand" || Array.isArray(input?.TransactItems);
}

module.exports = {
  conditionPasses,
  applyTransactWrite,
  queryStore,
  isTransactWrite,
};

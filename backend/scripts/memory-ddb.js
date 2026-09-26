"use strict";

function fromAv(av) {
  if (av == null) return undefined;
  if (av.S !== undefined) return av.S;
  if (av.N !== undefined) return Number(av.N);
  if (av.BOOL !== undefined) return av.BOOL;
  if (av.NULL) return null;
  if (av.L) return av.L.map(fromAv);
  if (av.M) {
    return Object.fromEntries(
      Object.entries(av.M).map(([key, value]) => [key, fromAv(value)])
    );
  }
  if (av.SS) return av.SS;
  if (av.NS) return av.NS.map(Number);
  return av;
}

function toAv(value) {
  if (value === undefined) return undefined;
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toAv) };
  if (typeof value === "object") {
    const mapped = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) continue;
      mapped[key] = toAv(nested);
    }
    return { M: mapped };
  }
  return { S: String(value) };
}

function unmarshall(item) {
  if (!item) return null;
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    out[key] = fromAv(value);
  }
  return out;
}

function nativeItem(item) {
  if (!item) return null;
  if (item.PK && typeof item.PK === "object" && item.PK.S !== undefined) {
    return unmarshall(item);
  }
  return item;
}

function nativeKey(key) {
  if (!key) return null;
  if (key.PK && typeof key.PK === "object" && key.PK.S !== undefined) {
    return unmarshall(key);
  }
  return key;
}

function nativeValues(values = {}) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = value && typeof value === "object" && ("S" in value || "N" in value || "BOOL" in value || "L" in value || "M" in value || "NULL" in value)
      ? fromAv(value)
      : value;
  }
  return out;
}

function marshall(item) {
  if (!item) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined) continue;
    out[key] = toAv(value);
  }
  return out;
}

function keyId(key) {
  const native = nativeKey(key) || {};
  return `${native.PK}\0${native.SK}`;
}

function substitute(expr, names = {}) {
  let next = String(expr || "");
  for (const [token, name] of Object.entries(names)) {
    next = next.split(token).join(name);
  }
  return next;
}

function valuesNative(values = {}) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = fromAv(value);
  }
  return out;
}

function conditionOk(item, expression, values, names) {
  if (!expression) return true;
  const expr = substitute(expression, names).replace(/\s+/g, " ").trim();
  const vals = valuesNative(values);
  if (expr === "attribute_not_exists(PK)") return !item;
  if (expr.includes("attribute_not_exists(PK)") && expr.includes("AND")) {
    if (!item && expr.startsWith("attribute_not_exists(PK)")) return true;
  }
  if (!item) return false;
  const eq = expr.match(/^([A-Za-z0-9_]+) = (:[A-Za-z0-9_]+)$/);
  if (eq) return item[eq[1]] === vals[eq[2]];
  if (expr.includes("#status = :active") || expr.includes("status = :active")) {
    return item.status === vals[":active"];
  }
  if (expr.includes("status = :revoked")) {
    return item.status === vals[":revoked"];
  }
  return true;
}

function applySet(item, expression, values, names) {
  const expr = substitute(expression, names);
  const vals = valuesNative(values);
  const next = { ...item };
  const setPart = expr.replace(/^SET\s+/i, "");
  for (const assignment of setPart.split(",")) {
    const [left, right] = assignment.split("=").map((part) => part.trim());
    if (!left || !right) continue;
    next[left] = right.startsWith(":") ? vals[right] : right;
  }
  return next;
}

class ConditionalFailed extends Error {
  constructor() {
    super("The conditional request failed");
    this.name = "ConditionalCheckFailedException";
  }
}

class TransactionCanceled extends Error {
  constructor(reasons) {
    super("Transaction cancelled");
    this.name = "TransactionCanceledException";
    this.CancellationReasons = reasons;
  }
}

class MemoryDynamoDB {
  constructor() {
    this.tables = new Map();
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input || {};
    const doc = isDocumentCommand(command);
    const wrap = (item) => (item ? (doc ? item : marshall(item)) : undefined);
    if (name === "ListTablesCommand") {
      return { TableNames: [...this.tables.keys()] };
    }
    if (name === "CreateTableCommand") {
      this.table(input.TableName);
      return { TableDescription: { TableName: input.TableName } };
    }
    if (name === "DescribeTableCommand") {
      if (!this.tables.has(input.TableName)) {
        const err = new Error("Cannot do operations on a non-existent table");
        err.name = "ResourceNotFoundException";
        throw err;
      }
      return { Table: { TableName: input.TableName } };
    }
    if (name === "GetItemCommand" || name === "GetCommand") {
      const item = this.table(input.TableName).get(keyId(input.Key));
      return { Item: wrap(item) };
    }
    if (name === "PutItemCommand" || name === "PutCommand") {
      this.put(input);
      return {};
    }
    if (name === "DeleteItemCommand" || name === "DeleteCommand") {
      this.table(input.TableName).delete(keyId(input.Key));
      return {};
    }
    if (name === "UpdateItemCommand" || name === "UpdateCommand") {
      this.update(input);
      return {};
    }
    if (name === "QueryCommand") {
      return this.query(input, doc);
    }
    if (name === "ScanCommand") {
      const items = [...this.table(input.TableName).values()].map((item) =>
        doc ? item : marshall(item)
      );
      return { Items: items };
    }
    if (name === "TransactWriteItemsCommand" || name === "TransactWriteCommand") {
      this.transact(input.TransactItems || []);
      return {};
    }
    if (name === "BatchWriteItemCommand" || name === "BatchWriteCommand") {
      for (const [tableName, requests] of Object.entries(input.RequestItems || {})) {
        for (const request of requests) {
          if (request.PutRequest) {
            this.put({ TableName: tableName, Item: request.PutRequest.Item });
          }
          if (request.DeleteRequest) {
            this.table(tableName).delete(keyId(request.DeleteRequest.Key));
          }
        }
      }
      return { UnprocessedItems: {} };
    }
    throw new Error(`Unsupported local DynamoDB command ${name}`);
  }

  put(input) {
    const table = this.table(input.TableName);
    const item = nativeItem(input.Item);
    const id = `${item.PK}\0${item.SK}`;
    const existing = table.get(id);
    if (!conditionOk(existing, input.ConditionExpression, input.ExpressionAttributeValues, input.ExpressionAttributeNames)) {
      throw new ConditionalFailed();
    }
    table.set(id, item);
  }

  update(input) {
    const table = this.table(input.TableName);
    const id = keyId(input.Key);
    const existing = table.get(id);
    if (!conditionOk(existing, input.ConditionExpression, input.ExpressionAttributeValues, input.ExpressionAttributeNames)) {
      throw new ConditionalFailed();
    }
    if (!existing) throw new ConditionalFailed();
    table.set(
      id,
      applySet(
        existing,
        input.UpdateExpression,
        input.ExpressionAttributeValues,
        input.ExpressionAttributeNames
      )
    );
  }

  query(input, doc) {
    const values = nativeValues(input.ExpressionAttributeValues);
    const pk = values[":pk"];
    const sk = values[":sk"];
    const items = [];
    for (const item of this.table(input.TableName).values()) {
      if (item.PK !== pk) continue;
      if (sk && !String(item.SK || "").startsWith(sk)) continue;
      items.push(doc ? item : marshall(item));
    }
    return { Items: items };
  }

  transact(entries) {
    const snapshot = new Map(
      [...this.tables.entries()].map(([name, table]) => [name, new Map(table)])
    );
    try {
      for (const entry of entries) {
        if (entry.Put) this.put(entry.Put);
        else if (entry.Update) this.update(entry.Update);
        else if (entry.Delete) {
          this.table(entry.Delete.TableName).delete(keyId(entry.Delete.Key));
        } else if (entry.ConditionCheck) {
          const existing = this.table(entry.ConditionCheck.TableName).get(
            keyId(entry.ConditionCheck.Key)
          );
          if (
            !conditionOk(
              existing,
              entry.ConditionCheck.ConditionExpression,
              entry.ConditionCheck.ExpressionAttributeValues,
              entry.ConditionCheck.ExpressionAttributeNames
            )
          ) {
            throw new ConditionalFailed();
          }
        }
      }
    } catch (err) {
      this.tables = snapshot;
      if (err instanceof ConditionalFailed) {
        throw new TransactionCanceled(
          entries.map(() => ({ Code: "ConditionalCheckFailed" }))
        );
      }
      throw err;
    }
  }
}

function isDocumentCommand(command) {
  const lib = require("@aws-sdk/lib-dynamodb");
  return (
    command instanceof lib.GetCommand ||
    command instanceof lib.PutCommand ||
    command instanceof lib.QueryCommand ||
    command instanceof lib.ScanCommand ||
    command instanceof lib.UpdateCommand ||
    command instanceof lib.DeleteCommand ||
    command instanceof lib.TransactWriteCommand ||
    command instanceof lib.BatchWriteCommand
  );
}

function installMemoryDynamoDB() {
  const dynamodb = require("@aws-sdk/client-dynamodb");
  const lib = require("@aws-sdk/lib-dynamodb");
  const memory = new MemoryDynamoDB();
  const send = (command) => memory.send(command);
  const Original = dynamodb.DynamoDBClient;
  function WrappedDynamoDBClient(config = {}) {
    const client = new Original({
      ...config,
      region: config.region || process.env.AWS_REGION || "ap-south-1",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    });
    client.send = send;
    return client;
  }
  WrappedDynamoDBClient.prototype = Original.prototype;
  dynamodb.DynamoDBClient = WrappedDynamoDBClient;
  lib.DynamoDBDocumentClient.from = function fromMemory() {
    return { send };
  };
  lib.DynamoDBDocumentClient.prototype.send = send;
  return memory;
}

module.exports = { MemoryDynamoDB, installMemoryDynamoDB, marshall, unmarshall };

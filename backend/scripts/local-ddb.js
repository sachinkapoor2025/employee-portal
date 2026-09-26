"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { applyLocalAwsEnv } = require("./local-env");

applyLocalAwsEnv();

const ROOT = path.join(__dirname, "..", ".local", "dynamodb");
const ZIP = path.join(ROOT, "dynamodb_local.zip");
const JAR = path.join(ROOT, "DynamoDBLocal.jar");
const PORT = Number(new URL(process.env.AWS_ENDPOINT_URL).port || 8000);
const DOWNLOAD =
  "https://s3.us-west-2.amazonaws.com/dynamodb-local/dynamodb_local_latest.zip";

function waitForPort(port, timeoutMs = 40000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.end();
        resolve();
      });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`DynamoDB Local did not start on port ${port}`));
          return;
        }
        setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

async function ensureJar() {
  fs.mkdirSync(ROOT, { recursive: true });
  if (fs.existsSync(JAR)) return;
  console.log("Downloading DynamoDB Local (not AWS production)...");
  const res = await fetch(DOWNLOAD);
  if (!res.ok) {
    throw new Error(`Failed to download DynamoDB Local: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(ZIP, buf);
  const { execFileSync } = require("child_process");
  execFileSync("tar", ["-xf", ZIP, "-C", ROOT], { stdio: "inherit" });
}

async function main() {
  await ensureJar();
  const child = spawn(
    "java",
    [
      `-Djava.library.path=${path.join(ROOT, "DynamoDBLocal_lib")}`,
      "-jar",
      JAR,
      "-inMemory",
      "-sharedDb",
      "-port",
      String(PORT),
    ],
    {
      cwd: ROOT,
      stdio: "inherit",
      windowsHide: true,
    }
  );
  child.on("exit", (code) => {
    process.exit(code || 0);
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  await waitForPort(PORT);
  console.log(`DynamoDB Local listening on http://127.0.0.1:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

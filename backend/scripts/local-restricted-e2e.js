"use strict";

const { mintLocalJwt } = require("./local-env");

const API = process.env.LOCAL_API_URL || "http://127.0.0.1:3001";
const token = mintLocalJwt({
  email: "admin@mydgv.com",
  "cognito:groups": ["Admin"],
});

async function api(path, method, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, url: `${API}${path}`, method, data };
}

async function run() {
  const access = await api("/access", "GET");
  if (access.status !== 200 || access.data.access !== "ADMIN") {
    throw new Error(`GET /access failed: ${JSON.stringify(access)}`);
  }

  const users = await api("/admin/users", "GET");
  if (users.status !== 200 || !Array.isArray(users.data)) {
    throw new Error(`GET /admin/users failed: ${JSON.stringify(users)}`);
  }
  if (!users.data.some((u) => u.email === "rahul@mydgv.com" && u.status === "ACTIVE")) {
    throw new Error("Seeded employee rahul@mydgv.com missing");
  }

  const openPayload = { name: `Local Open ${Date.now()}`, client: "DGV", description: "local" };
  const open = await api("/projects", "POST", openPayload);
  if (open.status !== 201 || open.data.accessMode !== "OPEN") {
    throw new Error(`Open create failed: ${JSON.stringify(open)}`);
  }
  if (Object.prototype.hasOwnProperty.call(openPayload, "accessMode")) {
    throw new Error("open payload unexpectedly includes accessMode");
  }

  const restrictedPayload = {
    name: `Local Restricted ${Date.now()}`,
    client: "DGV",
    description: "restricted local",
    accessMode: "RESTRICTED",
    members: [
      { email: "  Rahul@MyDGV.com " },
      { email: "rahul@mydgv.com" },
      { email: "" },
    ],
  };
  const restricted = await api("/projects", "POST", restrictedPayload);
  if (restricted.status !== 201 || restricted.data.accessMode !== "RESTRICTED") {
    throw new Error(`Restricted create failed: ${JSON.stringify(restricted)}`);
  }
  if (!restricted.data.members.includes("rahul@mydgv.com")) {
    throw new Error(`Members not persisted: ${JSON.stringify(restricted.data)}`);
  }

  const listed = await api("/projects?status=ALL", "GET");
  if (listed.status !== 200 || !Array.isArray(listed.data)) {
    throw new Error(`List failed: ${JSON.stringify(listed)}`);
  }
  const found = listed.data.find((p) => p.projectId === restricted.data.projectId);
  if (!found || found.accessMode !== "RESTRICTED") {
    throw new Error("Restricted project missing from GET /projects");
  }

  const accessList = await api(`/projects/${restricted.data.projectId}`, "PATCH", {
    access: { action: "list", includeRevoked: true },
  });
  if (accessList.status !== 200) {
    throw new Error(`Manage Access list failed: ${JSON.stringify(accessList)}`);
  }
  const memberEmails = (accessList.data.members || []).map((m) => m.email);
  const adminEmails = (accessList.data.projectAdmins || []).map((a) => a.email);
  if (!memberEmails.includes("rahul@mydgv.com")) {
    throw new Error(`ACL members missing: ${JSON.stringify(accessList.data)}`);
  }
  if (!adminEmails.includes("admin@mydgv.com")) {
    throw new Error(`Project Admin missing: ${JSON.stringify(accessList.data)}`);
  }

  const missingMembers = await api("/projects", "POST", {
    name: `Local Restricted Empty ${Date.now()}`,
    accessMode: "RESTRICTED",
  });
  if (missingMembers.status !== 400) {
    throw new Error(`Empty members should 400: ${JSON.stringify(missingMembers)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        api: API,
        open: { status: open.status, accessMode: open.data.accessMode, projectId: open.data.projectId },
        restricted: {
          status: restricted.status,
          accessMode: restricted.data.accessMode,
          members: restricted.data.members,
          projectId: restricted.data.projectId,
        },
        accessList: {
          status: accessList.status,
          members: memberEmails,
          projectAdmins: adminEmails,
        },
      },
      null,
      2
    )
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

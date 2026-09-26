import { api, fetchTaskById, getApiBaseUrl, isTokenExpired } from "./api";

function tokenWithExp(expSecondsFromNow) {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
    email: "rahul@mydgv.com",
  };
  const b64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${b64}.sig`;
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe("api auth error handling", () => {
  let replace;

  beforeEach(() => {
    replace = jest.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { pathname: "/work/task-1", replace },
    });
    localStorage.clear();
    localStorage.setItem("token", tokenWithExp(3600));
    localStorage.setItem("role", "USER");
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
  });

  test("403 from /admin/users does not clear the session or redirect", async () => {
    fetch.mockResolvedValue(
      jsonResponse(403, { error: "Admin access required" })
    );

    await expect(api("/admin/users", "GET")).rejects.toMatchObject({
      status: 403,
      message: "Admin access required",
    });

    expect(localStorage.getItem("token")).toBeTruthy();
    expect(localStorage.getItem("role")).toBe("USER");
    expect(replace).not.toHaveBeenCalled();
  });

  test("401 clears the session and redirects to login", async () => {
    fetch.mockResolvedValue(jsonResponse(401, { error: "Unauthorized" }));

    await expect(api("/tasks/task-1", "GET")).rejects.toThrow(
      "Session expired. Please sign in again."
    );

    expect(localStorage.getItem("token")).toBeNull();
    expect(replace).toHaveBeenCalledWith("/login");
  });

  test("expired token is treated as unauthenticated before fetch", async () => {
    localStorage.setItem("token", tokenWithExp(-120));
    expect(isTokenExpired()).toBe(true);

    await expect(api("/tasks?mine=true", "GET")).rejects.toThrow(
      "Session expired. Please sign in again."
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith("/login");
  });

  test("does not present a 404 as a local API error", async () => {
    fetch.mockResolvedValue(
      jsonResponse(404, { error: "Not found on local API" })
    );

    await expect(api("/employees/priya@mydgv.com/shift", "GET")).rejects.toMatchObject({
      status: 404,
      message: "This API endpoint is not available on the deployed backend.",
    });
  });
});

describe("getApiBaseUrl", () => {
  const deployed = "https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod";

  test("uses the deployed AWS API instead of localhost", () => {
    expect(getApiBaseUrl("http://localhost:3001")).toBe(deployed);
    expect(getApiBaseUrl("http://127.0.0.1:3001")).toBe(deployed);
  });

  test("keeps a non-local API URL", () => {
    expect(getApiBaseUrl(deployed)).toBe(deployed);
  });
});

describe("fetchTaskById", () => {
  beforeEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { pathname: "/work/task-1", replace: jest.fn() },
    });
    localStorage.clear();
    localStorage.setItem("token", tokenWithExp(3600));
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
  });

  test("does not fall back to the unscoped task list after a 403", async () => {
    fetch.mockResolvedValue(jsonResponse(403, { error: "Forbidden" }));

    await expect(fetchTaskById("secret-task")).rejects.toMatchObject({
      status: 403,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(/\/tasks\/secret-task$/);
  });
});

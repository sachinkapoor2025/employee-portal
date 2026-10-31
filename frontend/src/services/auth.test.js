import { getApiBaseUrl, LOCAL_API_REQUIRED_MESSAGE } from "./api";
import { checkAccess } from "./auth";

jest.mock("./api", () => ({
  getApiBaseUrl: jest.fn(() => ""),
  LOCAL_API_REQUIRED_MESSAGE:
    "API base URL is not configured. Local development uses the deployed AWS API unless REACT_APP_USE_LOCAL_API=true and REACT_APP_API_URL is a loopback address such as http://127.0.0.1:3001.",
}));

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

beforeEach(() => {
  localStorage.clear();
  getApiBaseUrl.mockReset();
  getApiBaseUrl.mockReturnValue("");
  global.fetch = jest.fn();
});

test("does not call the frontend /access route when the API base is unset", async () => {
  localStorage.setItem("token", "signed-in");

  await expect(checkAccess()).rejects.toThrow(LOCAL_API_REQUIRED_MESSAGE);

  expect(fetch).not.toHaveBeenCalled();
});

test("checks access once against the configured API", async () => {
  getApiBaseUrl.mockReturnValue(
    "https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod"
  );
  localStorage.setItem("token", "signed-in");
  fetch.mockResolvedValue(jsonResponse({ access: "USER", role: "EMPLOYEE" }));

  await expect(checkAccess()).resolves.toEqual({
    access: "USER",
    role: "EMPLOYEE",
  });

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(
    "https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod/access"
  );
  expect(fetch.mock.calls[0][1].cache).toBe("no-store");
});

test("rejects the portal HTML document instead of treating it as access", async () => {
  getApiBaseUrl.mockReturnValue("https://api.example.com");
  localStorage.setItem("token", "signed-in");
  fetch.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => "text/html" },
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
  });

  await expect(checkAccess()).rejects.toThrow(/did not reach the API/i);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("401 clears the saved session", async () => {
  getApiBaseUrl.mockReturnValue("https://api.example.com");
  localStorage.setItem("token", "signed-in");
  localStorage.setItem("role", "USER");
  fetch.mockResolvedValue({
    ok: false,
    status: 401,
    headers: { get: () => "application/json" },
  });

  await expect(checkAccess()).rejects.toThrow(/sign in again/i);
  expect(localStorage.getItem("token")).toBeNull();
  expect(localStorage.getItem("role")).toBeNull();
});

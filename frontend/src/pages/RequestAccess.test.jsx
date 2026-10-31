import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "../theme/ThemeProvider";
import Login from "./Login";
import RequestAccess from "./RequestAccess";
import { checkAccess } from "../services/auth";
import router from "react-router-dom";

jest.mock(
  "react-router-dom",
  () => {
    const state = { search: "", navigate: jest.fn() };
    return {
      useNavigate: () => state.navigate,
      useSearchParams: () => [new URLSearchParams(state.search)],
      __state: state,
    };
  },
  { virtual: true }
);

jest.mock("../services/auth", () => ({
  login: jest.fn(),
  checkAccess: jest.fn(),
  requestAccess: jest.fn(),
  applyAccessRedirect: jest.fn(),
  getLoggedInEmail: () => "priya@mydgv.com",
}));

beforeEach(() => {
  localStorage.clear();
  router.__state.search = "";
  router.__state.navigate.mockClear();
  checkAccess.mockReset();
});

test("a failed access check does not send a signed-in user back to login", async () => {
  localStorage.setItem("token", "signed-in");
  checkAccess.mockRejectedValue(
    new Error("Access check did not reach the API.")
  );

  render(
    <ThemeProvider>
      <RequestAccess />
    </ThemeProvider>
  );

  expect(await screen.findByText(/did not reach the API/i)).toBeInTheDocument();
  expect(router.__state.navigate).not.toHaveBeenCalled();
  expect(checkAccess).toHaveBeenCalledTimes(1);
});

test("login sends a signed-in user without a role to request access once", () => {
  localStorage.setItem("token", "signed-in");

  render(
    <ThemeProvider>
      <Login />
    </ThemeProvider>
  );

  expect(router.__state.navigate).toHaveBeenCalledTimes(1);
  expect(router.__state.navigate).toHaveBeenCalledWith("/request-access", {
    replace: true,
  });
});

test("pending access is checked once and is not requested again", async () => {
  localStorage.setItem("token", "signed-in");
  router.__state.search = "status=pending";
  checkAccess.mockResolvedValue({ access: "PENDING" });

  const view = render(<RequestAccess />);
  expect(await screen.findByText(/under review/i)).toBeInTheDocument();
  view.rerender(<RequestAccess />);

  expect(checkAccess).toHaveBeenCalledTimes(1);
  expect(router.__state.navigate).not.toHaveBeenCalled();
});

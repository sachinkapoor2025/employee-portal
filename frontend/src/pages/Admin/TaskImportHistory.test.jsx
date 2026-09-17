import fs from "fs";
import path from "path";

jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

const mockNavigate = jest.fn();
jest.mock(
  "react-router-dom",
  () => ({
    useNavigate: () => mockNavigate,
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchTaskImports: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskImportHistory from "./TaskImportHistory";
import { fetchTaskImports } from "../../services/api";

const ITEM = {
  batchId: "batch-abc",
  fileName: "tasks.xlsx",
  uploadedBy: "ada@mydgv.com",
  uploadedByName: "Ada Admin",
  uploadedAt: "2026-09-15T10:00:00.000Z",
  status: "COMPLETED",
  totalRows: 12,
  successCount: 10,
  failureCount: 2,
};

beforeEach(() => {
  mockNavigate.mockReset();
  fetchTaskImports.mockReset();
  fetchTaskImports.mockResolvedValue({
    items: [ITEM],
    nextToken: null,
    totalCount: 1,
  });
});

test("history list renders total imports and rows", async () => {
  render(<TaskImportHistory />);
  expect(screen.getByText("Loading import history...")).toBeInTheDocument();
  expect(
    await screen.findByText("Total Imports: 1")
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Excel Import History" })
  ).toBeInTheDocument();
  expect(
    screen.getByText("Review previous Excel task imports and their results.")
  ).toBeInTheDocument();
  expect(screen.getByText("batch-abc")).toBeInTheDocument();
  expect(screen.getByText("tasks.xlsx")).toBeInTheDocument();
  expect(screen.getByText("Ada Admin")).toBeInTheDocument();
  expect(screen.getByText("12")).toBeInTheDocument();
  expect(screen.getByText("10")).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument();
  expect(screen.getByText("Completed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Download/i })
  ).not.toBeInTheDocument();
  expect(fetchTaskImports).toHaveBeenCalledWith({
    limit: 20,
    nextToken: undefined,
  });
});

test("history list displays only completed imports", async () => {
  fetchTaskImports.mockResolvedValue({
    items: [
      ITEM,
      {
        ...ITEM,
        batchId: "batch-fix",
        fileName: "needs-fix.xlsx",
        status: "NEEDS_FIX",
      },
      {
        ...ITEM,
        batchId: "batch-ready",
        fileName: "ready.xlsx",
        status: "READY",
      },
      {
        ...ITEM,
        batchId: "batch-uploaded",
        fileName: "uploaded.xlsx",
        status: "UPLOADED",
      },
      {
        ...ITEM,
        batchId: "batch-failed",
        fileName: "failed.xlsx",
        status: "FAILED",
      },
      {
        ...ITEM,
        batchId: "batch-partial",
        fileName: "partial.xlsx",
        status: "PARTIAL",
      },
    ],
    nextToken: null,
    totalCount: 1,
  });
  render(<TaskImportHistory />);
  expect(await screen.findByText("tasks.xlsx")).toBeInTheDocument();
  expect(screen.getByText("batch-abc")).toBeInTheDocument();
  expect(screen.queryByText("needs-fix.xlsx")).not.toBeInTheDocument();
  expect(screen.queryByText("ready.xlsx")).not.toBeInTheDocument();
  expect(screen.queryByText("uploaded.xlsx")).not.toBeInTheDocument();
  expect(screen.queryByText("failed.xlsx")).not.toBeInTheDocument();
  expect(screen.queryByText("partial.xlsx")).not.toBeInTheDocument();
  expect(screen.queryByText("batch-fix")).not.toBeInTheDocument();
  expect(screen.queryByText("batch-ready")).not.toBeInTheDocument();
  expect(screen.queryByText("batch-uploaded")).not.toBeInTheDocument();
  expect(screen.queryByText("batch-failed")).not.toBeInTheDocument();
  expect(screen.queryByText("batch-partial")).not.toBeInTheDocument();
});

test("View opens batch detail", async () => {
  render(<TaskImportHistory />);
  userEvent.click(await screen.findByRole("button", { name: "View" }));
  expect(mockNavigate).toHaveBeenCalledWith("/admin/task-imports/batch-abc");
});

test("pagination shows Next and Previous only when available", async () => {
  fetchTaskImports
    .mockResolvedValueOnce({
      items: [ITEM],
      nextToken: "page-2",
      totalCount: 21,
    })
    .mockResolvedValueOnce({
      items: [{ ...ITEM, batchId: "batch-def", fileName: "later.xlsx" }],
      nextToken: null,
      totalCount: 21,
    })
    .mockResolvedValueOnce({
      items: [ITEM],
      nextToken: "page-2",
      totalCount: 21,
    });

  render(<TaskImportHistory />);
  expect(await screen.findByText("Total Imports: 21")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();
  userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("later.xlsx")).toBeInTheDocument();
  expect(fetchTaskImports).toHaveBeenLastCalledWith({
    limit: 20,
    nextToken: "page-2",
  });
  expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  userEvent.click(screen.getByRole("button", { name: "Previous" }));
  await waitFor(() => {
    expect(fetchTaskImports).toHaveBeenLastCalledWith({
      limit: 20,
      nextToken: undefined,
    });
  });
  expect(await screen.findByText("tasks.xlsx")).toBeInTheDocument();
});

test("shows an error state", async () => {
  fetchTaskImports.mockRejectedValue(new Error("Unable to load import history."));
  render(<TaskImportHistory />);
  expect(
    await screen.findByText("Unable to load import history.")
  ).toBeInTheDocument();
});

test("employees cannot access the protected import history routes", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
  expect(src).toMatch(
    /path="\/admin\/task-imports"[\s\S]*?<RequireAuth adminOnly>[\s\S]*?<TaskImportHistory/
  );
  expect(src).toMatch(
    /path="\/admin\/task-imports\/:batchId"[\s\S]*?<RequireAuth adminOnly>[\s\S]*?<TaskImportBatch/
  );
});

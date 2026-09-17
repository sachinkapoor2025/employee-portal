jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock("../../components/TaskImportModal", () => {
  return function TaskImportModal({ open }) {
    if (!open) return null;
    return <div role="dialog" aria-label="Import Tasks">Import Tasks modal</div>;
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
  fetchProjects: jest.fn(),
  fetchTaskList: jest.fn(),
  createProject: jest.fn(),
  createTask: jest.fn(),
  fetchUsers: jest.fn(),
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManageTasks from "./ManageTasks";
import { fetchProjects, fetchTaskList, fetchUsers } from "../../services/api";

const PROJECT = { projectId: "p1", name: "Portal" };

function renderPage() {
  return render(<ManageTasks />);
}

beforeEach(() => {
  mockNavigate.mockReset();
  fetchProjects.mockResolvedValue([PROJECT]);
  fetchTaskList.mockResolvedValue({
    tasks: [],
    zoneCounts: { ALL: 0, GREEN: 0, ORANGE: 0, RED: 0, COMPLETED: 0 },
  });
  fetchUsers.mockResolvedValue([]);
});

test("Project button is displayed instead of + Project", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  expect(screen.getByRole("button", { name: "Project" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "+ Project" })
  ).not.toBeInTheDocument();
});

test("clicking Project opens the Projects modal", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "Project" }));
  expect(
    await screen.findByRole("dialog", { name: "Projects" })
  ).toBeInTheDocument();
});

test("Projects modal contains Manage Projects and Create Project", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Projects" });
  expect(
    within(dialog).getByRole("button", { name: /Manage Projects/i })
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: /Create Project/i })
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText("View and manage existing projects.")
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText("Create a new work project.")
  ).toBeInTheDocument();
});

test("X closes the Projects modal", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Projects" });
  userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Projects" })).not.toBeInTheDocument();
});

test("Manage Projects opens the project management screen", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Projects" });
  userEvent.click(within(dialog).getByRole("button", { name: /Manage Projects/i }));
  expect(mockNavigate).toHaveBeenCalledWith("/admin/projects");
});

test("Create Project opens the existing create-project flow", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "Project" }));
  const hub = await screen.findByRole("dialog", { name: "Projects" });
  userEvent.click(within(hub).getByRole("button", { name: /Create Project/i }));
  expect(screen.queryByRole("dialog", { name: "Projects" })).not.toBeInTheDocument();
  const create = await screen.findByRole("dialog", { name: "New Project" });
  expect(within(create).getByText("Name")).toBeInTheDocument();
  expect(within(create).getByText("Client")).toBeInTheDocument();
  expect(within(create).getByRole("button", { name: "Create" })).toBeInTheDocument();
});

test("selecting a project in the task filter does not show Delete Project", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  const select = screen.getAllByRole("combobox");
  userEvent.selectOptions(select[0], PROJECT.projectId);
  await waitFor(() => {
    expect(select[0].value).toBe(PROJECT.projectId);
  });
  expect(
    screen.queryByRole("button", { name: "Delete Project" })
  ).not.toBeInTheDocument();
});

test("Import History button opens the history page", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  expect(screen.getByRole("button", { name: "Import History" })).toBeInTheDocument();
  userEvent.click(screen.getByRole("button", { name: "Import History" }));
  expect(mockNavigate).toHaveBeenCalledWith("/admin/task-imports");
});

test("Import Tasks still opens the import modal", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "Import Tasks" }));
  expect(
    await screen.findByRole("dialog", { name: "Import Tasks" })
  ).toBeInTheDocument();
});

test("header keeps Project, Import Tasks, Import History, and + Task", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  expect(screen.getByRole("button", { name: "Project" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Import Tasks" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Import History" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "+ Task" })).toBeInTheDocument();
});

test("New Task Create New Project opens the shared create form", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "+ Task" }));
  const taskDialog = await screen.findByRole("dialog", { name: "New Task" });
  userEvent.selectOptions(
    within(taskDialog).getAllByRole("combobox")[0],
    "__create_project__"
  );
  expect(screen.queryByRole("dialog", { name: "New Task" })).not.toBeInTheDocument();
  expect(
    await screen.findByRole("dialog", { name: "New Project" })
  ).toBeInTheDocument();
});

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

jest.mock("../../services/auth", () => ({
  getLoggedInEmail: () => "admin@mydgv.com",
  getLoggedInDisplayName: () => "Admin User",
}));

jest.mock("../../components/TaskDatePicker", () => {
  return function TaskDatePicker({ label, value, onChange, error }) {
    return (
      <label>
        {label}
        <input
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {error ? <span>{error}</span> : null}
      </label>
    );
  };
});

jest.mock("../../components/TaskTimePicker", () => {
  function TaskTimePicker({ label, value, onChange, error }) {
    return (
      <label>
        {label}
        <input
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {error ? <span>{error}</span> : null}
      </label>
    );
  }
  return {
    __esModule: true,
    default: TaskTimePicker,
    nextQuarterHourKolkata: () => "09:30",
  };
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManageTasks from "./ManageTasks";
import { createTask, fetchProjects, fetchTaskList, fetchUsers } from "../../services/api";
import { ESTIMATED_HOURS_HELPER, ESTIMATED_HOURS_INVALID } from "../../utils/estimatedHours";

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

async function fillRequiredTaskFields(dialog) {
  userEvent.selectOptions(within(dialog).getAllByRole("combobox")[0], PROJECT.projectId);
  userEvent.type(within(dialog).getAllByRole("textbox")[0], "Banner update");
  userEvent.click(within(dialog).getByRole("button", { name: "Show all employees" }));
  userEvent.click(await within(dialog).findByLabelText(/Rahul/i));
  userEvent.type(within(dialog).getByLabelText("Start Date *"), "2026-10-01");
  userEvent.type(within(dialog).getByLabelText("Start Time *"), "09:30");
  userEvent.type(within(dialog).getByLabelText("Deadline Date *"), "2026-10-03");
  userEvent.type(within(dialog).getByLabelText("Deadline Time *"), "18:00");
}

test("New Task shows estimated hours helper text", async () => {
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "+ Task" }));
  const dialog = await screen.findByRole("dialog", { name: "New Task" });
  expect(within(dialog).getByText(ESTIMATED_HOURS_HELPER)).toBeInTheDocument();
});

test("blank estimated hours still creates a task", async () => {
  fetchUsers.mockResolvedValue([
    { email: "rahul@mydgv.com", name: "Rahul", status: "ACTIVE" },
  ]);
  createTask.mockResolvedValue({ taskId: "t1" });
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "+ Task" }));
  const dialog = await screen.findByRole("dialog", { name: "New Task" });
  await fillRequiredTaskFields(dialog);
  userEvent.click(within(dialog).getByRole("button", { name: "Create Task" }));
  await waitFor(() => {
    expect(createTask).toHaveBeenCalled();
  });
  expect(createTask.mock.calls[0][0].estimatedHours).toBe(null);
  expect(createTask.mock.calls[0][0].title).toBe("Banner update");
});

test("decimal estimated hours are submitted", async () => {
  fetchUsers.mockResolvedValue([
    { email: "rahul@mydgv.com", name: "Rahul", status: "ACTIVE" },
  ]);
  createTask.mockResolvedValue({ taskId: "t1" });
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "+ Task" }));
  const dialog = await screen.findByRole("dialog", { name: "New Task" });
  await fillRequiredTaskFields(dialog);
  userEvent.type(within(dialog).getByLabelText("Estimated Hours"), "1.5");
  userEvent.click(within(dialog).getByRole("button", { name: "Create Task" }));
  await waitFor(() => {
    expect(createTask).toHaveBeenCalled();
  });
  expect(createTask.mock.calls[0][0].estimatedHours).toBe(1.5);
});

test("integer estimated hours are submitted", async () => {
  fetchUsers.mockResolvedValue([
    { email: "rahul@mydgv.com", name: "Rahul", status: "ACTIVE" },
  ]);
  createTask.mockResolvedValue({ taskId: "t1" });
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "+ Task" }));
  const dialog = await screen.findByRole("dialog", { name: "New Task" });
  await fillRequiredTaskFields(dialog);
  userEvent.type(within(dialog).getByLabelText("Estimated Hours"), "2");
  userEvent.click(within(dialog).getByRole("button", { name: "Create Task" }));
  await waitFor(() => {
    expect(createTask).toHaveBeenCalled();
  });
  expect(createTask.mock.calls[0][0].estimatedHours).toBe(2);
});

test("zero and negative estimated hours are rejected", async () => {
  fetchUsers.mockResolvedValue([
    { email: "rahul@mydgv.com", name: "Rahul", status: "ACTIVE" },
  ]);
  renderPage();
  await screen.findByRole("option", { name: "Portal" });
  userEvent.click(screen.getByRole("button", { name: "+ Task" }));
  const dialog = await screen.findByRole("dialog", { name: "New Task" });
  userEvent.type(within(dialog).getByLabelText("Estimated Hours"), "0");
  userEvent.click(within(dialog).getByRole("button", { name: "Create Task" }));
  expect(await within(dialog).findByText(ESTIMATED_HOURS_INVALID)).toBeInTheDocument();
  expect(createTask).not.toHaveBeenCalled();

  userEvent.clear(within(dialog).getByLabelText("Estimated Hours"));
  userEvent.type(within(dialog).getByLabelText("Estimated Hours"), "-2");
  userEvent.click(within(dialog).getByRole("button", { name: "Create Task" }));
  expect(await within(dialog).findByText(ESTIMATED_HOURS_INVALID)).toBeInTheDocument();
  expect(createTask).not.toHaveBeenCalled();
});

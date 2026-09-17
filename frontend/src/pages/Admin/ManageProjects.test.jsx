jest.mock("../../components/Layout", () => {
  return function Layout({ children }) {
    return <div>{children}</div>;
  };
});

jest.mock(
  "react-router-dom",
  () => ({
    useNavigate: () => jest.fn(),
  }),
  { virtual: true }
);

jest.mock("../../services/api", () => ({
  fetchProjects: jest.fn(),
  createProject: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManageProjects from "./ManageProjects";
import {
  createProject,
  deleteProject,
  fetchProjects,
  updateProject,
} from "../../services/api";

const PROJECT = {
  projectId: "p1",
  name: "Portal",
  client: "DGV",
  createdAt: "2026-09-01T00:00:00.000Z",
  status: "ACTIVE",
};

const ARCHIVED = {
  projectId: "p2",
  name: "Legacy",
  client: "",
  createdAt: "2026-06-30T00:00:00.000Z",
  status: "ARCHIVED",
};

beforeEach(() => {
  fetchProjects.mockResolvedValue([PROJECT]);
  createProject.mockReset();
  updateProject.mockReset();
  deleteProject.mockReset();
});

test("lists projects with Take Action and no row Delete button", async () => {
  render(<ManageProjects />);
  expect(await screen.findByText("Portal")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Project Management" })).toBeInTheDocument();
  expect(
    screen.getByText("Manage your work projects, their status, and lifecycle.")
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "+ Create Project" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Take Action" })).toBeInTheDocument();
  expect(screen.getByText("Active", { selector: ".dgv-badge" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  expect(fetchProjects).toHaveBeenCalledWith({ status: "ALL" });
  const table = document.querySelector("table");
  expect(table).toHaveClass("dgv-projects-table");
  expect(table).not.toHaveClass("dgv-employees-table");
  expect(document.querySelector(".dgv-employees-table__actions")).not.toBeInTheDocument();
});

test("status filter requests ACTIVE and ARCHIVED catalogs", async () => {
  render(<ManageProjects />);
  await screen.findByText("Portal");
  userEvent.selectOptions(screen.getByLabelText("Status"), "ACTIVE");
  await waitFor(() => {
    expect(fetchProjects).toHaveBeenCalledWith({ status: "ACTIVE" });
  });
  fetchProjects.mockResolvedValueOnce([ARCHIVED]);
  userEvent.selectOptions(screen.getByLabelText("Status"), "ARCHIVED");
  await waitFor(() => {
    expect(fetchProjects).toHaveBeenCalledWith({ status: "ARCHIVED" });
  });
});

test("empty states follow the current status filter", async () => {
  fetchProjects.mockResolvedValue([]);
  render(<ManageProjects />);
  expect(await screen.findByText("No projects found.")).toBeInTheDocument();
  userEvent.selectOptions(screen.getByLabelText("Status"), "ACTIVE");
  expect(await screen.findByText("No active projects.")).toBeInTheDocument();
  userEvent.selectOptions(screen.getByLabelText("Status"), "ARCHIVED");
  expect(await screen.findByText("No archived projects.")).toBeInTheDocument();
});

test("Create Project opens the shared project form", async () => {
  render(<ManageProjects />);
  await screen.findByText("Portal");
  userEvent.click(screen.getByRole("button", { name: "+ Create Project" }));
  const dialog = await screen.findByRole("dialog", { name: "New Project" });
  expect(within(dialog).getByText("Name")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Create" })).toBeInTheDocument();
});

test("Edit Project opens the shared form and saves with PATCH", async () => {
  updateProject.mockResolvedValue({ ...PROJECT, name: "Portal Renamed" });
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Edit Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit Project" });
  const name = within(dialog).getAllByRole("textbox")[0];
  userEvent.clear(name);
  userEvent.type(name, "Portal Renamed");
  userEvent.click(within(dialog).getByRole("button", { name: "Save Changes" }));
  await waitFor(() => {
    expect(updateProject).toHaveBeenCalledWith("p1", {
      name: "Portal Renamed",
      client: "DGV",
      description: "",
    });
  });
});

test("Archive Project confirms then PATCHes ARCHIVED", async () => {
  updateProject.mockResolvedValue({ ...PROJECT, status: "ARCHIVED" });
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Archive Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Archive Project?" });
  expect(
    within(dialog).getByText("Are you sure you want to archive Portal?")
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "The project will no longer be available for new tasks, but existing tasks and history will be preserved."
    )
  ).toBeInTheDocument();
  userEvent.click(within(dialog).getByRole("button", { name: "Archive Project" }));
  await waitFor(() => {
    expect(updateProject).toHaveBeenCalledWith("p1", { status: "ARCHIVED" });
  });
  expect(await screen.findByText("Project archived.")).toBeInTheDocument();
});

test("Restore Project confirms then PATCHes ACTIVE", async () => {
  fetchProjects.mockResolvedValue([ARCHIVED]);
  updateProject.mockResolvedValue({ ...ARCHIVED, status: "ACTIVE" });
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Restore Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Restore Project?" });
  expect(
    within(dialog).getByText("Restore Legacy and make it active again?")
  ).toBeInTheDocument();
  userEvent.click(within(dialog).getByRole("button", { name: "Restore Project" }));
  await waitFor(() => {
    expect(updateProject).toHaveBeenCalledWith("p2", { status: "ACTIVE" });
  });
  expect(await screen.findByText("Project restored.")).toBeInTheDocument();
});

test("empty project is permanently deleted after confirmation", async () => {
  deleteProject.mockImplementation(async (id) => {
    fetchProjects.mockResolvedValue([]);
    return {
      action: "DELETED",
      projectId: id,
      name: PROJECT.name,
      taskCount: 0,
    };
  });
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Delete Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Project?" });
  expect(
    within(dialog).getByText("Are you sure you want to permanently delete this project?")
  ).toBeInTheDocument();
  userEvent.click(within(dialog).getByRole("button", { name: "Delete Project" }));
  await waitFor(() => {
    expect(deleteProject).toHaveBeenCalledWith(PROJECT.projectId);
  });
  expect(
    await screen.findByText("Project deleted successfully.")
  ).toBeInTheDocument();
});

test("project with tasks is blocked after confirmation", async () => {
  const conflict =
    "This project cannot be permanently deleted because it contains existing tasks or task history. Please archive the project instead.";
  deleteProject.mockRejectedValue(new Error(conflict));
  render(<ManageProjects />);
  expect(await screen.findByText("Portal")).toBeInTheDocument();
  userEvent.click(screen.getByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Delete Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Project?" });
  expect(
    within(dialog).getByText(/cannot be permanently deleted/i)
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(/Archive the project instead/i)
  ).toBeInTheDocument();
  userEvent.click(within(dialog).getByRole("button", { name: "Delete Project" }));
  await waitFor(() => {
    expect(deleteProject).toHaveBeenCalledWith(PROJECT.projectId);
  });
  expect(await screen.findByText(conflict)).toBeInTheDocument();
  expect(
    screen.queryByText("Project archived because it contains existing tasks.")
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Project archived.")).not.toBeInTheDocument();
  expect(updateProject).not.toHaveBeenCalled();
  expect(screen.getByText("Portal")).toBeInTheDocument();
  expect(screen.getByText("Active", { selector: ".dgv-badge" })).toBeInTheDocument();
});

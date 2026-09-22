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
  fetchUsers: jest.fn(),
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManageProjects from "./ManageProjects";
import {
  createProject,
  deleteProject,
  fetchProjects,
  fetchUsers,
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
  fetchUsers.mockReset();
  fetchUsers.mockResolvedValue([
    { email: "rahul@mydgv.com", name: "Rahul", status: "ACTIVE" },
  ]);
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
  expect(screen.getByText("Open", { selector: ".dgv-badge" })).toBeInTheDocument();
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
  expect(
    within(dialog).queryByLabelText(/Type the project name to confirm/i)
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByPlaceholderText("Enter project name")
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByTestId("delete-project-name")
  ).not.toBeInTheDocument();
  userEvent.click(within(dialog).getByRole("button", { name: "Archive Project" }));
  await waitFor(() => {
    expect(updateProject).toHaveBeenCalledWith("p1", { status: "ARCHIVED" });
  });
  expect(deleteProject).not.toHaveBeenCalled();
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

test("empty project is permanently deleted after typing the project name", async () => {
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
  const highlightedName = within(dialog).getByTestId("delete-project-name");
  expect(highlightedName).toBeVisible();
  expect(highlightedName).toHaveClass("dgv-project-delete-confirm__name");
  expect(highlightedName).toHaveTextContent("Portal");
  expect(
    within(dialog).getByText(
      "To confirm permanent deletion, type the following project name:"
    )
  ).toBeVisible();
  expect(
    within(dialog).getByText("Enter the project name exactly as shown above.")
  ).toBeVisible();
  expect(
    within(dialog).getByText(
      "This is a permanent deletion. Portal cannot be restored after it is deleted."
    )
  ).toBeVisible();
  expect(
    within(dialog).getByText(/related tasks and attachments/i)
  ).toBeInTheDocument();
  expect(
    within(dialog).queryByText(/will automatically be archived/i)
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByText(/projects with existing tasks will be archived/i)
  ).not.toBeInTheDocument();
  expect(
    within(dialog).getByText(/Excel Import History/i)
  ).toBeInTheDocument();
  const submit = within(dialog).getByRole("button", { name: "Delete Project" });
  expect(submit).toBeDisabled();
  const nameInput = within(dialog).getByLabelText(
    "Type the project name to confirm"
  );
  expect(nameInput).toBeVisible();
  expect(nameInput).toHaveAttribute("placeholder", "Enter project name");
  expect(nameInput).toHaveValue("");
  expect(
    nameInput.compareDocumentPosition(highlightedName) &
      Node.DOCUMENT_POSITION_PRECEDING
  ).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  userEvent.type(nameInput, "Wrong");
  expect(submit).toBeDisabled();
  userEvent.clear(nameInput);
  expect(submit).toBeDisabled();
  userEvent.type(nameInput, "portal");
  expect(submit).toBeEnabled();
  userEvent.clear(nameInput);
  userEvent.type(nameInput, " Portal ");
  expect(submit).toBeEnabled();
  userEvent.click(submit);
  await waitFor(() => {
    expect(deleteProject).toHaveBeenCalledWith(PROJECT.projectId, " Portal ");
  });
  expect(
    await screen.findByText("Project deleted successfully.")
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Delete Project?" })).not.toBeInTheDocument();
  expect(screen.queryByText("Portal")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Project archived because it contains existing tasks.")
  ).not.toBeInTheDocument();
});

test("Cancel closes delete confirmation without an API request", async () => {
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Delete Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Project?" });
  userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Delete Project?" })).not.toBeInTheDocument();
  expect(deleteProject).not.toHaveBeenCalled();
  expect(updateProject).not.toHaveBeenCalled();
  expect(screen.getByText("Portal")).toBeInTheDocument();
});

test("highlighted delete confirmation name stays wrapped for long project names", async () => {
  const longName =
    "DGV-Employee-Portal-Strategic-Initiative-AlphaBetaGammaDeltaEpsilonZetaEtaTheta";
  fetchProjects.mockResolvedValue([{ ...PROJECT, name: longName }]);
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Delete Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Project?" });
  const highlightedName = within(dialog).getByTestId("delete-project-name");
  expect(highlightedName).toBeVisible();
  expect(highlightedName).toHaveTextContent(longName);
  expect(highlightedName).toHaveClass("dgv-project-delete-confirm__name");
  expect(within(dialog).getByRole("button", { name: "Delete Project" })).toBeDisabled();
});

test("loading state prevents duplicate delete submissions", async () => {
  let resolveDelete;
  deleteProject.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveDelete = resolve;
      })
  );
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Delete Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Project?" });
  userEvent.type(
    within(dialog).getByLabelText("Type the project name to confirm"),
    "Portal"
  );
  const submit = within(dialog).getByRole("button", { name: "Delete Project" });
  userEvent.click(submit);
  expect(await within(dialog).findByRole("button", { name: "Deleting..." })).toBeDisabled();
  userEvent.click(within(dialog).getByRole("button", { name: "Deleting..." }));
  expect(deleteProject).toHaveBeenCalledTimes(1);
  resolveDelete({
    action: "DELETED",
    projectId: PROJECT.projectId,
    name: PROJECT.name,
    taskCount: 0,
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Delete Project?" })).not.toBeInTheDocument();
  });
});

test("failed deletion keeps the confirmation input and shows an error", async () => {
  const conflict = new Error(
    "This project cannot be permanently deleted because it contains existing tasks or task history. Please archive the project instead."
  );
  conflict.status = 409;
  conflict.code = "PROJECT_HAS_TASKS";
  deleteProject.mockRejectedValue(conflict);
  render(<ManageProjects />);
  expect(await screen.findByText("Portal")).toBeInTheDocument();
  userEvent.click(screen.getByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Delete Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Project?" });
  const nameInput = within(dialog).getByLabelText(
    "Type the project name to confirm"
  );
  userEvent.type(nameInput, "Portal");
  userEvent.click(within(dialog).getByRole("button", { name: "Delete Project" }));
  await waitFor(() => {
    expect(deleteProject).toHaveBeenCalledWith(PROJECT.projectId, "Portal");
  });
  expect(await screen.findAllByText(/PROJECT_HAS_TASKS/)).not.toHaveLength(0);
  expect(
    screen.queryByText("Project deleted successfully.")
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Project archived because it contains existing tasks.")
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Project archived.")).not.toBeInTheDocument();
  expect(updateProject).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Delete Project?" })).toBeInTheDocument();
  expect(nameInput).toHaveValue("Portal");
  expect(screen.getByText("Portal", { selector: ".dgv-projects-table__name" })).toBeInTheDocument();
  expect(screen.getByText("Active", { selector: ".dgv-badge" })).toBeInTheDocument();
});

test("S3 cleanup failure shows the backend code and does not remove the project", async () => {
  const failed = new Error("Unable to delete project attachments");
  failed.status = 500;
  failed.code = "PROJECT_DELETE_S3_FAILED";
  deleteProject.mockRejectedValue(failed);
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Delete Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Project?" });
  userEvent.type(
    within(dialog).getByLabelText("Type the project name to confirm"),
    " portal "
  );
  userEvent.click(within(dialog).getByRole("button", { name: "Delete Project" }));
  await waitFor(() => {
    expect(deleteProject).toHaveBeenCalledWith(PROJECT.projectId, " portal ");
  });
  expect(
    await screen.findAllByText(/PROJECT_DELETE_S3_FAILED/)
  ).not.toHaveLength(0);
  expect(
    screen.queryByText("Project deleted successfully.")
  ).not.toBeInTheDocument();
  expect(screen.getByText("Portal", { selector: ".dgv-projects-table__name" })).toBeInTheDocument();
});

test("legacy ARCHIVED delete response is not treated as successful deletion", async () => {
  deleteProject.mockResolvedValue({
    action: "ARCHIVED",
    projectId: PROJECT.projectId,
    name: PROJECT.name,
  });
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Delete Project" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Project?" });
  const nameInput = within(dialog).getByLabelText(
    "Type the project name to confirm"
  );
  userEvent.type(nameInput, "Portal");
  userEvent.click(within(dialog).getByRole("button", { name: "Delete Project" }));
  await waitFor(() => {
    expect(deleteProject).toHaveBeenCalledWith(PROJECT.projectId, "Portal");
  });
  expect(
    await screen.findAllByText(/not permanently deleted/i)
  ).not.toHaveLength(0);
  expect(screen.getByRole("dialog", { name: "Delete Project?" })).toBeInTheDocument();
  expect(nameInput).toHaveValue("Portal");
  expect(updateProject).not.toHaveBeenCalled();
  expect(
    screen.queryByText("Project deleted successfully.")
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Project archived.")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Project archived because it contains existing tasks.")
  ).not.toBeInTheDocument();
  expect(screen.getByText("Portal", { selector: ".dgv-projects-table__name" })).toBeInTheDocument();
  expect(screen.getByText("Active", { selector: ".dgv-badge" })).toBeInTheDocument();
});

test("restricted projects show a Restricted access badge", async () => {
  fetchProjects.mockResolvedValue([{ ...PROJECT, accessMode: "RESTRICTED" }]);
  render(<ManageProjects />);
  expect(await screen.findByText("Restricted", { selector: ".dgv-badge" })).toBeInTheDocument();
  expect(screen.getByText("Active", { selector: ".dgv-badge" })).toBeInTheDocument();
});

test("Open Project does not show Manage Access", async () => {
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  expect(screen.getByRole("menuitem", { name: "Edit Project" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Archive Project" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Delete Project" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Manage Access" })).not.toBeInTheDocument();
});

test("Restricted Project hides Manage Access unless the caller is a Project Admin", async () => {
  fetchProjects.mockResolvedValue([
    { ...PROJECT, accessMode: "RESTRICTED", canManageAccess: false },
  ]);
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  expect(screen.queryByRole("menuitem", { name: "Manage Access" })).not.toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Edit Project" })).toBeInTheDocument();
});

test("Restricted Project shows Manage Access to its Project Admin", async () => {
  fetchProjects.mockResolvedValue([
    { ...PROJECT, accessMode: "RESTRICTED", canManageAccess: true },
  ]);
  updateProject.mockResolvedValue({
    projectId: "p1",
    accessMode: "RESTRICTED",
    members: [
      { email: "rahul@mydgv.com", status: "ACTIVE", active: true },
    ],
    projectAdmins: [
      { email: "admin@mydgv.com", status: "ACTIVE", active: true },
    ],
  });
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Manage Access" }));
  const dialog = await screen.findByRole("dialog", { name: "Manage Access — Portal" });
  await waitFor(() => {
    expect(updateProject).toHaveBeenCalledWith("p1", {
      access: { action: "list", includeRevoked: true },
    });
  });
  expect(within(dialog).getByText(/rahul@mydgv.com/)).toBeInTheDocument();
  expect(within(dialog).getByText(/admin@mydgv.com/)).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
});

test("Manage Access shows 403 from the access API", async () => {
  fetchProjects.mockResolvedValue([
    { ...PROJECT, accessMode: "RESTRICTED", canManageAccess: true },
  ]);
  const denied = new Error("You do not have permission to access this resource.");
  denied.status = 403;
  updateProject.mockRejectedValue(denied);
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Manage Access" }));
  expect(
    await screen.findByText("You do not have permission to access this resource.")
  ).toBeInTheDocument();
  expect(screen.queryByText("Project updated.")).not.toBeInTheDocument();
});

test("Manage Access shows 409 from the access API", async () => {
  fetchProjects.mockResolvedValue([
    { ...PROJECT, accessMode: "RESTRICTED", canManageAccess: true },
  ]);
  const conflict = new Error("Conflict");
  conflict.status = 409;
  updateProject
    .mockResolvedValueOnce({
      projectId: "p1",
      accessMode: "RESTRICTED",
      members: [{ email: "rahul@mydgv.com", status: "ACTIVE", active: true }],
      projectAdmins: [{ email: "admin@mydgv.com", status: "ACTIVE", active: true }],
    })
    .mockRejectedValueOnce(conflict);
  render(<ManageProjects />);
  userEvent.click(await screen.findByRole("button", { name: "Take Action" }));
  userEvent.click(screen.getByRole("menuitem", { name: "Manage Access" }));
  const dialog = await screen.findByRole("dialog", { name: "Manage Access — Portal" });
  userEvent.click(await within(dialog).findByRole("button", { name: "Revoke" }));
  expect(await screen.findByText("Conflict")).toBeInTheDocument();
});

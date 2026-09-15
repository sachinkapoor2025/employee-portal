import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateProjectModal from "./CreateProjectModal";

test("create mode uses New Project copy and Create action", () => {
  render(
    <CreateProjectModal open mode="create" onClose={jest.fn()} onSubmit={jest.fn()} />
  );
  expect(screen.getByRole("dialog", { name: "New Project" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
});

test("edit mode prepopulates fields and saves changes", async () => {
  const onSubmit = jest.fn().mockResolvedValue();
  render(
    <CreateProjectModal
      open
      mode="edit"
      initial={{ name: "Portal", client: "DGV", description: "Work" }}
      onClose={jest.fn()}
      onSubmit={onSubmit}
    />
  );
  expect(screen.getByRole("dialog", { name: "Edit Project" })).toBeInTheDocument();
  expect(screen.getByDisplayValue("Portal")).toBeInTheDocument();
  expect(screen.getByDisplayValue("DGV")).toBeInTheDocument();
  userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => {
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Portal",
      client: "DGV",
      description: "Work",
    });
  });
});

test("edit mode blocks duplicate active names", async () => {
  const onSubmit = jest.fn();
  render(
    <CreateProjectModal
      open
      mode="edit"
      excludeProjectId="p1"
      initial={{ name: "Legacy", client: "", description: "" }}
      existingProjects={[
        { projectId: "p1", name: "Legacy", status: "ARCHIVED" },
        { projectId: "p2", name: "Portal", status: "ACTIVE" },
      ]}
      onClose={jest.fn()}
      onSubmit={onSubmit}
    />
  );
  const name = screen.getAllByRole("textbox")[0];
  userEvent.clear(name);
  userEvent.type(name, "portal");
  userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(
    await screen.findByText("A project with this name already exists.")
  ).toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});

jest.mock("../services/api", () => ({
  fetchUsers: jest.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateProjectModal from "./CreateProjectModal";
import { fetchUsers } from "../services/api";

beforeEach(() => {
  fetchUsers.mockReset();
  fetchUsers.mockResolvedValue([
    { email: "Rahul@MyDGV.com", name: "Rahul", status: "ACTIVE" },
    { email: "blocked@mydgv.com", name: "Blocked", status: "BLOCKED" },
    { email: "ria@mydgv.com", name: "Ria", status: "ACTIVE" },
  ]);
});

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

test("restricted toggle is off by default and open create omits accessMode", async () => {
  const onSubmit = jest.fn().mockResolvedValue();
  render(
    <CreateProjectModal open mode="create" onClose={jest.fn()} onSubmit={onSubmit} />
  );
  const toggle = screen.getByRole("checkbox", { name: "Restricted Project" });
  expect(toggle).not.toBeChecked();
  expect(screen.queryByLabelText("Search employees")).not.toBeInTheDocument();
  userEvent.type(screen.getAllByRole("textbox")[0], "Portal");
  userEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => {
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Portal",
      client: "",
      description: "",
    });
  });
  expect(onSubmit.mock.calls[0][0].accessMode).toBeUndefined();
  expect(fetchUsers).not.toHaveBeenCalled();
});

test("restricted create loads employees, blocks duplicates, and sends members", async () => {
  const onSubmit = jest.fn().mockResolvedValue();
  render(
    <CreateProjectModal open mode="create" onClose={jest.fn()} onSubmit={onSubmit} />
  );
  userEvent.click(screen.getByRole("checkbox", { name: "Restricted Project" }));
  expect(await screen.findByLabelText("Search employees")).toBeInTheDocument();
  expect(await screen.findByText("Rahul")).toBeInTheDocument();
  expect(screen.queryByText("Blocked")).not.toBeInTheDocument();
  userEvent.click(screen.getByRole("checkbox", { name: /Rahul/ }));
  userEvent.click(screen.getByRole("checkbox", { name: /Rahul/ }));
  userEvent.click(screen.getByRole("checkbox", { name: /Rahul/ }));
  userEvent.click(screen.getByRole("checkbox", { name: /Ria/ }));
  expect(screen.getAllByRole("checkbox", { name: /Rahul/ })[0]).toBeChecked();
  userEvent.type(screen.getAllByRole("textbox")[0], "Secret");
  userEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => {
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Secret",
      client: "",
      description: "",
      accessMode: "RESTRICTED",
      members: [{ email: "rahul@mydgv.com" }, { email: "ria@mydgv.com" }],
    });
  });
});

test("restricted create without employees shows a validation error", async () => {
  const onSubmit = jest.fn();
  render(
    <CreateProjectModal open mode="create" onClose={jest.fn()} onSubmit={onSubmit} />
  );
  userEvent.type(screen.getAllByRole("textbox")[0], "Secret");
  userEvent.click(screen.getByRole("checkbox", { name: "Restricted Project" }));
  await screen.findByLabelText("Search employees");
  userEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(
    await screen.findByText("Select at least one employee for a Restricted Project.")
  ).toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("restricted create surfaces API errors instead of success", async () => {
  const onSubmit = jest.fn().mockRejectedValue(new Error("Restricted project creation is not enabled"));
  render(
    <CreateProjectModal open mode="create" onClose={jest.fn()} onSubmit={onSubmit} />
  );
  userEvent.type(screen.getAllByRole("textbox")[0], "Secret");
  userEvent.click(screen.getByRole("checkbox", { name: "Restricted Project" }));
  userEvent.click(await screen.findByRole("checkbox", { name: /Rahul/ }));
  userEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(
    await screen.findByText("Restricted project creation is not enabled")
  ).toBeInTheDocument();
});

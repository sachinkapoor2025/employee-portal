import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ClassifyProjectModal from "./ClassifyProjectModal";

const PROJECT = { projectId: "p1", name: "Portal" };

test("opening classify does not show No updates provided or call onSubmit", () => {
  const onSubmit = jest.fn();
  render(
    <ClassifyProjectModal open project={PROJECT} onClose={jest.fn()} onSubmit={onSubmit} />
  );
  const dialog = screen.getByRole("dialog", { name: "Classify Project" });
  expect(within(dialog).queryByText("No updates provided")).not.toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("save without a type stays local and does not call onSubmit", async () => {
  const onSubmit = jest.fn();
  render(
    <ClassifyProjectModal open project={PROJECT} onClose={jest.fn()} onSubmit={onSubmit} />
  );
  userEvent.click(screen.getByRole("button", { name: "Save classification" }));
  expect(
    await screen.findByText("Project type is required.")
  ).toBeInTheDocument();
  expect(screen.queryByText("No updates provided")).not.toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("save with a type submits the selected projectType", async () => {
  const onSubmit = jest.fn().mockResolvedValue();
  render(
    <ClassifyProjectModal open project={PROJECT} onClose={jest.fn()} onSubmit={onSubmit} />
  );
  userEvent.selectOptions(screen.getByLabelText("Project type"), "INTERNAL");
  userEvent.click(screen.getByRole("button", { name: "Save classification" }));
  await waitFor(() => {
    expect(onSubmit).toHaveBeenCalledWith({ projectType: "INTERNAL" });
  });
});

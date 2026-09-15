import { useEffect, useState } from "react";
import Modal, { confirmDiscardIfDirty } from "./ui/Modal";
import { formInput, formLabel } from "../theme";

const EMPTY_FORM = { name: "", client: "", description: "" };

function namesMatch(a, b) {
  return (
    String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase()
  );
}

function isActiveListedProject(project) {
  return String(project?.status || "ACTIVE").toUpperCase() !== "ARCHIVED";
}

function Field({ label, value, onChange, error }) {
  return (
    <div>
      <label style={formLabel}>{label}</label>
      <input
        style={{
          ...formInput,
          border: error ? "1px solid var(--dgv-danger)" : formInput.border,
        }}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <div
          style={{
            color: "var(--dgv-danger)",
            fontSize: 12,
            marginTop: -10,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

export default function CreateProjectModal({
  open = false,
  mode = "create",
  initial = EMPTY_FORM,
  existingProjects = [],
  excludeProjectId = "",
  saving = false,
  onClose,
  onSubmit,
  onExisting,
}) {
  const isEdit = mode === "edit";
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setForm({
      name: initial?.name || "",
      client: initial?.client || "",
      description: initial?.description || "",
    });
    setError("");
  }, [open, initial?.name, initial?.client, initial?.description]);

  const dirty = Boolean(
    String(form.name || "").trim() !== String(initial?.name || "").trim() ||
      String(form.client || "") !== String(initial?.client || "") ||
      String(form.description || "") !== String(initial?.description || "")
  );

  const close = () => {
    if (saving) return;
    onClose?.();
  };

  const save = async () => {
    if (saving) return;
    const name = String(form.name || "").trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    const duplicate = (existingProjects || []).find(
      (p) =>
        p?.projectId !== excludeProjectId &&
        isActiveListedProject(p) &&
        namesMatch(p?.name, name)
    );
    if (duplicate && !(isEdit && namesMatch(initial?.name, name))) {
      if (!isEdit && onExisting) {
        onExisting(duplicate);
        return;
      }
      setError("A project with this name already exists.");
      return;
    }
    setError("");
    try {
      await onSubmit?.({
        name,
        client: String(form.client || ""),
        description: String(form.description || ""),
      });
    } catch (err) {
      setError(err?.message || "Unable to save project.");
    }
  };

  return (
    <Modal
      open={open}
      title={isEdit ? "Edit Project" : "New Project"}
      dirty={dirty}
      closeDisabled={saving}
      onClose={close}
      footer={
        <>
          <button
            type="button"
            className="dgv-btn dgv-btn--outline"
            disabled={saving}
            onClick={() => {
              if (saving) return;
              if (!confirmDiscardIfDirty(dirty)) return;
              close();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="dgv-btn dgv-btn--primary"
            onClick={save}
            disabled={saving}
          >
            {saving
              ? isEdit
                ? "Saving..."
                : "Creating..."
              : isEdit
                ? "Save Changes"
                : "Create"}
          </button>
        </>
      }
    >
      {error ? (
        <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
      <Field
        label="Name"
        value={form.name}
        onChange={(v) => setForm({ ...form, name: v })}
      />
      <Field
        label="Client"
        value={form.client}
        onChange={(v) => setForm({ ...form, client: v })}
      />
      <Field
        label="Description"
        value={form.description}
        onChange={(v) => setForm({ ...form, description: v })}
      />
    </Modal>
  );
}

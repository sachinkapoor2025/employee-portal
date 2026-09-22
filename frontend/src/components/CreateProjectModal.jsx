import { useEffect, useState } from "react";
import Modal, { confirmDiscardIfDirty } from "./ui/Modal";
import ProjectMemberPicker from "./ProjectMemberPicker";
import { fetchUsers } from "../services/api";
import { formInput, formLabel } from "../theme";
import { buildCreateProjectPayload } from "../utils/workProjectManage";

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
  const [restricted, setRestricted] = useState(false);
  const [memberEmails, setMemberEmails] = useState([]);
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setForm({
      name: initial?.name || "",
      client: initial?.client || "",
      description: initial?.description || "",
    });
    setRestricted(false);
    setMemberEmails([]);
    setUsersError("");
    setError("");
  }, [open, initial?.name, initial?.client, initial?.description]);

  useEffect(() => {
    if (!open || isEdit || !restricted) return undefined;
    let cancelled = false;
    setUsersLoading(true);
    setUsersError("");
    fetchUsers()
      .then((list) => {
        if (cancelled) return;
        setUsers(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setUsers([]);
        setUsersError(err?.message || "Unable to load employees.");
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isEdit, restricted]);

  const dirty = Boolean(
    String(form.name || "").trim() !== String(initial?.name || "").trim() ||
      String(form.client || "") !== String(initial?.client || "") ||
      String(form.description || "") !== String(initial?.description || "") ||
      (!isEdit && (restricted || memberEmails.length > 0))
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
    if (!isEdit && restricted && memberEmails.length < 1) {
      setError("Select at least one employee for a Restricted Project.");
      return;
    }
    setError("");
    try {
      const payload = isEdit
        ? {
            name,
            client: String(form.client || ""),
            description: String(form.description || ""),
          }
        : buildCreateProjectPayload({
            name,
            client: form.client,
            description: form.description,
            restricted,
            memberEmails,
          });
      await onSubmit?.(payload);
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
      {!isEdit ? (
        <>
          <label
            style={{
              ...formLabel,
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: restricted ? 12 : 0,
            }}
          >
            <input
              type="checkbox"
              checked={restricted}
              disabled={saving}
              onChange={(e) => {
                const on = e.target.checked;
                setRestricted(on);
                if (!on) setMemberEmails([]);
              }}
            />
            Restricted Project
          </label>
          {restricted ? (
            <ProjectMemberPicker
              users={users}
              loading={usersLoading}
              loadError={usersError}
              selectedEmails={memberEmails}
              disabled={saving}
              onChange={setMemberEmails}
            />
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

import { useEffect, useState } from "react";
import Modal from "./ui/Modal";
import { formInput, formLabel, formSelect } from "../theme";
import { generateProjectCode } from "../utils/workProjectManage";

export default function ClassifyProjectModal({
  open = false,
  project = null,
  saving = false,
  onClose,
  onSubmit,
}) {
  const [projectType, setProjectType] = useState("");
  const [projectCode, setProjectCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setError("");
      return;
    }
    setProjectType("");
    setProjectCode("");
    setCodeTouched(false);
    setError("");
  }, [open, project?.projectId]);

  const generated = generateProjectCode(projectType, project?.name);
  const preview = codeTouched ? projectCode : generated;

  const close = () => {
    if (saving) return;
    onClose?.();
  };

  const save = async () => {
    if (saving) return;
    if (!projectType) {
      setError("Project type is required.");
      return;
    }
    setError("");
    try {
      const payload = { projectType };
      if (codeTouched) payload.projectCode = String(projectCode || "").trim();
      await onSubmit?.(payload);
    } catch (err) {
      setError(err?.message || "Unable to classify project.");
    }
  };

  return (
    <Modal
      open={open}
      title="Classify Project"
      closeDisabled={saving}
      onClose={close}
      footer={
        <>
          <button
            type="button"
            className="dgv-btn dgv-btn--outline"
            disabled={saving}
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="button"
            className="dgv-btn dgv-btn--primary"
            disabled={saving}
            onClick={save}
          >
            {saving ? "Saving..." : "Save classification"}
          </button>
        </>
      }
    >
      {error ? (
        <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
      <p style={{ margin: "0 0 12px", color: "var(--dgv-text-muted)" }}>
        {project?.name
          ? `Choose a type for ${project.name}. You can correct the generated code before saving.`
          : "Choose a project type and confirm the generated code."}
      </p>
      <div>
        <label style={formLabel} htmlFor="classify-project-type">
          Project type
        </label>
        <select
          id="classify-project-type"
          style={formSelect}
          value={projectType}
          disabled={saving}
          onChange={(e) => {
            setProjectType(e.target.value);
            setCodeTouched(false);
          }}
        >
          <option value="">Select type</option>
          <option value="INTERNAL">Internal</option>
          <option value="EXTERNAL">External</option>
        </select>
      </div>
      <div>
        <label style={formLabel} htmlFor="classify-project-code">
          Project code
        </label>
        <input
          id="classify-project-code"
          style={formInput}
          type="text"
          value={preview}
          disabled={saving || !projectType}
          onChange={(e) => {
            setCodeTouched(true);
            setProjectCode(e.target.value);
          }}
        />
      </div>
    </Modal>
  );
}

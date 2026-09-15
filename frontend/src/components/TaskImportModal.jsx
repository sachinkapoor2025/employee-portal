import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import Modal from "./ui/Modal";
import TaskImportPreviewPanel from "./TaskImportPreviewPanel";
import {
  confirmTaskImport,
  getTaskImportUploadUrl,
  previewTaskImport,
} from "../services/api";
import { colors, formLabel } from "../theme";
import {
  formatFileSize,
  reportedContentType,
  validateTaskImportFile,
} from "../utils/taskImportFile";
import {
  canConfirmPreview,
  summarizeConfirmResult,
  userFacingImportError,
} from "../utils/taskImportPreview";
import { downloadTaskImportTemplate } from "../utils/taskImportTemplate";

export default function TaskImportModal({ open, onClose, onImported }) {
  const inputRef = useRef(null);
  const confirmLockRef = useRef(false);
  const [file, setFile] = useState(null);
  const [inputKey, setInputKey] = useState(0);
  const [step, setStep] = useState("idle");
  const [error, setError] = useState("");
  const [batchId, setBatchId] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);

  const confirming = step === "confirming";
  const done = step === "done";
  const busy = step === "uploading" || step === "previewing" || confirming;
  const showPreview = (step === "preview" || confirming) && preview;
  const readyToConfirm = canConfirmPreview(preview);
  const summary = summarizeConfirmResult(result);

  const resetForm = () => {
    setFile(null);
    setError("");
    setBatchId("");
    setFileName("");
    setPreview(null);
    setResult(null);
    setStep("idle");
    confirmLockRef.current = false;
    setInputKey((k) => k + 1);
  };

  useEffect(() => {
    if (open) return;
    resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chooseFile = (next) => {
    setError("");
    setPreview(null);
    setResult(null);
    setBatchId("");
    if (!next) {
      setFile(null);
      setFileName("");
      return;
    }
    const invalid = validateTaskImportFile(next);
    if (invalid) {
      setFile(null);
      setFileName("");
      setError(invalid);
      setInputKey((k) => k + 1);
      return;
    }
    setFile(next);
    setFileName(next.name);
  };

  const close = () => {
    if (busy) return;
    onClose?.();
  };

  const runPreview = async (id) => {
    setStep("previewing");
    const next = await previewTaskImport(id);
    if (!next || typeof next !== "object") {
      throw new Error("Preview failed. Please try again.");
    }
    setPreview(next);
    setStep("preview");
  };

  const upload = async () => {
    const invalid = validateTaskImportFile(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    setStep("uploading");
    setError("");
    setPreview(null);
    setResult(null);
    setBatchId("");
    try {
      const contentType = reportedContentType(file);
      const session = await getTaskImportUploadUrl({
        fileName: file.name,
        contentType,
        fileSize: file.size,
      });
      if (!session?.uploadUrl || !session?.batchId) {
        throw new Error("Upload URL was not returned. Please try again.");
      }
      const headers = {};
      if (contentType) headers["Content-Type"] = contentType;
      const putRes = await fetch(session.uploadUrl, {
        method: "PUT",
        headers,
        body: file,
      });
      if (!putRes.ok) {
        throw new Error("File upload failed. Please try again.");
      }
      setBatchId(session.batchId);
      setFileName(file.name);
      setStep("previewing");
      try {
        await runPreview(session.batchId);
      } catch (previewErr) {
        setError(userFacingImportError(previewErr, "preview"));
        setPreview(null);
        setStep("idle");
      }
    } catch (err) {
      setError(userFacingImportError(err, "upload"));
      setPreview(null);
      setStep("idle");
    }
  };

  const retryPreview = async () => {
    if (!batchId) return;
    setError("");
    try {
      await runPreview(batchId);
    } catch (err) {
      setError(userFacingImportError(err, "preview"));
      setStep("idle");
    }
  };

  const confirm = async () => {
    if (!batchId || !readyToConfirm || confirming || confirmLockRef.current) return;
    confirmLockRef.current = true;
    setError("");
    setStep("confirming");
    try {
      const next = await confirmTaskImport(batchId);
      if (!next || typeof next !== "object") {
        throw new Error("Import failed. Please try again.");
      }
      const status = String(next.status || "").toUpperCase();
      if (status === "PROCESSING") {
        setError("This import is already being processed.");
        setStep("preview");
        confirmLockRef.current = false;
        return;
      }
      setResult(next);
      setStep("done");
      if (status === "COMPLETED" || Number(next.successCount || 0) > 0) {
        onImported?.(next);
      }
    } catch (err) {
      if (/not ready to confirm/i.test(String(err?.message || ""))) {
        setPreview((prev) => (prev ? { ...prev, status: "NEEDS_FIX" } : prev));
      }
      setError(userFacingImportError(err, "confirm"));
      setStep("preview");
      confirmLockRef.current = false;
    }
  };

  const importCount = Number(preview?.totalRows || 0);
  const footer = done ? (
    <button type="button" className="dgv-btn dgv-btn--outline" onClick={close}>
      Close
    </button>
  ) : showPreview ? (
    <>
      <button
        type="button"
        className="dgv-btn dgv-btn--outline"
        disabled={busy}
        onClick={close}
      >
        Close
      </button>
      {readyToConfirm ? (
        <button
          type="button"
          className="dgv-btn dgv-btn--primary"
          disabled={busy}
          onClick={confirm}
        >
          {confirming
            ? `Importing ${importCount} ${importCount === 1 ? "task" : "tasks"}...`
            : "Confirm Import"}
        </button>
      ) : (
        <button
          type="button"
          className="dgv-btn dgv-btn--secondary"
          disabled={busy}
          onClick={resetForm}
        >
          Upload Corrected File
        </button>
      )}
    </>
  ) : (
    <>
      <button
        type="button"
        className="dgv-btn dgv-btn--outline"
        disabled={busy}
        onClick={close}
      >
        Cancel
      </button>
      {batchId && !preview ? (
        <button
          type="button"
          className="dgv-btn dgv-btn--secondary"
          disabled={busy}
          onClick={retryPreview}
        >
          Retry Preview
        </button>
      ) : null}
      <button
        type="button"
        className="dgv-btn dgv-btn--primary"
        disabled={busy || !file}
        onClick={upload}
      >
        {step === "uploading"
          ? "Uploading..."
          : step === "previewing"
            ? "Validating..."
            : "Upload"}
      </button>
    </>
  );

  return (
    <Modal
      open={open}
      title="Import Tasks"
      maxWidth={showPreview || done ? 720 : 520}
      dirty={!!file && !showPreview && !done}
      closeDisabled={busy}
      onClose={close}
      footer={footer}
    >
      <p style={{ margin: "0 0 16px", color: colors.textSecondary, fontSize: 14, lineHeight: 1.5 }}>
        Upload an Excel workbook to start a task import batch. Only .xlsx files up to 5 MB are accepted.
      </p>

      <div style={{ marginBottom: 16 }}>
        <button
          type="button"
          className="dgv-btn dgv-btn--secondary"
          disabled={busy}
          onClick={downloadTaskImportTemplate}
        >
          Download Excel Template
        </button>
      </div>

      {error ? (
        <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 12 }} role="alert">
          {error}
        </div>
      ) : null}

      {busy ? (
        <div className="dgv-alert dgv-alert--info" role="status" aria-live="polite">
          {step === "uploading"
            ? "Uploading your Excel file..."
            : step === "previewing"
              ? "Validating rows..."
              : `Importing ${importCount} ${importCount === 1 ? "task" : "tasks"}...`}
        </div>
      ) : null}

      {done ? (
        <div className="dgv-alert dgv-alert--success" role="status">
          {summary.status === "COMPLETED"
            ? "Import completed successfully."
            : "Import finished with errors."}
          <div style={{ marginTop: 8, fontWeight: 500 }}>
            <div>Total tasks imported: {summary.total}</div>
            <div>Immediate tasks assigned: {summary.immediate}</div>
            <div>Scheduled tasks created: {summary.scheduled}</div>
          </div>
        </div>
      ) : null}

      {showPreview ? (
        <TaskImportPreviewPanel
          preview={preview}
          fileName={fileName}
          batchId={batchId}
        />
      ) : done ? null : (
        <>
          <label style={formLabel}>Excel file</label>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              marginBottom: 12,
            }}
          >
            <button
              type="button"
              className="dgv-btn dgv-btn--secondary"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              Choose file
            </button>
            <input
              key={inputKey}
              ref={inputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              aria-label="Choose Excel file"
              disabled={busy}
              onChange={(e) => chooseFile(e.target.files?.[0] || null)}
            />
            <span style={{ fontSize: 13, color: colors.textMuted }}>
              {file ? file.name : "No file selected"}
            </span>
          </div>

          {file ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 14px",
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                background: "var(--dgv-surface, var(--dgv-card))",
              }}
            >
              <FileSpreadsheet size={20} color="var(--dgv-text-muted)" />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, wordBreak: "break-word" }}>{file.name}</div>
                <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                  {formatFileSize(file.size)}
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  );
}

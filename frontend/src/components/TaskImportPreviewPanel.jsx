import { colors } from "../theme";
import {
  collectPreviewWarnings,
  invalidPreviewRows,
  isPreviewReady,
  rowCellErrors,
  validPreviewRows,
  workbookErrors,
} from "../utils/taskImportPreview";

function Stat({ label, value, tone }) {
  const color =
    tone === "success"
      ? "var(--dgv-success)"
      : tone === "danger"
        ? "var(--dgv-danger)"
        : tone === "warning"
          ? "var(--dgv-warning, #b45309)"
          : colors.text;
  return (
    <div
      style={{
        flex: "1 1 110px",
        minWidth: 110,
        padding: "12px 14px",
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        background: "var(--dgv-surface, var(--dgv-card))",
      }}
    >
      <div style={{ fontSize: 12, color: colors.textMuted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color }}>{value}</div>
    </div>
  );
}

function MetaLine({ label, value }) {
  return (
    <div style={{ marginBottom: 6, fontSize: 13, lineHeight: 1.45 }}>
      <span style={{ color: colors.textMuted, fontWeight: 600 }}>{label}: </span>
      <span style={{ fontWeight: 600, wordBreak: "break-all" }}>{value || "—"}</span>
    </div>
  );
}

export default function TaskImportPreviewPanel({
  preview,
  fileName,
  batchId,
}) {
  const ready = isPreviewReady(preview);
  const invalidRows = invalidPreviewRows(preview);
  const validRows = validPreviewRows(preview);
  const warnings = collectPreviewWarnings(preview);
  const bookErrors = workbookErrors(preview);
  const total = Number(preview?.totalRows || 0);
  const validCount = Number(preview?.validRows ?? validRows.length);
  const invalidCount = Number(preview?.invalidRows ?? invalidRows.length);
  const warningCount = Number(preview?.warningCount ?? warnings.length);

  return (
    <div>
      <h4 style={{ margin: "0 0 10px", fontSize: 16 }}>Task Import Preview</h4>
      <MetaLine label="File" value={fileName} />
      <MetaLine label="Batch ID" value={batchId} />

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          margin: "14px 0 16px",
        }}
      >
        <Stat label="Total Rows" value={total} />
        <Stat label="Valid" value={validCount} tone="success" />
        <Stat label="Invalid" value={invalidCount} tone="danger" />
        <Stat label="Warnings" value={warningCount} tone="warning" />
      </div>

      {ready ? (
        <div className="dgv-alert dgv-alert--success" role="status">
          Ready to Import
          <div style={{ marginTop: 6, fontWeight: 500 }}>
            {validCount} {validCount === 1 ? "task is" : "tasks are"} ready to be imported.
          </div>
        </div>
      ) : (
        <div className="dgv-alert dgv-alert--error" role="alert">
          Needs Fix
          <div style={{ marginTop: 6, fontWeight: 500 }}>
            Please fix the errors in your Excel file and upload it again.
          </div>
        </div>
      )}

      {bookErrors.length ? (
        <div className="dgv-alert dgv-alert--error" role="alert">
          {bookErrors.map((message) => (
            <div key={message} style={{ marginTop: 4, fontWeight: 500 }}>
              {message}
            </div>
          ))}
        </div>
      ) : null}

      {warnings.length ? (
        <section style={{ marginBottom: 16 }} aria-label="Warnings">
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            Warnings ({warnings.length})
          </div>
          <div
            className="dgv-alert dgv-alert--info"
            style={{ marginBottom: 0 }}
            role="status"
          >
            {warnings.map((item, index) => (
              <div key={`${item.cell}-${index}`} style={{ marginTop: index ? 10 : 0, fontWeight: 500 }}>
                <div>
                  {item.cell} — {item.column}
                </div>
                <div>{item.message}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {invalidRows.length ? (
        <section style={{ marginBottom: 16 }} aria-label="Invalid rows">
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            Invalid rows ({invalidRows.length})
          </div>
          <div style={{ maxHeight: 280, overflow: "auto", display: "grid", gap: 10 }}>
            {invalidRows.map((row) => (
              <div
                key={row.rowNumber}
                style={{
                  border: `1px solid ${colors.border}`,
                  borderRadius: 10,
                  padding: "12px 14px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                  <strong>Excel Row {row.rowNumber}</strong>
                  <span className="dgv-badge dgv-badge--danger">Invalid</span>
                </div>
                {rowCellErrors(row).map((item, index) => (
                  <div key={`${item.cell}-${index}`} style={{ marginTop: 8, fontSize: 13, lineHeight: 1.45 }}>
                    <div style={{ fontWeight: 700 }}>
                      {item.cell} — {item.column}
                    </div>
                    <div>Value: {item.value || "—"}</div>
                    <div>Error: {item.message}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {validRows.length ? (
        <section aria-label="Valid rows">
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            Valid rows ({validRows.length})
          </div>
          <div
            style={{
              maxHeight: 160,
              overflow: "auto",
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
              padding: "8px 12px",
              fontSize: 13,
            }}
          >
            {validRows.map((row) => (
              <div
                key={row.rowNumber}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "6px 0",
                }}
              >
                <span>
                  Excel Row {row.rowNumber}
                  {row.values?.taskTitle ? ` — ${row.values.taskTitle}` : ""}
                </span>
                <span className="dgv-badge dgv-badge--success">Valid</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

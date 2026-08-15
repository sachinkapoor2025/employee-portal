import { useEffect, useState } from "react";

export default function DocumentPreview({ preview, onClose }) {
  const { url, fileName, kind, loading, error } = preview || {};
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (!preview) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(15,23,42,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "92vw",
          maxHeight: "92vh",
          background: "var(--dgv-card)",
          color: "var(--dgv-text)",
          borderRadius: 14,
          padding: 14,
          boxShadow: "var(--dgv-shadow-lg)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginBottom: 10,
          }}
        >
          <button
            type="button"
            className="dgv-btn dgv-btn--outline"
            style={{ padding: "4px 10px", fontSize: 13 }}
            onClick={onClose}
          >
            Close
          </button>
        </div>
        {loading ? (
          <p style={{ padding: "28px 12px", textAlign: "center", minWidth: 240 }}>
            Opening document…
          </p>
        ) : error || failed ? (
          <p style={{ padding: "28px 12px", textAlign: "center", minWidth: 240 }}>
            {error || "Unable to load this document. Please try again."}
          </p>
        ) : kind === "image" ? (
          <img
            src={url}
            alt=""
            onError={() => setFailed(true)}
            style={{
              display: "block",
              maxWidth: "88vw",
              maxHeight: "78vh",
              objectFit: "contain",
            }}
          />
        ) : kind === "pdf" ? (
          <iframe
            title={fileName || "document"}
            src={url}
            style={{ width: "88vw", height: "78vh", border: "none" }}
          />
        ) : (
          <a href={url} className="dgv-btn dgv-btn--primary">
            Download {fileName}
          </a>
        )}
      </div>
    </div>
  );
}

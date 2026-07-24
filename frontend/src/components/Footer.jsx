import { colors, companyDetails } from "../theme";

export default function Footer() {
  return (
    <footer
      style={{
        width: "100%",
        padding: "16px 20px 24px",
        background: "transparent",
        textAlign: "center",
        fontSize: 13,
        color: colors.text,
        lineHeight: 1.6,
      }}
    >
      <div
        style={{
          fontWeight: 700,
          color: colors.primary,
          marginBottom: 6,
          textShadow: "0 1px 4px rgba(255,255,255,0.95)",
        }}
      >
        Divit Global Ventures (DGV)
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "6px 20px",
          textShadow: "0 1px 4px rgba(255,255,255,0.95)",
        }}
      >
        <span>
          Website:{" "}
          <a
            href={`https://${companyDetails.website}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: colors.primary, textDecoration: "none", fontWeight: 600 }}
          >
            {companyDetails.website}
          </a>
        </span>
        <span>Phone: {companyDetails.phone}</span>
        <span>GST Number: {companyDetails.gst}</span>
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 12,
          color: colors.textMuted,
          textShadow: "0 1px 4px rgba(255,255,255,0.95)",
        }}
      >
        © 2025 DGV Portal. All rights reserved.
      </div>
    </footer>
  );
}

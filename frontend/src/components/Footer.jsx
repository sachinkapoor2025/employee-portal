import { colors, companyDetails } from "../theme";

export default function Footer() {
  return (
    <footer
      style={{
        marginTop: 32,
        padding: "20px 24px",
        background: "transparent",
        textAlign: "center",
        fontSize: 14,
        color: colors.textMuted,
        textShadow: "0 1px 3px rgba(255,255,255,0.9)",
      }}
    >
      <div style={{ fontWeight: 700, color: colors.primary, marginBottom: 8 }}>
        Divit Global Ventures (DGV)
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "8px 24px" }}>
        <span>
          Website:{" "}
          <a
            href={`https://${companyDetails.website}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: colors.primary, textDecoration: "none" }}
          >
            {companyDetails.website}
          </a>
        </span>
        <span>Phone: {companyDetails.phone}</span>
        <span>GST Number: {companyDetails.gst}</span>
      </div>
      <div style={{ marginTop: 8, fontSize: 12 }}>
        © 2025 DGV Portal. All rights reserved.
      </div>
    </footer>
  );
}

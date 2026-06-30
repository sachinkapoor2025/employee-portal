import { colors, companyDetails } from "../theme";

export default function Footer() {
  return (
    <footer
      style={{
        marginTop: 32,
        padding: "20px 24px",
        background: "rgba(255,255,255,0.95)",
        borderRadius: 12,
        boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
        textAlign: "center",
        fontSize: 14,
        color: colors.textMuted,
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
        © {new Date().getFullYear()} DGV Portal. All rights reserved.
      </div>
    </footer>
  );
}

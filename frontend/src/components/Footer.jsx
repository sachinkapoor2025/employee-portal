import { companyDetails } from "../theme";

export default function Footer() {
  return (
    <footer className="dgv-footer">
      <div className="dgv-footer__brand">Divit Global Ventures (DGV)</div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "6px 20px",
        }}
      >
        <span>
          Website:{" "}
          <a
            href={`https://${companyDetails.website}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--dgv-accent)", textDecoration: "none", fontWeight: 600 }}
          >
            {companyDetails.website}
          </a>
        </span>
        <span>Phone: {companyDetails.phone}</span>
        <span>GST Number: {companyDetails.gst}</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 12 }}>
        © {new Date().getFullYear()} DGV Portal. All rights reserved.
      </div>
    </footer>
  );
}

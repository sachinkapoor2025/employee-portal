// DGV Portal — design tokens bridged to CSS variables
// Keeps existing page imports working while supporting light/dark themes.

export const colors = {
  primary: "var(--dgv-accent)",
  primaryDark: "var(--dgv-accent-hover)",
  primaryLight: "var(--dgv-accent-soft)",
  white: "#ffffff",
  text: "var(--dgv-text)",
  textMuted: "var(--dgv-text-muted)",
  textSecondary: "var(--dgv-text-secondary)",
  error: "var(--dgv-danger)",
  success: "var(--dgv-success)",
  successBg: "var(--dgv-success-bg)",
  border: "var(--dgv-border)",
  background: "var(--dgv-bg)",
  card: "var(--dgv-card)",
};

export const buttonPrimary = {
  backgroundColor: "var(--dgv-accent)",
  color: "#ffffff",
  border: "none",
  borderRadius: 10,
  padding: "10px 18px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "0 6px 16px rgba(37, 99, 235, 0.22)",
  transition: "transform 0.3s ease, background-color 0.3s ease, box-shadow 0.3s ease",
};

export const navButton = {
  display: "inline-block",
  margin: "0 5px",
  backgroundColor: "var(--dgv-accent)",
  color: "#ffffff",
  border: "none",
  padding: "10px 15px",
  borderRadius: 10,
  fontSize: 14,
  cursor: "pointer",
  transition: "opacity 0.3s ease, transform 0.3s ease",
};

export const pageCard = {
  background: "var(--dgv-surface)",
  backdropFilter: "blur(20px) saturate(1.25)",
  WebkitBackdropFilter: "blur(20px) saturate(1.25)",
  padding: "28px 32px",
  borderRadius: 20,
  boxShadow: "var(--dgv-shadow)",
  border: "1px solid var(--dgv-border)",
  maxWidth: 960,
  margin: "0 auto",
  color: "var(--dgv-text)",
  transition:
    "background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease",
};

export const formLabel = {
  display: "block",
  fontWeight: 600,
  fontSize: 13,
  color: "var(--dgv-text)",
  marginBottom: 6,
};

export const formInput = {
  width: "100%",
  padding: "11px 14px",
  borderRadius: 10,
  border: "1px solid var(--dgv-border-strong)",
  fontSize: 14,
  boxSizing: "border-box",
  marginBottom: 16,
  background: "var(--dgv-surface-solid)",
  color: "var(--dgv-text)",
};

export const formSelect = {
  ...formInput,
  cursor: "pointer",
};

export const formGroup = {
  marginBottom: 4,
};

export const pageTitle = {
  margin: "0 0 8px",
  fontSize: 26,
  fontWeight: 800,
  letterSpacing: "-0.03em",
  color: "var(--dgv-text)",
};

export const pageSubtitle = {
  margin: "0 0 24px",
  color: "var(--dgv-text-muted)",
  fontSize: 14,
  fontWeight: 500,
};

export const alertSuccess = {
  marginTop: 16,
  padding: "12px 16px",
  borderRadius: 10,
  background: "var(--dgv-success-bg)",
  color: "var(--dgv-success)",
  fontWeight: 600,
  fontSize: 14,
};

export const alertError = {
  ...alertSuccess,
  background: "var(--dgv-danger-bg)",
  color: "var(--dgv-danger)",
};

export const companyDetails = {
  website: "www.mydgv.com",
  phone: "+91-9650457697",
  gst: "Contact admin for GST details",
};

// DGV Portal — design tokens bridged to CSS variables
// Keeps existing page imports working while supporting light/dark themes.

export const colors = {
  primary: "var(--dgv-primary)",
  primaryDark: "var(--dgv-primary-hover)",
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
  backgroundColor: "var(--dgv-primary)",
  color: "#ffffff",
  border: "none",
  borderRadius: 8,
  padding: "8px 16px",
  minHeight: 40,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "none",
  transition: "background-color 0.18s ease, color 0.18s ease",
};

export const navButton = {
  display: "inline-block",
  margin: "0 5px",
  backgroundColor: "var(--dgv-primary)",
  color: "#ffffff",
  border: "none",
  padding: "8px 16px",
  borderRadius: 8,
  fontSize: 14,
  cursor: "pointer",
  transition: "opacity 0.18s ease",
};

export const pageCard = {
  background: "var(--dgv-surface)",
  padding: "24px",
  borderRadius: 14,
  boxShadow: "none",
  border: "1px solid var(--dgv-border)",
  maxWidth: "100%",
  margin: "0 auto",
  color: "var(--dgv-text)",
  transition:
    "background-color 0.18s ease, color 0.18s ease, border-color 0.18s ease",
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
  padding: "10px 12px",
  minHeight: 40,
  borderRadius: 8,
  border: "1px solid var(--dgv-border)",
  fontSize: 15,
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
  fontSize: 32,
  fontWeight: 700,
  letterSpacing: "-0.02em",
  fontFamily: "var(--dgv-font-display)",
  color: "var(--dgv-text)",
};

export const pageSubtitle = {
  margin: "0 0 24px",
  color: "var(--dgv-text-muted)",
  fontSize: 15,
  fontWeight: 400,
};

export const alertSuccess = {
  marginTop: 16,
  padding: "12px 16px",
  borderRadius: 8,
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

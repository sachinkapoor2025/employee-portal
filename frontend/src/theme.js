// DGV Portal — unified color scheme & shared UI styles
export const colors = {
  primary: "#1976d2",
  primaryDark: "#1565c0",
  primaryLight: "#e3f2fd",
  white: "#ffffff",
  text: "#333333",
  textMuted: "#666666",
  error: "#d32f2f",
  success: "#2e7d32",
  successBg: "#e8f5e9",
  border: "#e0e0e0",
  background: "#f8fafc",
};

export const buttonPrimary = {
  backgroundColor: colors.primary,
  color: colors.white,
  border: "none",
  borderRadius: 8,
  padding: "10px 20px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

export const navButton = {
  display: "inline-block",
  margin: "0 5px",
  backgroundColor: colors.primary,
  color: colors.white,
  border: "none",
  padding: "10px 15px",
  borderRadius: 8,
  fontSize: 14,
  cursor: "pointer",
};

export const pageCard = {
  background: "rgba(255,255,255,0.97)",
  padding: "28px 32px",
  borderRadius: 16,
  boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
  maxWidth: 960,
  margin: "0 auto",
};

export const formLabel = {
  display: "block",
  fontWeight: 600,
  fontSize: 13,
  color: colors.text,
  marginBottom: 6,
};

export const formInput = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  fontSize: 14,
  boxSizing: "border-box",
  marginBottom: 16,
  background: colors.white,
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
  fontSize: 24,
  fontWeight: 700,
  color: colors.text,
};

export const pageSubtitle = {
  margin: "0 0 24px",
  color: colors.textMuted,
  fontSize: 14,
};

export const alertSuccess = {
  marginTop: 16,
  padding: "12px 16px",
  borderRadius: 8,
  background: colors.successBg,
  color: colors.success,
  fontWeight: 600,
  fontSize: 14,
};

export const alertError = {
  ...alertSuccess,
  background: "#ffebee",
  color: colors.error,
};

export const companyDetails = {
  website: "www.mydgv.com",
  phone: "+91-9650457697",
  gst: "Contact admin for GST details",
};

/**
 * Shared professional HTML email layout.
 * Visual reference: existing Red Zone admin email (zoneNotify.redAdminNotifyCopy).
 * Event copy stays in callers; this module only renders layout.
 */

const EMAIL_VARIANTS = {
  info: {
    headerBg: "#1f2937",
    headerColor: "#fff",
    border: "#e5e7eb",
    headingColor: "#111827",
    ctaBg: "#1f2937",
    ctaColor: "#fff",
    alertBg: "#f3f4f6",
    alertBorder: "#e5e7eb",
    alertColor: "#111827",
  },
  success: {
    headerBg: "#047857",
    headerColor: "#fff",
    border: "#a7f3d0",
    headingColor: "#047857",
    ctaBg: "#047857",
    ctaColor: "#fff",
    alertBg: "#ecfdf5",
    alertBorder: "#a7f3d0",
    alertColor: "#047857",
  },
  warning: {
    headerBg: "#b45309",
    headerColor: "#fff",
    border: "#fde68a",
    headingColor: "#b45309",
    ctaBg: "#b45309",
    ctaColor: "#fff",
    alertBg: "#fffbeb",
    alertBorder: "#fde68a",
    alertColor: "#b45309",
  },
  urgent: {
    headerBg: "#991b1b",
    headerColor: "#fff",
    border: "#fecaca",
    headingColor: "#991b1b",
    ctaBg: "#991b1b",
    ctaColor: "#fff",
    alertBg: "#fef2f2",
    alertBorder: "#fecaca",
    alertColor: "#991b1b",
  },
  alert: {
    headerBg: "#1e3a5f",
    headerColor: "#fff",
    border: "#bfdbfe",
    headingColor: "#1e3a5f",
    ctaBg: "#1e3a5f",
    ctaColor: "#fff",
    alertBg: "#eff6ff",
    alertBorder: "#bfdbfe",
    alertColor: "#1e3a5f",
  },
};

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function optionalText(value) {
  const text = String(value == null ? "" : value).trim();
  return text || "";
}

function resolveVariant(variant) {
  const key = String(variant || "info").toLowerCase();
  return EMAIL_VARIANTS[key] || EMAIL_VARIANTS.info;
}

function htmlRow(label, value) {
  const text = optionalText(value);
  if (!text) return "";
  return `<tr>
      <td style="padding:8px 0;color:#6b7280;vertical-align:top;width:160px">${escapeHtml(label)}</td>
      <td style="padding:8px 0;color:#111827;font-weight:600;white-space:pre-wrap">${escapeHtml(text)}</td>
    </tr>`;
}

function renderRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return "";
      return htmlRow(row.label, row.value);
    })
    .join("");
}

function sectionHeadingStyle(theme, isFirst) {
  const margin = isFirst ? "margin:0 0 12px" : "margin:20px 0 8px";
  return `${margin};font-size:14px;letter-spacing:0.04em;color:${theme.headingColor}`;
}

/**
 * Build email-client-safe HTML (inline styles, nested details table).
 * CTA href may include an authenticated portal path with a task id; ids are
 * not rendered as labeled fields.
 */
function buildProfessionalEmail({
  variant = "info",
  brand,
  title,
  intro,
  sections,
  alert,
  cta,
  footer,
} = {}) {
  const theme = resolveVariant(variant);
  const brandText = optionalText(brand);
  const titleText = optionalText(title);
  const introText = optionalText(intro);
  const footerText = optionalText(footer);
  const list = Array.isArray(sections) ? sections : [];
  const alertBlock = alert && typeof alert === "object" ? alert : null;
  const ctaBlock = cta && typeof cta === "object" ? cta : null;

  let body = "";
  if (introText) {
    body += `<p style="margin:0 0 16px;color:#4b5563;line-height:1.5">${escapeHtml(introText)}</p>`;
  }

  let renderedSections = 0;
  for (const section of list) {
    if (!section || typeof section !== "object") continue;
    const heading = optionalText(section.heading);
    const rowHtml = renderRows(section.rows);
    const sectionBody = optionalText(section.body);
    if (!rowHtml && !sectionBody) continue;
    if (heading) {
      body += `<h2 style="${sectionHeadingStyle(theme, renderedSections === 0)}">${escapeHtml(heading)}</h2>`;
    }
    if (rowHtml) {
      body += `<table style="width:100%;border-collapse:collapse;font-size:14px">${rowHtml}</table>`;
    }
    if (sectionBody) {
      body += `<p style="margin:0 0 16px;color:#4b5563;line-height:1.5">${escapeHtml(sectionBody)}</p>`;
    }
    renderedSections += 1;
  }

  if (alertBlock) {
    const alertHeading = optionalText(alertBlock.heading);
    const alertBody = optionalText(alertBlock.body);
    if (alertHeading || alertBody) {
      body +=
        `<div style="margin:16px 0;padding:12px 16px;background:${theme.alertBg};border:1px solid ${theme.alertBorder};border-radius:6px">`;
      if (alertHeading) {
        body += `<h2 style="margin:0 0 8px;font-size:14px;letter-spacing:0.04em;color:${theme.alertColor}">${escapeHtml(alertHeading)}</h2>`;
      }
      if (alertBody) {
        body += `<p style="margin:0;color:#4b5563;line-height:1.5">${escapeHtml(alertBody)}</p>`;
      }
      body += `</div>`;
    }
  }

  const href = ctaBlock ? optionalText(ctaBlock.href) : "";
  const ctaLabel = ctaBlock ? optionalText(ctaBlock.label) : "";
  if (href && ctaLabel) {
    body +=
      `<p style="margin:0"><a href="${escapeHtml(href)}" style="display:inline-block;background:${theme.ctaBg};color:${theme.ctaColor};text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:700">${escapeHtml(ctaLabel)}</a></p>`;
  }

  if (footerText) {
    body += `<p style="margin:20px 0 0;color:#6b7280;font-size:12px;line-height:1.5">${escapeHtml(footerText)}</p>`;
  }

  const brandHtml = brandText
    ? `<div style="font-size:12px;letter-spacing:0.08em;opacity:0.85;margin:0 0 6px">${escapeHtml(brandText)}</div>`
    : "";

  return (
    `<div style="font-family:Arial,sans-serif;color:#111827;max-width:640px">` +
    `<div style="background:${theme.headerBg};color:${theme.headerColor};padding:16px 20px;border-radius:8px 8px 0 0">` +
    brandHtml +
    `<h1 style="margin:0;font-size:20px">${escapeHtml(titleText)}</h1>` +
    `</div>` +
    `<div style="border:1px solid ${theme.border};border-top:none;padding:20px;border-radius:0 0 8px 8px">` +
    body +
    `</div></div>`
  );
}

module.exports = {
  EMAIL_VARIANTS,
  escapeHtml,
  optionalText,
  buildProfessionalEmail,
};

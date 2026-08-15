import Layout from "../../components/Layout";
import { colors, pageCard, pageTitle, pageSubtitle } from "../../theme";

/** Placeholder for Admin modules scheduled in later phases. */
export default function ComingSoon({ title, phase = "a later phase" }) {
  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>{title}</h2>
        <p style={pageSubtitle}>
          This module is planned for {phase}. Existing Employee Portal and
          working Admin features are unchanged.
        </p>
        <div
          style={{
            marginTop: 16,
            padding: 20,
            borderRadius: 12,
            border: `1px dashed ${colors.border}`,
            color: colors.textMuted,
          }}
        >
          Coming soon — real APIs and data will be wired when this phase is
          implemented.
        </div>
      </div>
    </Layout>
  );
}

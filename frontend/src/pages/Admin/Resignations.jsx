import Layout from "../../components/Layout";
import { pageCard, pageTitle, buttonPrimary, colors } from "../../theme";

export default function Resignations() {
  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Resignations</h2>
        <button
          style={{
            ...buttonPrimary,
            background: "var(--dgv-success)",
            marginRight: 10,
          }}
        >
          Approve
        </button>
        <button
          style={{
            ...buttonPrimary,
            background: "var(--dgv-danger)",
          }}
        >
          Reject
        </button>
        <p style={{ color: colors.textMuted, marginTop: 16 }}>
          Review pending resignation requests here.
        </p>
      </div>
    </Layout>
  );
}

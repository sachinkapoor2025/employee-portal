import Layout from "../components/Layout";
import { pageCard, pageTitle, colors } from "../theme";

export default function Payroll() {
  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Payroll & Documents</h2>
        <ul style={{ color: colors.textSecondary || colors.textMuted, lineHeight: 1.8 }}>
          <li>Jan Payslip</li>
          <li>Feb Payslip</li>
        </ul>
      </div>
    </Layout>
  );
}

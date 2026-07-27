import Layout from "../components/Layout";
import { pageCard, pageTitle, colors } from "../theme";

export default function Expertise() {
  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Skill Expertise</h2>
        <ul style={{ color: colors.textMuted, lineHeight: 1.8 }}>
          <li>Advanced SEO Course</li>
          <li>Google Certification</li>
        </ul>
      </div>
    </Layout>
  );
}

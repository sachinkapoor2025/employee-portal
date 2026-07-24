import Layout from "../components/Layout";

export default function Payroll() {
  return (
    <Layout>
      <div style={{ backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" }}>
        <h2>Payroll & Documents</h2>
        <ul>
          <li>Jan Payslip</li>
          <li>Feb Payslip</li>
        </ul>
      </div>
    </Layout>
  );
}

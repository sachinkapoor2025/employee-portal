import Layout from "../components/Layout";

export default function Profile() {
  return (
    <Layout>
      <div style={{ backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" }}>
        <h2>Profile</h2>
        <input
          type="file"
          style={{ padding: "10px", margin: "10px 0", borderRadius: "4px", border: "1px solid #ccc" }}
        />
        <p>Employee ID: 123</p>
        <p>Designation: SEO Executive</p>
      </div>
    </Layout>
  );
}

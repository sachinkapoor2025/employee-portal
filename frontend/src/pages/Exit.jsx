import Layout from "../components/Layout";

export default function Exit() {
  return (
    <Layout>
      <div style={{ backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" }}>
        <h2>Exit Organization</h2>
        <button style={{ padding: "10px 20px", backgroundColor: "#b71c1c", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Submit Resignation</button>
      </div>
    </Layout>
  );
}

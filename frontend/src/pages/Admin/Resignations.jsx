import Layout from "../../components/Layout";

export default function Resignations() {
  return (
    <Layout>
      <div style={{ backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" }}>
        <h2>Resignations</h2>
        <button style={{ padding: "10px 20px", margin: "0 10px", backgroundColor: "#81c784", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Approve</button>
        <button style={{ padding: "10px 20px", margin: "0 10px", backgroundColor: "#b71c1c", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Reject</button>
      </div>
    </Layout>
  );
}

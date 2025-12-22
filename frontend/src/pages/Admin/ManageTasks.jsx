import Layout from "../../components/Layout";

export default function ManageTasks() {
  return (
    <Layout>
      <div style={{ backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" }}>
        <h2>Manage Tasks</h2>
        <button style={{ padding: "10px 20px", backgroundColor: "#1976d2", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Create Task</button>
      </div>
    </Layout>
  );
}
